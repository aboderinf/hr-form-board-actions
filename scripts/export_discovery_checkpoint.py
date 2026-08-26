#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.sources import HttpClient
from src.storage import write_json

ET = ZoneInfo("America/New_York")
CENTRAL_ODDS_API = "https://hr-form-board-actions.vercel.app/api/central-odds"
VALID_CHECKPOINTS = {"0817", "1117", "1717", "2017"}


def normalize_checkpoint(value: str) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit()).zfill(4)
    if digits not in VALID_CHECKPOINTS:
        raise SystemExit(f"Invalid checkpoint: {value}")
    return digits


def existing_payload(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def main() -> int:
    parser = argparse.ArgumentParser(description="Export an exact Redis-backed Discovery checkpoint to the Git archive")
    parser.add_argument("--date")
    parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args()

    now_et = datetime.now(ET)
    slate_date = args.date or now_et.date().isoformat()
    checkpoint = normalize_checkpoint(args.checkpoint)
    query = urlencode({"date": slate_date, "checkpoint": checkpoint, "discovery": "1"})
    url = f"{CENTRAL_ODDS_API}?{query}"

    payload = HttpClient().json(url)
    if payload.get("slate_date") != slate_date:
        raise SystemExit(
            f"Discovery slate mismatch: expected {slate_date}, got {payload.get('slate_date')}"
        )
    if str(payload.get("checkpoint")) != checkpoint:
        raise SystemExit(
            f"Discovery checkpoint mismatch: expected {checkpoint}, got {payload.get('checkpoint')}"
        )
    source = payload.get("source") or {}
    if source.get("status") != "ready" or not source.get("same_slate"):
        raise SystemExit(f"Discovery source is not ready/same-slate: {source}")
    if not source.get("provider_call_id"):
        raise SystemExit("Discovery export is missing provider_call_id")

    archive_dir = ROOT / "data" / "discovery" / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    path = archive_dir / f"{slate_date}_{checkpoint}.json"
    current = existing_payload(path)
    incoming_schema = int(payload.get("schema_version") or 0)
    current_schema = int(current.get("schema_version") or 0)
    same_call = (
        (current.get("source") or {}).get("provider_call_id")
        == source.get("provider_call_id")
    )

    if current and current_schema >= incoming_schema and same_call:
        print(f"Immutable archive already current: {path.name}")
    else:
        write_json(path, payload)
        action = "Upgraded" if current else "Exported"
        print(
            f"{action} {path.name}: schema={incoming_schema} "
            f"top100={payload.get('top100_rows')} priced={payload.get('priced_rows')} "
            f"call={source.get('provider_call_id')}"
        )

    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_discovery.py"), "--no-capture"],
        check=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
