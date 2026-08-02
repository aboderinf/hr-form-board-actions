import unittest
from datetime import date

from src.edge_source import parse_edge_payload


def sample_payload() -> dict:
    return {
        "schemaVersion": 2,
        "date": "2026-08-02",
        "asOf": "2026-08-02T11:32:00-04:00",
        "generatedAt": "2026-08-02T15:18:05Z",
        "latestIngestAt": "2026-08-02T15:18:10Z",
        "status": "live",
        "source": "mlb-hr-edge-database",
        "books": ["fanduel", "draftkings", "betmgm"],
        "rowCount": 1,
        "quoteCount": 2,
        "archivedCallCount": 4,
        "providerCallId": "2026-08-02:call-1117",
        "providerResponseSha256": "a" * 64,
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
                "playerKey": "jose ramirez",
                "sourceEventId": "event-1",
                "odds": {
                    "fanduel": {
                        "americanOdds": 650,
                        "capturedAt": "2026-08-02T15:18:01Z",
                        "source": "sportsgameodds-archive",
                        "sourceEventId": "event-1",
                        "sourceOddId": "odd-fd",
                        "callId": "2026-08-02:call-1117",
                    },
                    "draftkings": {
                        "americanOdds": 700,
                        "capturedAt": "2026-08-02T15:18:02Z",
                        "source": "sportsgameodds-archive",
                        "sourceEventId": "event-1",
                        "sourceOddId": "odd-dk",
                        "callId": "2026-08-02:call-1117",
                    },
                },
            }
        ],
    }


class EdgeSourceTests(unittest.TestCase):
    def test_parses_archived_confirmed_prices_and_call_provenance(self):
        parsed = parse_edge_payload(sample_payload(), date(2026, 8, 2))
        self.assertEqual(parsed["source"], "MLB HR Edge")
        self.assertEqual(parsed["provider_call_id"], "2026-08-02:call-1117")
        self.assertEqual(parsed["provider_response_sha256"], "a" * 64)
        self.assertEqual(parsed["archived_call_count"], 4)
        self.assertEqual(parsed["quote_count"], 2)
        self.assertEqual(len(parsed["players"]), 1)
        player = parsed["players"][0]
        self.assertEqual(player["batter_id"], 123)
        self.assertEqual(player["key"], "jose ramirez")
        dk = next(price for price in player["prices"] if price["book"] == "DraftKings")
        self.assertEqual(dk["odds"], 700)
        self.assertEqual(dk["source_odd_id"], "odd-dk")
        self.assertEqual(dk["provider_call_id"], "2026-08-02:call-1117")

    def test_top100_can_use_unmatched_pre_lineup_archive_row(self):
        payload = sample_payload()
        row = payload["rows"][0]
        row.update(
            {
                "predictionId": None,
                "batterId": None,
                "batterTeam": None,
                "lineupPosition": None,
                "lineupConfirmed": False,
            }
        )
        parsed = parse_edge_payload(
            payload,
            date(2026, 8, 2),
            enforce_checkpoint_age=False,
            require_confirmed_lineup=False,
        )
        self.assertEqual(len(parsed["players"]), 1)
        self.assertIsNone(parsed["players"][0]["batter_id"])
        self.assertFalse(parsed["players"][0]["lineup_confirmed"])

    def test_checkpoint_rejects_unconfirmed_archive_row(self):
        payload = sample_payload()
        payload["rows"][0]["lineupConfirmed"] = False
        payload["rows"][0]["batterId"] = None
        parsed = parse_edge_payload(payload, date(2026, 8, 2))
        self.assertEqual(parsed["players"], [])

    def test_rejects_non_database_fallback(self):
        with self.assertRaisesRegex(ValueError, "not database-backed"):
            parse_edge_payload(
                {"date": "2026-08-02", "status": "live", "source": "sample", "rows": []},
                date(2026, 8, 2),
            )

    def test_rejects_stale_shared_snapshot(self):
        payload = sample_payload()
        payload["generatedAt"] = "2026-08-02T13:00:00Z"
        with self.assertRaisesRegex(ValueError, "stale"):
            parse_edge_payload(payload, date(2026, 8, 2))

    def test_rejects_price_snapshot_after_source_window(self):
        payload = sample_payload()
        payload["generatedAt"] = "2026-08-02T15:33:00Z"
        with self.assertRaisesRegex(ValueError, "after the allowed source window"):
            parse_edge_payload(payload, date(2026, 8, 2))


if __name__ == "__main__":
    unittest.main()
