import unittest
from datetime import date

from src.discovery import profit_units
from src.triples_discovery import (
    build_reports,
    collapse_best,
    long_odds_band,
    summary,
    triples_score_band,
)


def row(day, player_id, checkpoint, odds, result, book="fanduel", score=0.1, rank=10):
    return {
        "slate_date": day,
        "mlbam_id": player_id,
        "checkpoint": checkpoint,
        "best_odds": odds,
        "best_book": book,
        "score": score,
        "rank": rank,
        "result": result,
        "profit_units": profit_units(odds, result),
    }


class TriplesDiscoveryTests(unittest.TestCase):
    def test_collapses_to_best_price_once_per_player_slate(self):
        rows = [
            row("2026-08-07", 1, "1117", 2200, "WIN"),
            row("2026-08-07", 1, "1717", 3500, "WIN", book="draftkings"),
            row("2026-08-07", 2, "1117", 1800, "LOSS"),
        ]
        selected = collapse_best(rows)
        self.assertEqual(len(selected), 2)
        self.assertEqual(selected[0]["best_odds"], 3500)
        self.assertEqual(selected[0]["best_book"], "draftkings")

    def test_summary_reports_flat_unit_profit_and_market_break_even(self):
        stats = summary([
            row("2026-08-07", 1, "1117", 1900, "WIN"),
            row("2026-08-07", 2, "1117", 1900, "LOSS"),
        ])
        self.assertEqual(stats["settled"], 2)
        self.assertEqual(stats["wins"], 1)
        self.assertEqual(stats["net_units"], 18.0)
        self.assertAlmostEqual(stats["roi"], 9.0)
        self.assertAlmostEqual(stats["market_break_even_hit_rate"], 0.05)
        self.assertAlmostEqual(stats["hit_rate_edge"], 0.45)

    def test_triples_specific_bands_are_useful_for_long_prices(self):
        self.assertEqual(long_odds_band(1200), "+1000 to +1499")
        self.assertEqual(long_odds_band(2400), "+2000 to +2999")
        self.assertEqual(long_odds_band(7500), "+5000 or longer")
        self.assertEqual(triples_score_band(None), "No recent-triples score")
        self.assertEqual(triples_score_band(0.16), "0.150–0.199")

    def test_reports_keep_checkpoint_strategies_separate(self):
        rows = [
            row("2026-08-07", 1, "1117", 2000, "WIN"),
            row("2026-08-07", 1, "1717", 3000, "WIN"),
            row("2026-08-07", 2, "1117", 1500, "LOSS"),
        ]
        report = build_reports(rows, date(2026, 8, 7))["all_time"]
        self.assertEqual(report["overall"]["settled"], 2)
        self.assertEqual(report["checkpoint_strategies"][0]["settled"], 2)
        self.assertEqual(report["checkpoint_strategies"][1]["settled"], 1)


if __name__ == "__main__":
    unittest.main()
