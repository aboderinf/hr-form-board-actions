#!/usr/bin/env python3
"""Archive Top 100 odds from one exact local shared-odds checkpoint."""

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
    args = parser.parse_args()

    checkpoint = normalize_checkpoint(args.checkpoint)
    slate = date.fromisoformat(args.date)
    source_path = ROOT / "data" / "shared-odds" / "archive" / f"{args.date}_{checkpoint}.json"
    if not source_path.exists() or source_path.stat().st_size == 0:
        raise SystemExit(f"Exact local checkpoint archive is missing: {source_path}")

    payload = read_json(source_path)
    if str(payload.get("date") or "") != args.date:
        raise SystemExit("Local checkpoint archive has the wrong slate date")
    if normalize_checkpoint(str(payload.get("checkpoint") or "")) != checkpoint:
        raise SystemExit("Local checkpoint archive has the wrong checkpoint label")

    edge = parse_edge_payload(
        payload,
        slate,
        enforce_checkpoint_age=False,
        require_confirmed_lineup=False,
    )
    edge["source_url"] = str(source_path.relative_to(ROOT))
    edge["compatibility_fallback"] = "exact_local_checkpoint_archive"

    top100_path = ROOT / "data" / "top100.json"
    top100 = read_json(top100_path)
    if str(top100.get("slate_date") or "") != args.date:
        raise SystemExit(
            f"Top 100 slate {top100.get('slate_date')!r} does not match {args.date}"
        )

    now = datetime.now(timezone.utc)
    capture = create_capture(top100, edge, now, checkpoint)
    archive_dir = ROOT / "data" / "discovery" / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    capture_path = archive_dir / f"{args.date}_{checkpoint}.json"
    write_json(capture_path, capture)

    if capture.get("top100_rows") != 100:
        raise SystemExit(f"Expected 100 Top 100 rows, got {capture.get('top100_rows')}")
    if int(capture.get("priced_rows") or 0) <= 0:
        raise SystemExit("Exact checkpoint capture contains no Top 100 prices")

    subprocess.run(
        [sys.executable, "scripts/build_discovery.py", "--no-capture"],
        cwd=ROOT,
        check=True,
    )
    print(
        json.dumps(
            {
                "status": "success",
                "slate_date": args.date,
                "checkpoint": checkpoint,
                "source": str(source_path.relative_to(ROOT)),
                "source_rows": edge.get("row_count"),
                "source_quotes": edge.get("quote_count"),
                "top100_rows": capture.get("top100_rows"),
                "priced_rows": capture.get("priced_rows"),
                "capture": str(capture_path.relative_to(ROOT)),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
