from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class TrackerNetworkTests(unittest.TestCase):
    def test_form_tracker_route_and_cross_site_loader_are_present(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        shell = (ROOT / "src" / "storage.py").read_text(encoding="utf-8")
        index = (ROOT / "index.html").read_text(encoding="utf-8")
        network = (ROOT / "tracker-network.js").read_text(encoding="utf-8")

        self.assertIn('["tracker", "Tracker"]', app)
        self.assertIn("function trackerPage()", app)
        self.assertIn("tracker: trackerPage", app)
        self.assertIn("tracker-network.js", shell)
        self.assertIn("tracker-network.js", index)
        self.assertIn("https://mlb-hr-edge.feranmi.chatgpt.site/tracker", network)
        self.assertIn("https://mlb-hr-edge.feranmi.chatgpt.site/ledger", network)
        self.assertIn("/api/edge-ledger", network)
        self.assertIn('payload?.source !== "mlb-hr-edge-database"', network)
        self.assertIn("activeTrackerUrl", network)

    def test_edge_ledger_proxy_normalizes_and_validates_database_ledger(self) -> None:
        proxy = (ROOT / "api" / "edge-ledger.js").read_text(encoding="utf-8")
        self.assertIn("/api/ledger", proxy)
        self.assertIn('source: "mlb-hr-edge-database"', proxy)
        self.assertIn("Array.isArray(payload.rows)", proxy)
        self.assertIn("activeTrackerUrl", proxy)
        self.assertIn('trackerRoute: "legacy-ledger"', proxy)
        self.assertIn("X-Tracker-Source", proxy)
        self.assertNotIn("sportsgameodds", proxy.lower())


if __name__ == "__main__":
    unittest.main()
