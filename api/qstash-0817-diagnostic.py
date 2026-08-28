from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

from src.triples_model_runtime import (
    RedisRest,
    build_and_publish,
    current_et_date,
    read_model_board,
)


TOP100_DESTINATION = "https://hr-form-board-actions.vercel.app/api/top100-refresh"
TOP100_CRON = "5 8,10 * * *"
TRIPLES_MODEL_DESTINATION = "https://hr-form-board-actions.vercel.app/api/triples-model-refresh"
# The duplicate UTC offsets cover EDT and EST. Refreshes are idempotent; later
# deliveries also repair a board if the previous day's Statcast state was late.
TRIPLES_MODEL_CRON = "5 8,9,10,11 * * *"
SCHEDULES = {
    "ensure-top100-schedule": {
        "destination": TOP100_DESTINATION,
        "cron": TOP100_CRON,
        "label": "mlb-top100-daily",
        "cadence": "08:05 and 10:05 UTC daily; second delivery is an idempotent recovery",
    },
    "ensure-triples-model-schedule": {
        "destination": TRIPLES_MODEL_DESTINATION,
        "cron": TRIPLES_MODEL_CRON,
        "label": "mlb-triples-model-daily",
        "cadence": "4:05-6:05 AM ET across daylight and standard time; duplicate-offset deliveries are idempotent",
    },
}


