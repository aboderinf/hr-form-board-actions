from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CheckpointBrowserOverlayTests(unittest.TestCase):
    def test_browser_requests_exact_checkpoint_and_preserves_generated_prices(self) -> None:
        overlay = (ROOT / "central-data-source.js").read_text(encoding="utf-8")

        self.assertIn("centralOddsForDate(top100.slate_date, checkpoint)", overlay)
        self.assertIn("Central checkpoint mismatch", overlay)
        self.assertIn("retaining generated checkpoint odds", overlay)
        self.assertIn("players.filter((player) => player.odds_available).length", overlay)
        self.assertIn("top100.odds?.quote_count", overlay)

    def test_proxy_never_uses_dashboard_for_exact_checkpoint(self) -> None:
        proxy = (ROOT / "api" / "central-odds.js").read_text(encoding="utf-8")

        self.assertIn("requestedCheckpoint", proxy)
        self.assertIn("!requestedCheckpoint", proxy)
        self.assertIn("Exact checkpoint is not yet available", proxy)
        self.assertIn("Central odds checkpoint mismatch", proxy)


if __name__ == "__main__":
    unittest.main()
