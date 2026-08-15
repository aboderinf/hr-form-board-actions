from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load_script():
    path = ROOT / "scripts" / "backfill_stored_checkpoints.py"
    spec = importlib.util.spec_from_file_location("backfill_stored_checkpoints", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backfill = load_script()


class StoredCheckpointBackfillTests(unittest.TestCase):
    def test_targets_are_strict_and_normalized(self):
        self.assertEqual(
            backfill.parse_target("2026-08-14:817"),
            ("2026-08-14", "0817"),
        )
        with self.assertRaises(Exception):
            backfill.parse_target("2026-08-14:1417")

    def test_historical_capture_uses_the_scheduled_checkpoint_time(self):
        captured = backfill.checkpoint_timestamp("2026-08-14", "20:17")
        self.assertEqual(
            captured,
            datetime(2026, 8, 15, 0, 17, tzinfo=timezone.utc),
        )

    def test_backfill_contract_never_calls_sportsgameodds(self):
        script = (
            ROOT / "scripts" / "backfill_stored_checkpoints.py"
        ).read_text(encoding="utf-8")
        workflow = (
            ROOT / ".github" / "workflows" / "backfill-stored-checkpoints.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("sync_upstash_checkpoint.py", script)
        self.assertNotIn("SPORTS_GAME_ODDS_API_KEY", script + workflow)
        self.assertNotIn("api.sportsgameodds.com", script + workflow)


if __name__ == "__main__":
    unittest.main()