def _env_first(*names: str) -> str:
    for name in names:
        value = str(os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _qstash_candidates() -> list[tuple[str, str]]:
    generic = _env_first("QSTASH_TOKEN")
    rows = [
        (_env_first("QSTASH_URL"), generic),
        (_env_first("US_EAST_1_QSTASH_URL"), _env_first("US_EAST_1_QSTASH_TOKEN", "QSTASH_TOKEN")),
        (_env_first("EU_CENTRAL_1_QSTASH_URL"), _env_first("EU_CENTRAL_1_QSTASH_TOKEN", "QSTASH_TOKEN")),
        ("https://qstash.upstash.io", generic),
        ("https://qstash-us-east-1.upstash.io", generic),
        ("https://qstash-eu-central-1.upstash.io", generic),
    ]
    seen: set[tuple[str, str]] = set()
    candidates: list[tuple[str, str]] = []
    for raw_base, raw_token in rows:
        base, token = raw_base.rstrip("/"), raw_token.strip()
        identity = (base, token[:8])
        if not base or not token or identity in seen:
            continue
        seen.add(identity)
        candidates.append((base, token))
    return candidates


def _request_json(
    url: str,
    *,
    token: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
) -> tuple[int, Any]:
    request_headers = {"Authorization": f"Bearer {token}", **(headers or {})}
    request = Request(url, headers=request_headers, data=body, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read()
    except HTTPError as error:
        status = error.code
        raw = error.read()
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = {}
    return status, payload


def resolve_qstash() -> tuple[str, str, list[dict[str, Any]]]:
    errors: list[str] = []
    for base, token in _qstash_candidates():
        try:
            status, payload = _request_json(f"{base}/v2/schedules", token=token)
            if status < 400 and isinstance(payload, list):
                return base, token, payload
            message = payload.get("error") if isinstance(payload, dict) else None
            errors.append(f"{base}: {message or f'HTTP {status}'}")
        except Exception as error:
            errors.append(f"{base}: {error}")
    raise RuntimeError(f"No working QStash region endpoint: {' | '.join(errors)}")


def _destination(schedule: dict[str, Any]) -> str:
    return str(schedule.get("destination") or schedule.get("url") or "").rstrip("/")


def ensure_schedule(config: dict[str, str]) -> tuple[int, dict[str, Any]]:
    base, token, schedules = resolve_qstash()
    destination = config["destination"]
    cron = config["cron"]
    existing = [row for row in schedules if _destination(row) == destination]
    exact = next((row for row in existing if str(row.get("cron") or "").strip() == cron), None)
    if exact:
        return 200, {
            "status": "already_configured",
            "qstashApiBase": base,
            "scheduleId": exact.get("scheduleId"),
            "cron": exact.get("cron") or cron,
            "destination": destination,
            "isPaused": bool(exact.get("isPaused")),
            "nextScheduleTime": exact.get("nextScheduleTime"),
        }
    if existing:
        return 409, {
            "status": "conflicting_schedule_exists",
            "destination": destination,
            "desiredCron": cron,
            "schedules": [
                {
                    "scheduleId": row.get("scheduleId"),
                    "cron": row.get("cron"),
                    "isPaused": bool(row.get("isPaused")),
                }
                for row in existing
            ],
        }
    status, payload = _request_json(
        f"{base}/v2/schedules/{quote(destination, safe='')}",
        token=token,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Upstash-Cron": cron,
            "Upstash-Retries": "2",
            "Upstash-Timeout": "5m",
            "Upstash-Label": config["label"],
        },
        body=b"{}",
    )
    if status >= 400:
        message = payload.get("error") or payload.get("message") if isinstance(payload, dict) else None
        return 502, {
            "status": "qstash_create_failed",
            "qstashStatus": status,
            "message": message or f"HTTP {status}",
        }
    return 201, {
        "status": "created",
        "qstashApiBase": base,
        "scheduleId": payload.get("scheduleId") if isinstance(payload, dict) else None,
        "cron": cron,
        "destination": destination,
        "cadence": config["cadence"],
    }


def model_summary(result: dict[str, Any]) -> dict[str, Any]:
    board = result.get("board") if isinstance(result.get("board"), dict) else {}
    return {
        "status": result.get("status"),
        "slate_date": board.get("slate_date"),
        "generated_at": board.get("generated_at"),
        "state_as_of": board.get("state_as_of"),
        "player_count": board.get("player_count"),
        "delivery": board.get("delivery"),
        "state_source": result.get("state_source"),
        "sports_game_odds_objects_added": board.get("sports_game_odds_objects_added"),
    }


def _safe_log(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: row.get(key)
        for key in (
            "time",
            "messageId",
            "scheduleId",
            "state",
            "error",
            "responseStatus",
            "responseBody",
            "nextDeliveryTime",
            "url",
            "method",
            "maxRetries",
            "retryDelayExpression",
        )
    }


def diagnostic() -> dict[str, Any]:
    base, token, schedules = resolve_qstash()
    params = urlencode(
        {
            "fromDate": str(int(datetime(2026, 8, 7, 12, 15, tzinfo=timezone.utc).timestamp() * 1000)),
            "toDate": str(int(datetime(2026, 8, 7, 13, 30, tzinfo=timezone.utc).timestamp() * 1000)),
            "count": "100",
        }
    )
    logs_status, logs_payload = _request_json(f"{base}/v2/logs?{params}", token=token)
    store = RedisRest.from_environment()
    keys = {
        "checkpointPresent": "mlbhr:checkpoint:2026-08-07:0817",
        "attemptPresent": "mlbhr:attempt:2026-08-07:0817",
        "failurePresent": "mlbhr:failure:2026-08-07:0817",
        "rawArchivePresent": "mlbhr:raw:2026-08-07:0817",
    }
    redis = {label: bool(store.command(["GET", key])) for label, key in keys.items()}
    raw_logs = logs_payload.get("logs") if isinstance(logs_payload, dict) else []
    logs = [_safe_log(row) for row in (raw_logs or []) if isinstance(row, dict)]
    relevant = [
        row
        for row in logs
        if row.get("scheduleId") == "mlb-hr-checkpoint-0817"
        or row.get("url") == "https://hr-form-board-actions.vercel.app/api/capture-checkpoint"
    ]
    checkpoint_schedule = next(
        (row for row in schedules if row.get("scheduleId") == "mlb-hr-checkpoint-0817"),
        {},
    )
    return {
        "status": "ok" if logs_status < 400 else "error",
        "qstashApiBase": base,
        "schedule": {
            "scheduleId": checkpoint_schedule.get("scheduleId"),
            "cron": checkpoint_schedule.get("cron"),
            "destination": _destination(checkpoint_schedule),
            "method": checkpoint_schedule.get("method"),
            "label": checkpoint_schedule.get("label"),
            "isPaused": bool(checkpoint_schedule.get("isPaused")),
            "lastScheduleTime": checkpoint_schedule.get("lastScheduleTime"),
            "nextScheduleTime": checkpoint_schedule.get("nextScheduleTime"),
        },
        "redis": redis,
        "allLogCount": len(logs),
        "relevantLogCount": len(relevant),
        "relevantLogs": relevant,
        "allLogs": logs,
    }


def _first(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key) or []
    return str(values[0]).strip() if values else ""


class handler(BaseHTTPRequestHandler):
    def _query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def _send(self, status: int, payload: dict[str, Any] | None, *, source: str | None = None) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        if source:
            self.send_header("X-Triples-Model-Source", source)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _refresh_model(self) -> None:
        slate_date = _first(self._query(), "date") or current_et_date()
        try:
            result = build_and_publish(slate_date)
            status = 202 if result.get("status") == "build_in_progress" else 200
            self._send(status, model_summary(result), source="qstash-vercel-redis")
        except ValueError as error:
            self._send(400, {"status": "error", "message": str(error)})
        except Exception as error:
            self._send(503, {"status": "infrastructure_error", "slate_date": slate_date, "message": str(error)})

    def _read_model(self) -> None:
        slate_date = _first(self._query(), "date") or current_et_date()
        try:
            board, source = read_model_board(slate_date)
            if board is None:
                self._send(404, {"status": "not_ready", "slate_date": slate_date})
                return
            self._send(200, board, source=source)
        except ValueError as error:
            self._send(400, {"status": "error", "message": str(error)})
        except Exception as error:
            self._send(503, {"status": "infrastructure_error", "slate_date": slate_date, "message": str(error)})

    def do_GET(self) -> None:
        action = _first(self._query(), "action")
        if action in SCHEDULES:
            try:
                status, payload = ensure_schedule(SCHEDULES[action])
                self._send(status, payload)
            except Exception as error:
                self._send(500, {"status": "error", "message": str(error)})
            return
        if action == "refresh-triples-model":
            self._refresh_model()
            return
        if action == "triples-model-current":
            self._read_model()
            return
        try:
            self._send(200, diagnostic())
        except Exception as error:
            self._send(500, {"status": "error", "message": str(error)})

    def do_POST(self) -> None:
        if _first(self._query(), "action") == "refresh-triples-model":
            self._refresh_model()
            return
        self._send(405, {"status": "error", "message": "Method not allowed"})

    def do_HEAD(self) -> None:
        if _first(self._query(), "action") == "triples-model-current":
            self._read_model()
            return
        self._send(405, None)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.end_headers()
