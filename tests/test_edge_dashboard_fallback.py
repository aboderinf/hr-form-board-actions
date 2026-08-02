from __future__ import annotations

import unittest
from datetime import date, datetime
from zoneinfo import ZoneInfo

from src.edge_source import fetch_edge_odds


ET = ZoneInfo("America/New_York")


class FakeClient:
    def __init__(self, dashboard: dict) -> None:
        self.dashboard = dashboard
        self.urls: list[str] = []

    def json(self, url: str) -> dict:
        self.urls.append(url)
        if "/api/odds" in url:
            raise RuntimeError("404 Not Found")
        return self.dashboard


class DashboardFallbackTests(unittest.TestCase):
    def test_recovers_prices_from_scheduled_capture_window(self) -> None:
        dashboard = {
            "source": "database",
            "generatedAt": "2026-08-02T21:20:00+00:00",
            "feedStatus": "live",
            "rows": [
                {
                    "id": "2026-08-02:123:456",
                    "gameDate": "2026-08-02",
                    "gamePk": 123,
                    "gameStartAt": "2026-08-02T23:00:00+00:00",
                    "batterId": 456,
                    "batterName": "Test Hitter",
                    "batterTeam": "Test Team",
                    "matchup": "AAA @ BBB",
                    "lineupPosition": 3,
                    "odds": {
                        "fanduel": {
                            "americanOdds": 650,
                            "capturedAt": "2026-08-02T21:12:00+00:00",
                        },
                        "draftkings": {
                            "americanOdds": 700,
                            "capturedAt": "2026-08-02T21:18:00+00:00",
                        },
                    },
                }
            ],
        }
        client = FakeClient(dashboard)
        checkpoint = datetime(2026, 8, 2, 17, 17, tzinfo=ET)
        market = fetch_edge_odds(client, date(2026, 8, 2), checkpoint)

        self.assertEqual(market["compatibility_fallback"], "dashboard")
        self.assertEqual(market["checkpoint_at"], checkpoint.isoformat())
        self.assertEqual(len(market["players"]), 1)
        prices = market["players"][0]["prices"]
        self.assertEqual(
            [(row["book_id"], row["odds"]) for row in prices],
            [("fanduel", 650), ("draftkings", 700)],
        )
        self.assertEqual(len(client.urls), 2)

    def test_rejects_prices_after_scheduled_capture_window(self) -> None:
        dashboard = {
            "source": "database",
            "generatedAt": "2026-08-02T21:33:00+00:00",
            "feedStatus": "live",
            "rows": [
                {
                    "id": "2026-08-02:123:456",
                    "gameDate": "2026-08-02",
                    "gamePk": 123,
                    "gameStartAt": "2026-08-02T23:00:00+00:00",
                    "batterId": 456,
                    "batterName": "Test Hitter",
                    "odds": {
                        "fanduel": {
                            "americanOdds": 650,
                            "capturedAt": "2026-08-02T21:33:00+00:00",
                        }
                    },
                }
            ],
        }
        client = FakeClient(dashboard)
        checkpoint = datetime(2026, 8, 2, 17, 17, tzinfo=ET)
        with self.assertRaisesRegex(ValueError, "scheduled capture window"):
            fetch_edge_odds(client, date(2026, 8, 2), checkpoint)


if __name__ == "__main__":
    unittest.main()
