#!/usr/bin/env python3
"""Run all Form Board consumers immediately after one matching source capture."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


def normalize_checkpoint(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) == 3:
        digits = f"0{digits}"
    if len(digits) != 4:
        raise ValueError(f"Invalid checkpoint: {value}")
    return digits


def checkpoint_with_colon(value: str) -> str:
    digits = normalize_checkpoint(value)
    return f"{digits[:2]}:{digits[2:]}"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def source_matches(payload: dict, slate_date: str, checkpoint: str) -> bool:
    actual_checkpoint = normalize_checkpoint(str(payload.get("checkpoint") or ""))
    return (
        str(payload.get("date") or "") == slate_date
        and actual_checkpoint == normalize_checkpoint(checkpoint)
        and bool(payload.get("providerCallId"))
        and len(str(payload.get("providerResponseSha256") or "")) == 64
    )


def run(command: list[str]) -> float:
    started = time.monotonic()
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)
    return round(time.monotonic() - started, 3)


def write_status(payload: dict) -> None:
    path = ROOT / "data" / "pipeline-status.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True, help="Slate date YYYY-MM-DD")
    parser.add_argument("--checkpoint", required=True, help="08:17, 11:17, 17:17 or 20:17")
    parser.add_argument("--attempts", type=int, default=60)
    parser.add_argument("--delay", type=int, default=15)
    args = parser.parse_args()

    checkpoint_digits = normalize_checkpoint(args.checkpoint)
    checkpoint_label = checkpoint_with_colon(args.checkpoint)
    started_at = datetime.now(timezone.utc)
    status: dict = {
        "schema_version": 1,
        "status": "running",
        "slate_date": args.date,
        "checkpoint": checkpoint_digits,
        "checkpoint_label": checkpoint_label,
        "started_at": started_at.isoformat(),
        "steps": {},
    }
    write_status(status)

    try:
        status["steps"]["wait_for_source_seconds"] = run(
            [
                PYTHON,
                "scripts/sync_shared_odds_mirror.py",
                "--output-dir",
                "data/shared-odds",
                "--attempts",
                str(args.attempts),
                "--delay",
                str(args.delay),
                "--expected-date",
                args.date,
                "--expected-checkpoint",
                checkpoint_digits,
            ]
        )

        source = read_json(ROOT / "data" / "shared-odds" / "latest.json")
        if not source_matches(source, args.date, checkpoint_digits):
            raise RuntimeError("Synchronized source does not match the requested checkpoint")
        status["source_detected_at"] = datetime.now(timezone.utc).isoformat()
        status["provider_call_id"] = source["providerCallId"]
        status["provider_response_sha256"] = source["providerResponseSha256"]
        status["source_quote_count"] = source.get("quoteCount", 0)
        status["source_available_quote_count"] = source.get("allAvailableQuoteCount", 0)

        parallel = {
            "checkpoint_seconds": [
                PYTHON,
                "scripts/run_checkpoint.py",
                "--date",
                args.date,
                "--checkpoint",
                checkpoint_label,
                "--force",
            ],
            "top100_seconds": [
                PYTHON,
                "scripts/build_top100.py",
                "--date",
                args.date,
                "--odds-only",
            ],
        }
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {executor.submit(run, command): name for name, command in parallel.items()}
            failures: list[BaseException] = []
            for future in as_completed(futures):
                name = futures[future]
                try:
                    status["steps"][name] = future.result()
                except BaseException as exc:
                    failures.append(exc)
            if failures:
                raise failures[0]

        status["steps"]["today_seconds"] = run(
            [PYTHON, "scripts/refresh_latest.py"]
        )
        status["steps"]["discovery_seconds"] = run(
            [
                PYTHON,
                "scripts/build_discovery.py",
                "--checkpoint",
                checkpoint_digits,
            ]
        )

        completed_at = datetime.now(timezone.utc)
        status["status"] = "success"
        status["completed_at"] = completed_at.isoformat()
        status["elapsed_seconds"] = round(
            (completed_at - started_at).total_seconds(), 3
        )
        write_status(status)
        print(json.dumps(status, indent=2))
        return 0
    except BaseException as exc:
        completed_at = datetime.now(timezone.utc)
        status["status"] = "failed"
        status["completed_at"] = completed_at.isoformat()
        status["elapsed_seconds"] = round(
            (completed_at - started_at).total_seconds(), 3
        )
        status["error"] = f"{type(exc).__name__}: {exc}"
        write_status(status)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
