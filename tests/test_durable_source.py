from __future__ import annotations

import unittest
from datetime import date, datetime
from zoneinfo import ZoneInfo

from src.durable_source import parse_durable_payload


ET = ZoneInfo("America/New_York")


class DurableSourceTests(unittest.TestCase):
    def test_market_quotes_support_top100_name_matching(self) -> None:
        payload = {
            "date": "2026-08-02",
            "generatedAt": "2026-08-02T21:18:00+00:00",
            "status": "success",
            "predictions": [],
            "marketQuotes": [
                {
                    "playerName": "Test Hitter",
                    "playerKey": "testhitter",
                    "bookmaker": "fanduel",
                    "americanOdds": 650,
                    "capturedAt": "2026-08-02T21:18:00+00:00",
                    "sourceEventId": "event-1",
                    "sourceOddId": "odd-1",
                    "gameStartAt": "2026-08-02T23:00:00+00:00",
                    "homeTeam": "BBB",
                    "awayTeam": "AAA",
                }
            ],
        }
        market = parse_durable_payload(payload, date(2026, 8, 2))
        self.assertEqual(market["market_quote_rows"], 1)
        self.assertEqual(market["players"][0]["key"], "testhitter")
        self.assertIsNone(market["players"][0]["batter_id"])
        self.assertEqual(market["players"][0]["prices"][0]["odds"], 650)

    def test_checkpoint_mode_uses_prediction_linked_rows(self) -> None:
        payload = {
            "date": "2026-08-02",
            "generatedAt": "2026-08-02T21:18:00+00:00",
            "status": "success",
            "predictions": [
                {
                    "gamePk": 123,
                    "gameStartAt": "2026-08-02T23:00:00+00:00",
                    "batterId": 456,
                    "batterName": "Test Hitter",
                    "batterTeam": "AAA",
                    "matchup": "AAA @ BBB",
                    "lineupPosition": 3,
                    "odds": {
                        "draftkings": {
                            "americanOdds": 700,
                            "capturedAt": "2026-08-02T21:18:00+00:00",
                            "sourceEventId": "event-1",
                            "sourceOddId": "odd-2",
                        }
                    },
                }
            ],
            "marketQuotes": [],
        }
        cutoff = datetime(2026, 8, 2, 17, 32, tzinfo=ET)
        market = parse_durable_payload(
            payload,
            date(2026, 8, 2),
            capture_cutoff=cutoff,
            include_market_quotes=False,
        )
        self.assertEqual(market["prediction_rows"], 1)
        self.assertEqual(market["players"][0]["batter_id"], 456)
        self.assertEqual(market["players"][0]["prices"][0]["odds"], 700)

    def test_rejects_payload_after_capture_window(self) -> None:
        payload = {
            "date": "2026-08-02",
            "generatedAt": "2026-08-02T21:33:00+00:00",
            "predictions": [],
            "marketQuotes": [],
        }
        cutoff = datetime(2026, 8, 2, 17, 32, tzinfo=ET)
        with self.assertRaisesRegex(ValueError, "after the scheduled capture window"):
            parse_durable_payload(
                payload,
                date(2026, 8, 2),
                capture_cutoff=cutoff,
            )


if __name__ == "__main__":
    unittest.main()
