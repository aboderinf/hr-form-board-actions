import unittest
from datetime import date

from src.edge_source import parse_edge_payload


class EdgeSourceTests(unittest.TestCase):
    def test_parses_only_persisted_confirmed_prices(self):
        payload = {
            "schemaVersion": 1,
            "date": "2026-08-02",
            "asOf": "2026-08-02T11:17:00-04:00",
            "generatedAt": "2026-08-02T15:12:05Z",
            "latestIngestAt": "2026-08-02T15:12:10Z",
            "status": "live",
            "source": "mlb-hr-edge-database",
            "books": ["fanduel", "draftkings", "betmgm"],
            "rowCount": 1,
            "rows": [
                {
                    "predictionId": "2026-08-02:123",
                    "gameDate": "2026-08-02",
                    "gamePk": 900001,
                    "gameStartAt": "2026-08-02T23:10:00Z",
                    "batterId": 123,
                    "batterName": "José Ramírez Jr.",
                    "batterTeam": "CLE",
                    "matchup": "CLE @ MIN",
                    "lineupPosition": 3,
                    "lineupConfirmed": True,
                    "odds": {
                        "fanduel": {
                            "americanOdds": 650,
                            "capturedAt": "2026-08-02T15:12:01Z",
                            "source": "sportsgameodds",
                            "sourceEventId": "event-1",
                            "sourceOddId": "odd-fd",
                        },
                        "draftkings": {
                            "americanOdds": 700,
                            "capturedAt": "2026-08-02T15:12:02Z",
                            "source": "sportsgameodds",
                            "sourceEventId": "event-1",
                            "sourceOddId": "odd-dk",
                        },
                    },
                }
            ],
        }
        parsed = parse_edge_payload(payload, date(2026, 8, 2))
        self.assertEqual(parsed["source"], "MLB HR Edge")
        self.assertEqual(parsed["as_of"], "2026-08-02T11:17:00-04:00")
        self.assertEqual(len(parsed["players"]), 1)
        player = parsed["players"][0]
        self.assertEqual(player["batter_id"], 123)
        self.assertEqual(player["key"], "joseramirez")
        self.assertEqual(
            {price["book"] for price in player["prices"]},
            {"FanDuel", "DraftKings"},
        )
        dk = next(price for price in player["prices"] if price["book"] == "DraftKings")
        self.assertEqual(dk["odds"], 700)
        self.assertEqual(dk["source_odd_id"], "odd-dk")

    def test_rejects_non_database_fallback(self):
        with self.assertRaisesRegex(ValueError, "not database-backed"):
            parse_edge_payload(
                {
                    "date": "2026-08-02",
                    "status": "live",
                    "source": "sample",
                    "rows": [],
                },
                date(2026, 8, 2),
            )


if __name__ == "__main__":
    unittest.main()
