from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


orchestrator = load_script(
    "run_source_driven_refresh",
    ROOT / "scripts" / "run_source_driven_refresh.py",
)
mirror = load_script(
    "sync_shared_odds_mirror",
    ROOT / "scripts" / "sync_shared_odds_mirror.py",
)


class SourceDrivenRefreshTests(unittest.TestCase):
    def payload(self, checkpoint: str = "2017") -> dict:
        return {
            "source": "mlb-hr-edge-database",
            "status": "ready",
            "date": "2026-08-02",
            "checkpoint": checkpoint,
            "providerCallId": "call-1",
            "providerResponseSha256": "a" * 64,
            "rows": [],
        }

    def test_checkpoint_formats_normalize_identically(self) -> None:
        self.assertEqual(orchestrator.normalize_checkpoint("20:17"), "2017")
        self.assertEqual(orchestrator.normalize_checkpoint("8:17"), "0817")
        self.assertEqual(orchestrator.checkpoint_with_colon("0817"), "08:17")

    def test_exact_source_checkpoint_matches(self) -> None:
        self.assertTrue(
            orchestrator.source_matches(self.payload(), "2026-08-02", "20:17")
        )

    def test_stale_source_checkpoint_is_rejected(self) -> None:
        self.assertFalse(
            orchestrator.source_matches(
                self.payload(checkpoint="1717"), "2026-08-02", "20:17"
            )
        )

    def test_mirror_validation_requires_requested_capture(self) -> None:
        mirror.validate(
            self.payload(),
            expected_date="2026-08-02",
            expected_checkpoint="20:17",
        )
        with self.assertRaisesRegex(ValueError, "does not match expected"):
            mirror.validate(
                self.payload(checkpoint="1717"),
                expected_date="2026-08-02",
                expected_checkpoint="20:17",
            )


if __name__ == "__main__":
    unittest.main()
