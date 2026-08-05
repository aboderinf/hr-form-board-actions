#!/usr/bin/env python3
"""Materialize one exact checkpoint from the central MLB HR Edge database.

This consumer never calls an odds provider and never reads a repository mirror.
The only network sources are public, database-backed MLB HR Edge endpoints.
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, time as clock_time, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ET = ZoneInfo("America/New_York")
EDGE_BASE_URL = "https://mlb-hr-edge.feranmi.chatgpt.site"
BOOKS = ("fanduel", "draftkings", "betmgm")
CAPTURE_GRACE = timedelta(minutes=15)
MAX_SOURCE_FINISH_DELAY = timedelta(hours=4)


def fetch_json(url: str) -> dict:
    request = Request(url, headers={"User-Agent": "hr-form-central-db/2.0"})
    with urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.load(response)


def normalize_checkpoint(value: str | None) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 3:
        digits = f"0{digits}"
    return digits


def parse_timestamp(value: object) -> datetime:
    if not value:
        raise ValueError("timestamp is missing")
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must be timezone-aware")
    return parsed


def scheduled_checkpoint(expected_date: str, checkpoint: str) -> datetime:
    digits = normalize_checkpoint(checkpoint)
    if len(digits) != 4:
        raise ValueError(f"invalid checkpoint {checkpoint!r}")
    day = date.fromisoformat(expected_date)
    return datetime.combine(
        day,
        clock_time(int(digits[:2]), int(digits[2:])),
        ET,
    )


def checkpoint_label(payload: dict) -> str:
    explicit = str(payload.get("checkpoint") or "")
    if explicit:
        return normalize_checkpoint(explicit)
    stamp = payload.get("latestIngestAt") or payload.get("generatedAt")
    if stamp:
        return parse_timestamp(stamp).astimezone(ET).strftime("%H%M")
    return ""


def validate(
    payload: dict,
    *,
    expected_date: str | None = None,
    expected_checkpoint: str | None = None,
) -> None:
    if payload.get("source") != "mlb-hr-edge-database":
        raise ValueError("source is not mlb-hr-edge-database")
    if payload.get("status") == "error":
        raise ValueError(payload.get("message") or "source status is error")
    if not payload.get("date"):
        raise ValueError("slate date is missing")
    if not payload.get("providerCallId"):
        raise ValueError("providerCallId is missing")
    response_hash = str(payload.get("providerResponseSha256") or "")
    if len(response_hash) != 64:
        raise ValueError("providerResponseSha256 is invalid")
    if not isinstance(payload.get("rows"), list):
        raise ValueError("rows must be a list")

    if expected_date and str(payload.get("date")) != expected_date:
        raise ValueError(
            f"source slate {payload.get('date')} does not match expected {expected_date}"
        )
    if expected_checkpoint:
        actual = checkpoint_label(payload)
        expected = normalize_checkpoint(expected_checkpoint)
        if actual != expected:
            raise ValueError(
                f"source checkpoint {actual or 'missing'} does not match expected {expected}"
            )


def central_odds_urls(expected_date: str, expected_checkpoint: str) -> tuple[str, ...]:
    """Return central-database reads ordered from most exact to most compatible."""
    checkpoint = normalize_checkpoint(expected_checkpoint)
    checkpoint_at = scheduled_checkpoint(expected_date, checkpoint)
    now_as_of = datetime.now(timezone.utc).isoformat()
    compatibility_as_of = (checkpoint_at + MAX_SOURCE_FINISH_DELAY).astimezone(
        timezone.utc
    ).isoformat()
    return (
        f"{EDGE_BASE_URL}/api/odds?{urlencode({'date': expected_date, 'checkpoint': checkpoint})}",
        f"{EDGE_BASE_URL}/api/odds?{urlencode({'date': expected_date, 'asOf': now_as_of})}",
        f"{EDGE_BASE_URL}/api/odds?{urlencode({'date': expected_date, 'asOf': compatibility_as_of})}",
        f"{EDGE_BASE_URL}/api/odds?latest=1",
    )


def dashboard_to_shared(
    dashboard: dict,
    expected_date: str,
    expected_checkpoint: str,
) -> dict:
    if dashboard.get("source") != "database":
        raise ValueError("dashboard response is not database-backed")
    generated_at = parse_timestamp(dashboard.get("generatedAt"))
    checkpoint = scheduled_checkpoint(expected_date, expected_checkpoint)
    checkpoint_utc = checkpoint.astimezone(timezone.utc)
    if generated_at < checkpoint_utc:
        raise ValueError("dashboard sync predates the requested checkpoint")
    if generated_at > checkpoint_utc + MAX_SOURCE_FINISH_DELAY:
        raise ValueError("dashboard sync is outside the requested checkpoint window")

    cutoff = generated_at + CAPTURE_GRACE
    rows: list[dict] = []
    available_count = 0
    excluded_count = 0
    for row in dashboard.get("rows") or []:
        offered: dict[str, dict] = {}
        game_start = None
        if row.get("gameStartAt"):
            try:
                game_start = parse_timestamp(row["gameStartAt"])
            except ValueError:
                game_start = None
        for book_id, quote in (row.get("odds") or {}).items():
            if book_id not in BOOKS or not isinstance(quote, dict):
                continue
            raw_odds = quote.get("americanOdds")
            captured_raw = quote.get("capturedAt")
            if raw_odds is None or not captured_raw:
                continue
            available_count += 1
            try:
                captured = parse_timestamp(captured_raw)
                offered_odds = int(raw_odds)
            except (TypeError, ValueError):
                excluded_count += 1
                continue
            if captured > cutoff or (game_start and captured >= game_start):
                excluded_count += 1
                continue
            offered[book_id] = {
                "americanOdds": offered_odds,
                "capturedAt": captured.isoformat(),
                "source": "mlb-hr-edge-dashboard",
                "sourceEventId": quote.get("sourceEventId"),
                "sourceOddId": quote.get("sourceOddId"),
            }
        if offered:
            rows.append(
                {
                    "predictionId": row.get("id"),
                    "gameDate": row.get("gameDate") or expected_date,
                    "gamePk": row.get("gamePk"),
                    "gameStartAt": row.get("gameStartAt"),
                    "batterId": row.get("batterId"),
                    "batterName": row.get("batterName"),
                    "batterTeam": row.get("batterTeam"),
                    "matchup": row.get("matchup"),
                    "lineupPosition": row.get("lineupPosition"),
                    "lineupConfirmed": True,
                    "odds": offered,
                }
            )

    canonical = json.dumps(
        dashboard, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    snapshot_hash = hashlib.sha256(canonical).hexdigest()
    label = normalize_checkpoint(expected_checkpoint)
    return {
        "schemaVersion": 2,
        "date": expected_date,
        "checkpoint": label,
        "asOf": cutoff.isoformat(),
        "generatedAt": generated_at.isoformat(),
        "latestIngestAt": generated_at.isoformat(),
        "status": "ready" if rows else "pending",
        "source": "mlb-hr-edge-database",
        "delivery": "central-database-dashboard-compatibility",
        "books": list(BOOKS),
        "rowCount": len(rows),
        "quoteCount": sum(len(row["odds"]) for row in rows),
        "allAvailableQuoteCount": available_count,
        "excludedLiveOrPostStartQuoteCount": excluded_count,
        "archivedCallCount": int(dashboard.get("archivedCallCount") or 1),
        "providerCallId": str(
            dashboard.get("providerCallId")
            or f"dashboard:{expected_date}:{label}:{generated_at.isoformat()}"
        ),
        "providerResponseSha256": str(
            dashboard.get("providerResponseSha256") or snapshot_hash
        ),
        "rows": rows,
    }


def dashboard_url(expected_date: str) -> str:
    return f"{EDGE_BASE_URL}/api/dashboard?{urlencode({'date': expected_date})}"


def materialize(payload: dict, output_dir: Path, source_url: str) -> dict:
    label = checkpoint_label(payload)
    payload = dict(payload)
    payload["delivery"] = "central-database-consumer-cache"
    payload["databaseUrl"] = source_url
    payload["materializedAt"] = datetime.now(timezone.utc).isoformat()
    latest_path = output_dir / "latest.json"
    archive_path = output_dir / "archive" / f"{payload['date']}_{label}.json"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2) + "\n"
    latest_path.write_text(text, encoding="utf-8")
    archive_path.write_text(text, encoding="utf-8")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--delay", type=int, default=10)
    parser.add_argument("--expected-date", required=True)
    parser.add_argument("--expected-checkpoint", required=True)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    urls = central_odds_urls(args.expected_date, args.expected_checkpoint)
    errors: list[str] = []
    selected_url: str | None = None
    payload: dict | None = None

    for attempt in range(1, args.attempts + 1):
        for url in urls:
            try:
                candidate = fetch_json(url)
                validate(
                    candidate,
                    expected_date=args.expected_date,
                    expected_checkpoint=args.expected_checkpoint,
                )
                payload = candidate
                selected_url = url
                break
            except Exception as exc:
                errors.append(f"attempt {attempt} {url}: {exc}")

        if payload is None:
            url = dashboard_url(args.expected_date)
            try:
                candidate = dashboard_to_shared(
                    fetch_json(url), args.expected_date, args.expected_checkpoint
                )
                validate(
                    candidate,
                    expected_date=args.expected_date,
                    expected_checkpoint=args.expected_checkpoint,
                )
                payload = candidate
                selected_url = url
            except Exception as exc:
                errors.append(f"attempt {attempt} {url}: {exc}")

        if payload is not None:
            break
        if attempt < args.attempts:
            time.sleep(args.delay)

    status_path = args.output_dir / "sync-status.json"
    if payload is None or selected_url is None:
        status = {
            "status": "failed",
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "source": "central-database-only",
            "sources": [*urls, dashboard_url(args.expected_date)],
            "expected_date": args.expected_date,
            "expected_checkpoint": normalize_checkpoint(args.expected_checkpoint),
            "errors": errors[-12:],
            "retained_existing_cache": (args.output_dir / "latest.json").exists(),
        }
        status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(status, indent=2))
        return 1

    payload = materialize(payload, args.output_dir, selected_url)
    label = checkpoint_label(payload)
    status = {
        "status": "success",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "source": "central-database-only",
        "database_url": selected_url,
        "date": payload["date"],
        "checkpoint": label,
        "providerCallId": payload["providerCallId"],
        "providerResponseSha256": payload["providerResponseSha256"],
        "quoteCount": payload.get("quoteCount", 0),
        "rowCount": payload.get("rowCount", len(payload.get("rows") or [])),
    }
    status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(status, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
