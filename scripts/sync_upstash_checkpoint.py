#!/usr/bin/env python3
"""Materialize one exact QStash/Vercel/Redis checkpoint into the Form Board cache."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen


CENTRAL_URL = "https://hr-form-board-actions.vercel.app/api/central-odds"


def normalize_checkpoint(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) == 3:
        digits = f"0{digits}"
    if len(digits) != 4:
        raise ValueError(f"Invalid checkpoint: {value}")
    return digits


def fetch_json(url: str) -> dict:
    request = Request(url, headers={"User-Agent": "hr-form-upstash-consumer/1.0"})
    with urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.load(response)


def validate(payload: dict, expected_date: str, expected_checkpoint: str) -> None:
    checkpoint = normalize_checkpoint(expected_checkpoint)
    if payload.get("source") != "mlb-hr-edge-database":
        raise ValueError("unexpected source")
    if payload.get("delivery") != "qstash-vercel-redis":
        raise ValueError(f"unexpected delivery {payload.get('delivery')!r}")
    if str(payload.get("date") or "") != expected_date:
        raise ValueError("slate date mismatch")
    if normalize_checkpoint(str(payload.get("checkpoint") or "")) != checkpoint:
        raise ValueError("checkpoint mismatch")
    if not payload.get("providerCallId"):
        raise ValueError("providerCallId is missing")
    if len(str(payload.get("providerResponseSha256") or "")) != 64:
        raise ValueError("providerResponseSha256 is invalid")
    if not isinstance(payload.get("rows"), list):
        raise ValueError("rows must be a list")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("data/shared-odds"))
    parser.add_argument("--attempts", type=int, default=40)
    parser.add_argument("--delay", type=int, default=15)
    args = parser.parse_args()

    checkpoint = normalize_checkpoint(args.checkpoint)
    url = f"{CENTRAL_URL}?{urlencode({'date': args.date, 'checkpoint': checkpoint})}"
    errors: list[str] = []
    payload: dict | None = None

    for attempt in range(1, args.attempts + 1):
        try:
            candidate = fetch_json(url)
            validate(candidate, args.date, checkpoint)
            payload = candidate
            break
        except Exception as exc:
            errors.append(f"attempt {attempt}: {exc}")
            if attempt < args.attempts:
                time.sleep(args.delay)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    status_path = args.output_dir / "sync-status.json"
    if payload is None:
        status = {
            "status": "failed",
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "source": "upstash-qstash-vercel",
            "url": url,
            "expected_date": args.date,
            "expected_checkpoint": checkpoint,
            "errors": errors[-12:],
        }
        status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(status, indent=2))
        return 1

    payload = dict(payload)
    payload["databaseUrl"] = url
    payload["materializedAt"] = datetime.now(timezone.utc).isoformat()
    latest_path = args.output_dir / "latest.json"
    archive_path = args.output_dir / "archive" / f"{args.date}_{checkpoint}.json"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2) + "\n"
    latest_path.write_text(text, encoding="utf-8")
    archive_path.write_text(text, encoding="utf-8")

    status = {
        "status": "success",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "source": "upstash-qstash-vercel",
        "database_url": url,
        "date": payload["date"],
        "checkpoint": checkpoint,
        "providerCallId": payload["providerCallId"],
        "providerResponseSha256": payload["providerResponseSha256"],
        "quoteCount": int(payload.get("quoteCount") or 0),
        "rowCount": int(payload.get("rowCount") or len(payload.get("rows") or [])),
    }
    status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(status, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
