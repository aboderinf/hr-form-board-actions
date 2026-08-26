#!/usr/bin/env python3
from __future__ import annotations

import argparse
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
ARCHIVE_API = "https://hr-form-board-actions.vercel.app/api/discovery-archive"
VALID_CHECKPOINTS = {"0817", "1117", "1717", "2017"}


def normalize_checkpoint(value: str) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit()).zfill(4)
    if digits not in VALID_CHECKPOINTS:
        raise SystemExit(f"Invalid checkpoint: {value}")
    return digits


def main() -> int:
    parser = argparse.ArgumentParser(description="Export an exact Redis-backed Discovery checkpoint to the Git archive")
    parser.add_argument("--date")
    parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args()

    now_et = datetime.now(ET)
    slate_date = args.date or now_et.date().isoformat()
    checkpoint = normalize_checkpoint(args.checkpoint)
    query = urlencode({"date": slate_date, "checkpoint": checkpoint})
    url = f"{ARCHIVE_API}?{query}"

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
    if path.exists():
        print(f"Immutable archive already exists: {path.name}")
    else:
        write_json(path, payload)
        print(
            f"Exported {path.name}: top100={payload.get('top100_rows')} "
            f"priced={payload.get('priced_rows')} call={source.get('provider_call_id')}"
        )

    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_discovery.py"), "--no-capture"],
        check=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
