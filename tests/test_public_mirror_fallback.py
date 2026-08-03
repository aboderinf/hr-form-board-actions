import unittest
from datetime import date, datetime
from zoneinfo import ZoneInfo

from src.edge_source import fetch_edge_odds, fetch_latest_edge_odds


ET = ZoneInfo("America/New_York")


def mirror_payload() -> dict:
    return {
        "schemaVersion": 2,
        "date": "2026-08-02",
        "checkpoint": "2017",
        "asOf": "2026-08-03T00:25:58.912253+00:00",
        "generatedAt": "2026-08-03T00:25:58.912253+00:00",
        "latestIngestAt": "2026-08-03T00:25:58.912253+00:00",
        "status": "pending",
        "source": "mlb-hr-edge-database",
        "delivery": "public-form-board-mirror",
        "books": ["fanduel", "draftkings", "betmgm"],
        "rowCount": 0,
        "quoteCount": 0,
        "allAvailableQuoteCount": 62,
        "excludedLiveOrPostStartQuoteCount": 62,
        "archivedCallCount": 1,
        "providerCallId": "call-2017",
        "providerResponseSha256": "a" * 64,
        "rows": [],
    }


class FakeClient:
    def __init__(self) -> None:
        self.urls: list[str] = []

    def json(self, url: str) -> dict:
        self.urls.append(url)
        if "/api/odds" in url:
            raise RuntimeError("404 Not Found")
        if "/api/dashboard" in url:
            return {"source": "database", "rows": []}
        if "hr-form-board-actions.vercel.app/data/shared-odds" in url:
            return mirror_payload()
        raise RuntimeError(f"unexpected URL {url}")


class PublicMirrorFallbackTests(unittest.TestCase):
    def test_empty_checkpoint_mirror_is_valid_pending_source(self) -> None:
        client = FakeClient()
        checkpoint = datetime(2026, 8, 2, 20, 17, tzinfo=ET)
        market = fetch_edge_odds(client, date(2026, 8, 2), checkpoint)
        self.assertEqual(market["status"], "pending")
        self.assertEqual(market["players"], [])
        self.assertEqual(market["compatibility_fallback"], "public_form_board_mirror")
        self.assertEqual(market["provider_call_id"], "call-2017")
        self.assertEqual(market["all_available_quote_count"], 62)
        self.assertEqual(market["excluded_live_or_post_start_quote_count"], 62)

    def test_latest_mirror_preserves_archive_provenance(self) -> None:
        client = FakeClient()
        market = fetch_latest_edge_odds(client)
        self.assertEqual(market["status"], "pending")
        self.assertEqual(market["provider_response_sha256"], "a" * 64)
        self.assertEqual(market["compatibility_fallback"], "public_form_board_mirror")


if __name__ == "__main__":
    unittest.main()
