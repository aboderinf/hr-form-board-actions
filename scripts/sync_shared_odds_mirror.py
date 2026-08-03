#!/usr/bin/env python3
"""Synchronize the public Form Board mirror from owned central data sources."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ET = ZoneInfo("America/New_York")
SOURCES = (
    "https://mlb-hr-edge.feranmi.chatgpt.site/api/odds?latest=1",
    "https://aboderinf.github.io/mlb-hr-fair-odds-v1/latest.json",
)


def fetch_json(url: str) -> dict:
    request = Request(url, headers={"User-Agent": "hr-form-shared-mirror/1.0"})
    with urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.load(response)


def normalize_checkpoint(value: str | None) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 3:
        digits = f"0{digits}"
    return digits


def checkpoint_label(payload: dict) -> str:
    explicit = str(payload.get("checkpoint") or "")
    if explicit:
        return normalize_checkpoint(explicit)
    stamp = payload.get("latestIngestAt") or payload.get("generatedAt")
    if stamp:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        return parsed.astimezone(ET).strftime("%H%M")
    return datetime.now(ET).strftime("%H%M")


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--delay", type=int, default=10)
    parser.add_argument("--expected-date")
    parser.add_argument("--expected-checkpoint")
    args = parser.parse_args()

    errors: list[str] = []
    selected_url: str | None = None
    payload: dict | None = None
    for attempt in range(1, args.attempts + 1):
        for url in SOURCES:
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
        if payload is not None:
            break
        if attempt < args.attempts:
            time.sleep(args.delay)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    status_path = args.output_dir / "sync-status.json"
    if payload is None:
        status = {
            "status": "failed",
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "sources": list(SOURCES),
            "expected_date": args.expected_date,
            "expected_checkpoint": normalize_checkpoint(args.expected_checkpoint),
            "errors": errors[-6:],
            "retained_existing_mirror": (args.output_dir / "latest.json").exists(),
        }
        status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(status, indent=2))
        return 1

    label = checkpoint_label(payload)
    payload["delivery"] = "public-form-board-mirror"
    payload["mirroredFrom"] = selected_url
    payload["mirroredAt"] = datetime.now(timezone.utc).isoformat()
    latest_path = args.output_dir / "latest.json"
    archive_path = args.output_dir / "archive" / f"{payload['date']}_{label}.json"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2) + "\n"
    latest_path.write_text(text, encoding="utf-8")
    archive_path.write_text(text, encoding="utf-8")
    status = {
        "status": "success",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "source_url": selected_url,
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
