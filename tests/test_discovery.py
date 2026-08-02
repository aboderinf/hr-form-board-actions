from __future__ import annotations

import unittest
from datetime import date

from src.discovery import (
    best_price,
    build_reports,
    collapse_best_player_games,
    odds_band,
    profit_units,
)


class DiscoveryTests(unittest.TestCase):
    def test_best_price_uses_highest_decimal_return(self):
        prices = [
            {"book": "FanDuel", "odds": 650},
            {"book": "DraftKings", "odds": 700},
            {"book": "BetMGM", "odds": 675},
        ]
        self.assertEqual(best_price(prices)["book"], "DraftKings")

    def test_profit_units(self):
        self.assertAlmostEqual(profit_units(700, "WIN"), 7.0)
        self.assertAlmostEqual(profit_units(700, "LOSS"), -1.0)
        self.assertAlmostEqual(profit_units(700, "VOID"), 0.0)
        self.assertIsNone(profit_units(None, "WIN"))

    def test_intraday_captures_collapse_to_best_player_game_price(self):
        rows = [
            {"slate_date": "2026-08-02", "mlbam_id": 1, "best_odds": 600, "rank": 5, "player": "A"},
            {"slate_date": "2026-08-02", "mlbam_id": 1, "best_odds": 750, "rank": 5, "player": "A"},
            {"slate_date": "2026-08-02", "mlbam_id": 2, "best_odds": None, "rank": 7, "player": "B"},
        ]
        collapsed = collapse_best_player_games(rows)
        self.assertEqual(len(collapsed), 1)
        self.assertEqual(collapsed[0]["best_odds"], 750)

    def test_reports_group_odds_and_keep_sample_size(self):
        rows = [
            {
                "slate_date": "2026-08-01",
                "mlbam_id": 1,
                "player": "A",
                "team": "X",
                "rank": 4,
                "score": 0.42,
                "best_odds": 700,
                "result": "WIN",
                "profit_units": 7.0,
            },
            {
                "slate_date": "2026-08-02",
                "mlbam_id": 2,
                "player": "B",
                "team": "Y",
                "rank": 40,
                "score": 0.21,
                "best_odds": 550,
                "result": "LOSS",
                "profit_units": -1.0,
            },
        ]
        report = build_reports(rows, date(2026, 8, 2))["rolling_14d"]
        self.assertEqual(report["overall"]["settled"], 2)
        self.assertAlmostEqual(report["overall"]["net_units"], 6.0)
        labels = {row["label"] for row in report["odds_bands"]}
        self.assertIn("+500 to +599", labels)
        self.assertIn("+600 to +799", labels)
        self.assertEqual(odds_band(1000), "+1000 or longer")


if __name__ == "__main__":
    unittest.main()
