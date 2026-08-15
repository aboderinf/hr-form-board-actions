#!/usr/bin/env python3
"""Archive Top 100 odds from one exact central-database checkpoint cache."""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from build_discovery import create_capture
from src.edge_source import parse_edge_payload
from src.storage import write_json


def normalize_checkpoint(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) == 3:
        digits = f"0{digits}"
    if len(digits) != 4:
        raise ValueError(f"Invalid checkpoint {value!r}")
    return digits


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True, help="Slate date YYYY-MM-DD")
    parser.add_argument("--checkpoint", required=True, help="Checkpoint such as 11:17")
    parser.add_argument(
        "--captured-at",
        help="Optional timezone-aware ISO timestamp for a historical capture",
    )
    parser.add_argument(
        "--no-rebuild",
        action="store_true",
        help="Write the capture without rebuilding aggregate Discovery reports",
    )
    args = parser.parse_args()

    checkpoint = normalize_checkpoint(args.checkpoint)
    slate = date.fromisoformat(args.date)
    source_path = ROOT / "data" / "shared-odds" / "archive" / f"{args.date}_{checkpoint}.json"
    if not source_path.exists() or source_path.stat().st_size == 0:
        raise SystemExit(f"Exact central checkpoint cache is missing: {source_path}")

    payload = read_json(source_path)
    if str(payload.get("date") or "") != args.date:
        raise SystemExit("Central checkpoint cache has the wrong slate date")
    if normalize_checkpoint(str(payload.get("checkpoint") or "")) != checkpoint:
        raise SystemExit("Central checkpoint cache has the wrong checkpoint label")

    edge = parse_edge_payload(
        payload,
        slate,
        enforce_checkpoint_age=False,
        require_confirmed_lineup=False,
    )
    edge["source_url"] = str(source_path.relative_to(ROOT))
    edge["compatibility_fallback"] = "central_database_consumer_cache"

    top100_path = ROOT / "data" / "top100.json"
    top100 = read_json(top100_path)
    if str(top100.get("slate_date") or "") != args.date:
        raise SystemExit(
            f"Top 100 slate {top100.get('slate_date')!r} does not match {args.date}"
        )

    now = (
        datetime.fromisoformat(args.captured_at.replace("Z", "+00:00"))
        if args.captured_at
        else datetime.now(timezone.utc)
    )
    if now.tzinfo is None:
        raise SystemExit("--captured-at must include a timezone")
    capture = create_capture(top100, edge, now, checkpoint)
    archive_dir = ROOT / "data" / "discovery" / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    capture_path = archive_dir / f"{args.date}_{checkpoint}.json"
    write_json(capture_path, capture)

    if capture.get("top100_rows") != 100:
        raise SystemExit(f"Expected 100 Top 100 rows, got {capture.get('top100_rows')}")

    priced_rows = int(capture.get("priced_rows") or 0)
    source_quotes = int(edge.get("quote_count") or 0)
    available_quotes = int(payload.get("allAvailableQuoteCount") or 0)
    excluded_quotes = int(payload.get("excludedLiveOrPostStartQuoteCount") or 0)
    if priced_rows <= 0 and source_quotes > 0:
        raise SystemExit(
            "Central checkpoint had usable pregame quotes but none joined to Top 100"
        )

    if not args.no_rebuild:
        subprocess.run(
            [sys.executable, "scripts/build_discovery.py", "--no-capture"],
            cwd=ROOT,
            check=True,
        )
    status = "success" if priced_rows > 0 else "no_remaining_pregame_prices"
    print(
        json.dumps(
            {
                "status": status,
                "slate_date": args.date,
                "checkpoint": checkpoint,
                "source": str(source_path.relative_to(ROOT)),
                "source_rows": edge.get("row_count"),
                "source_quotes": source_quotes,
                "available_quotes": available_quotes,
                "excluded_live_or_post_start_quotes": excluded_quotes,
                "top100_rows": capture.get("top100_rows"),
                "priced_rows": priced_rows,
                "capture": str(capture_path.relative_to(ROOT)),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
