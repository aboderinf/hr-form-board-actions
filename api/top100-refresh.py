from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

from src.model import ET
from src.top100_runtime import build_top100_payload

TTL_SECONDS = 34_560_000
LOCK_SECONDS = 600


def env_first(*names: str) -> str:
    for name in names:
        value = str(os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def redis_command(command: list) -> object:
    url = env_first("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL")
    token = env_first("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN")
    if not url or not token:
        raise RuntimeError("Upstash Redis REST environment is missing")
    response = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=command,
        timeout=20,
    )
    payload = response.json()
    if not response.ok or payload.get("error"):
        raise RuntimeError(payload.get("error") or f"Redis HTTP {response.status_code}")
    return payload.get("result")


def top100_key(slate_date: str) -> str:
    return f"mlbhr:top100:{slate_date}"


def current_et_date() -> str:
    return datetime.now(timezone.utc).astimezone(ET).date().isoformat()


def load_existing(slate_date: str) -> dict | None:
    raw = redis_command(["GET", top100_key(slate_date)])
    if not raw:
        return None
    try:
        payload = json.loads(str(raw))
    except json.JSONDecodeError:
        return None
    if payload.get("slate_date") != slate_date or not isinstance(payload.get("players"), list):
        return None
    return payload


def refresh_current_top100() -> tuple[int, dict]:
    slate_date = current_et_date()
    existing = load_existing(slate_date)
    if existing and existing.get("status") in {"ready", "no_players_in_form"}:
        return 200, {
            "status": "reused",
            "slate_date": slate_date,
            "generated_at": existing.get("generated_at"),
            "player_pool_count": int(existing.get("player_pool_count") or 0),
            "scored_player_count": int(existing.get("scored_player_count") or 0),
            "published_count": len(existing.get("players") or []),
            "delivery": existing.get("delivery") or "qstash-vercel-redis",
        }

    lock_key = f"mlbhr:top100-lock:{slate_date}"
    lock = redis_command(["SET", lock_key, datetime.now(timezone.utc).isoformat(), "NX", "EX", LOCK_SECONDS])
    if lock != "OK":
        raced = load_existing(slate_date)
        if raced and raced.get("status") in {"ready", "no_players_in_form"}:
            return 200, {
                "status": "reused_after_race",
                "slate_date": slate_date,
                "generated_at": raced.get("generated_at"),
                "published_count": len(raced.get("players") or []),
            }
        return 202, {"status": "build_in_progress", "slate_date": slate_date}

    try:
        payload = build_top100_payload(datetime.fromisoformat(slate_date).date())
        if payload.get("status") == "player_pool_unavailable":
            return 503, {
                "status": "source_unavailable",
                "slate_date": slate_date,
                "diagnostics": payload.get("diagnostics") or [],
            }

        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        generated_at = str(payload.get("generated_at") or datetime.now(timezone.utc).isoformat())
        score = int(datetime.fromisoformat(generated_at.replace("Z", "+00:00")).timestamp())
        redis_command(["SET", top100_key(slate_date), text, "EX", TTL_SECONDS])
        redis_command(["SET", "mlbhr:top100:latest", text, "EX", TTL_SECONDS])
        redis_command(["ZADD", "mlbhr:top100-history", score, top100_key(slate_date)])
        return 200, {
            "status": "built",
            "slate_date": slate_date,
            "generated_at": payload.get("generated_at"),
            "player_pool_count": int(payload.get("player_pool_count") or 0),
            "scored_player_count": int(payload.get("scored_player_count") or 0),
            "published_count": len(payload.get("players") or []),
            "game_log_failures": next(
                (
                    item
                    for item in payload.get("diagnostics") or []
                    if str(item).startswith("Game logs failed for ")
                ),
                None,
            ),
            "delivery": "qstash-vercel-redis",
        }
    finally:
        try:
            redis_command(["DEL", lock_key])
        except Exception:
            pass


class handler(BaseHTTPRequestHandler):
    def _respond(self) -> None:
        if self.command not in {"GET", "POST"}:
            self.send_response(405)
            self.send_header("Allow", "GET, POST")
            self.end_headers()
            return

        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        requested = str((query.get("date") or [""])[0]).strip()
        today = current_et_date()
        if requested and requested != today:
            status, payload = 400, {
                "status": "invalid_slate",
                "message": "Top 100 refresh is current-slate-only",
                "requested": requested,
                "current_et_date": today,
            }
        else:
            try:
                status, payload = refresh_current_top100()
            except Exception as exc:
                status, payload = 503, {
                    "status": "infrastructure_error",
                    "slate_date": today,
                    "message": str(exc),
                }

        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self._respond()

    def do_POST(self) -> None:
        self._respond()
