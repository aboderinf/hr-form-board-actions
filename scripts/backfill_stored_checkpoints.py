#!/usr/bin/env python3
"""Rebuild historical Form Board surfaces from stored Redis checkpoints only."""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime, time, timezone
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.sources import HttpClient
from src.storage import rebuild, write_json


PYTHON = sys.executable
ET = ZoneInfo("America/New_York")
CHECKPOINT_ORDER = {"0817": 0, "1117": 1, "1717": 2, "2017": 3}
PRESERVED_CURRENT_PATHS = (
    Path("data/shared-odds/latest.json"),
    Path("data/shared-odds/sync-status.json"),
    Path("data/top100.json"),
)


def normalize_checkpoint(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) == 3:
        digits = f"0{digits}"
    if digits not in CHECKPOINT_ORDER:
        raise ValueError(f"Invalid checkpoint: {value!r}")
    return digits


def parse_target(value: str) -> tuple[str, str]:
    try:
        slate_date, checkpoint = value.rsplit(":", 1)
        date.fromisoformat(slate_date)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(
            f"Target must be YYYY-MM-DD:HHMM, got {value!r}"
        ) from exc
    try:
        return slate_date, normalize_checkpoint(checkpoint)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def checkpoint_timestamp(slate_date: str, checkpoint: str) -> datetime:
    digits = normalize_checkpoint(checkpoint)
    scheduled = datetime.combine(
        date.fromisoformat(slate_date),
        time(int(digits[:2]), int(digits[2:])),
        ET,
    )
    return scheduled.astimezone(timezone.utc)


def run(command: list[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def preserve_current_files() -> dict[Path, bytes | None]:
    return {
        path: (ROOT / path).read_bytes() if (ROOT / path).exists() else None
        for path in PRESERVED_CURRENT_PATHS
    }


def restore_current_files(saved: dict[Path, bytes | None]) -> None:
    for path, content in saved.items():
        absolute = ROOT / path
        if content is None:
            if absolute.exists():
                absolute.unlink()
            continue
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_bytes(content)


def load_checkpoint_module():
    path = ROOT / "scripts" / "run_checkpoint.py"
    spec = importlib.util.spec_from_file_location("backfill_checkpoint_runtime", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mark_backfilled(path: Path, completed_at: str) -> None:
    payload = load(path)
    payload["backfilled_at"] = completed_at
    payload["backfill_source"] = "stored_qstash_redis_checkpoint"
    write_json(path, payload)


def validate_outputs(slate_date: str, checkpoint: str) -> dict[str, Any]:
    shared_path = ROOT / "data" / "shared-odds" / "archive" / f"{slate_date}_{checkpoint}.json"
    capture_path = ROOT / "data" / "discovery" / "archive" / f"{slate_date}_{checkpoint}.json"
    snapshot_path = ROOT / "data" / "snapshots" / f"{slate_date}_{checkpoint}.json"
    shared = load(shared_path)
    capture = load(capture_path)
    snapshot = load(snapshot_path)
    if shared.get("delivery") != "qstash-vercel-redis":
        raise RuntimeError(f"{slate_date} {checkpoint}: archive is not Redis-backed")
    if int(capture.get("top100_rows") or 0) != 100:
        raise RuntimeError(f"{slate_date} {checkpoint}: Discovery does not have 100 rows")
    if int(shared.get("quoteCount") or 0) > 0 and int(capture.get("priced_rows") or 0) <= 0:
        raise RuntimeError(f"{slate_date} {checkpoint}: stored quotes joined no Top 100 rows")
    if snapshot.get("status") not in {"frozen", "no_eligible_players"}:
        raise RuntimeError(
            f"{slate_date} {checkpoint}: tracker snapshot status is {snapshot.get('status')!r}"
        )
    return {
        "slate_date": slate_date,
        "checkpoint": checkpoint,
        "provider_call_id": shared.get("providerCallId"),
        "quote_count": int(shared.get("quoteCount") or 0),
        "source_rows": int(shared.get("rowCount") or len(shared.get("rows") or [])),
        "discovery_priced_rows": int(capture.get("priced_rows") or 0),
        "tracker_status": snapshot.get("status"),
        "tracker_eligible_candidates": int(snapshot.get("eligible_candidates") or 0),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Backfill Discovery and Form Tracker from exact stored checkpoints"
    )
    parser.add_argument(
        "--target",
        action="append",
        required=True,
        type=parse_target,
        metavar="YYYY-MM-DD:HHMM",
    )
    args = parser.parse_args(argv)

    targets = sorted(
        set(args.target),
        key=lambda item: (item[0], CHECKPOINT_ORDER[item[1]]),
    )
    grouped: dict[str, list[str]] = defaultdict(list)
    for slate_date, checkpoint in targets:
        grouped[slate_date].append(checkpoint)

    saved = preserve_current_files()
    completed_at = datetime.now(timezone.utc).isoformat()
    summaries: list[dict[str, Any]] = []
    try:
        for slate_date, checkpoints in grouped.items():
            run([PYTHON, "scripts/build_top100.py", "--date", slate_date])
            for checkpoint in checkpoints:
                label = f"{checkpoint[:2]}:{checkpoint[2:]}"
                run(
                    [
                        PYTHON,
                        "scripts/sync_upstash_checkpoint.py",
                        "--date",
                        slate_date,
                        "--checkpoint",
                        label,
                        "--attempts",
                        "1",
                        "--delay",
                        "0",
                    ]
                )
                run(
                    [
                        PYTHON,
                        "scripts/run_checkpoint_from_cache.py",
                        "--date",
                        slate_date,
                        "--checkpoint",
                        label,
                        "--force",
                    ]
                )
                run(
                    [
                        PYTHON,
                        "scripts/capture_top100_checkpoint.py",
                        "--date",
                        slate_date,
                        "--checkpoint",
                        label,
                        "--captured-at",
                        checkpoint_timestamp(slate_date, checkpoint).isoformat(),
                        "--no-rebuild",
                    ]
                )
                mark_backfilled(
                    ROOT / "data" / "snapshots" / f"{slate_date}_{checkpoint}.json",
                    completed_at,
                )
                mark_backfilled(
                    ROOT
                    / "data"
                    / "discovery"
                    / "archive"
                    / f"{slate_date}_{checkpoint}.json",
                    completed_at,
                )
                summaries.append(validate_outputs(slate_date, checkpoint))

        checkpoint_runtime = load_checkpoint_module()
        target_snapshots = [
            ROOT / "data" / "snapshots" / f"{slate_date}_{checkpoint}.json"
            for slate_date, checkpoint in targets
        ]
        checkpoint_runtime.settle_old(
            HttpClient(), target_snapshots, datetime.now(timezone.utc)
        )
        run([PYTHON, "scripts/build_discovery.py", "--no-capture"])
    finally:
        restore_current_files(saved)

    rebuild(ROOT / "data", ROOT)
    report = {
        "schema_version": 1,
        "status": "success",
        "source": "stored_qstash_redis_checkpoints_only",
        "completed_at": completed_at,
        "targets": summaries,
        "total_quote_count": sum(row["quote_count"] for row in summaries),
        "sports_game_odds_calls": 0,
    }
    report_path = ROOT / "data" / "status" / "backfill-stored-checkpoints-2026-08-15.json"
    write_json(report_path, report)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
