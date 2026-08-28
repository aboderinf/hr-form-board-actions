from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


refresh_latest = load_script("refresh_latest_reliability", ROOT / "scripts" / "refresh_latest.py")


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        value = cls(2026, 8, 28, 12, 15, 0, tzinfo=timezone.utc)
        if tz is None:
            return value.replace(tzinfo=None)
        return value.astimezone(tz)


class CheckpointReliabilityTests(unittest.TestCase):
    def test_latest_board_never_rolls_back_to_previous_et_date(self) -> None:
        writes: list[dict] = []

        def capture_write(_path, payload):
            writes.append(payload)

        stale_market = {
            "source_date": "2026-08-27",
            "players": [],
        }

        with (
            patch.object(refresh_latest, "datetime", FixedDateTime),
            patch.object(refresh_latest, "HttpClient", return_value=object()),
            patch.object(refresh_latest, "fetch_latest_edge_odds", return_value=stale_market),
            patch.object(refresh_latest, "write_json", side_effect=capture_write),
            patch.object(refresh_latest, "rebuild", return_value=None),
        ):
            self.assertEqual(refresh_latest.main([]), 0)

        self.assertEqual(len(writes), 1)
        payload = writes[0]
        self.assertEqual(payload["slate_date"], "2026-08-28")
        self.assertEqual(payload["status"], "shared_odds_source_unavailable")
        self.assertIn("awaiting current ET slate 2026-08-28", payload["diagnostics"][0])

    def test_capture_endpoint_marks_provider_failure_retryable(self) -> None:
        source = (ROOT / "api" / "capture-checkpoint.js").read_text(encoding="utf-8")
        self.assertIn('"provider_failed_after_single_attempt"', source)
        self.assertIn('"already_attempted"', source)
        self.assertIn('await releaseAttemptForRetry(slateDate, checkpoint);', source)
        self.assertIn('response.setHeader("Retry-After", "60")', source)
        self.assertIn('response.status(retryable ? 503', source)

    def test_schedule_preflight_has_independent_recovery_deliveries(self) -> None:
        source = (ROOT / "api" / "qstash-0817-diagnostic.js").read_text(encoding="utf-8")
        self.assertIn('const RECOVERY_MINUTES = 5;', source)
        self.assertIn('"Upstash-Schedule-Id": scheduleId', source)
        self.assertIn('"Upstash-Retries": "2"', source)
        self.assertIn('"Upstash-Retry-Delay": "60000 * (1 + retried)"', source)
        self.assertIn('configured.push(await upsertCheckpointSchedule(resolved, checkpoint, true));', source)


if __name__ == "__main__":
    unittest.main()
