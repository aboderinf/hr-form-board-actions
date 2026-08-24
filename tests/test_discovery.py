from __future__ import annotations

import unittest
from datetime import date

from src.discovery import (
    best_price,
    build_reports,
    collapse_best_player_games,
    implied_probability,
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

    def test_implied_probability(self):
        self.assertAlmostEqual(implied_probability(400), 0.20)
        self.assertAlmostEqual(implied_probability(-200), 2 / 3)

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
                "checkpoint": "0817",
                "mlbam_id": 1,
                "player": "A",
                "team": "X",
                "rank": 4,
                "score": 0.42,
                "best_book": "DraftKings",
                "best_odds": 700,
                "result": "WIN",
                "profit_units": 7.0,
            },
            {
                "slate_date": "2026-08-02",
                "checkpoint": "1117",
                "mlbam_id": 2,
                "player": "B",
                "team": "Y",
                "rank": 40,
                "score": 0.21,
                "best_book": "FanDuel",
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
        self.assertIn("checkpoint_strategies", report)
        self.assertIn("checkpoint_details", report)
        self.assertEqual(report["checkpoint_details"]["0817"]["overall"]["settled"], 1)
        self.assertEqual(report["checkpoint_details"]["1117"]["overall"]["settled"], 1)
        self.assertIn("score_odds", report)
        self.assertIn("book_odds_score", report)
        self.assertAlmostEqual(report["overall"]["market_break_even_hit_rate"], (0.125 + (100 / 650)) / 2)

    def test_incomplete_slate_is_excluded_wholesale(self):
        rows = [
            {
                "slate_date": "2026-08-02",
                "checkpoint": "1117",
                "mlbam_id": 1,
                "player": "A",
                "rank": 1,
                "score": 0.2,
                "best_book": "DraftKings",
                "best_odds": 500,
                "result": "WIN",
                "profit_units": 5.0,
            },
            {
                "slate_date": "2026-08-02",
                "checkpoint": "1117",
                "mlbam_id": 2,
                "player": "B",
                "rank": 2,
                "score": 0.19,
                "best_book": "FanDuel",
                "best_odds": 650,
                "result": "PENDING",
                "profit_units": None,
            },
        ]
        report = build_reports(rows, date(2026, 8, 2))["rolling_14d"]
        self.assertEqual(report["overall"]["settled"], 0)
        self.assertEqual(report["excluded_incomplete_slates"], ["2026-08-02"])


if __name__ == "__main__":
    unittest.main()
