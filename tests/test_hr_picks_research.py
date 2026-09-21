import unittest
from datetime import date, timedelta

from src.hr_picks_research import build_hr_picks_research


def make_rows(per_day: int) -> list[dict]:
    rows = []
    start = date(2026, 7, 20)
    for offset in range(48):
        slate = (start + timedelta(days=offset)).isoformat()
        for idx in range(per_day):
            rows.append({
                "slate_date": slate,
                "checkpoint": "1717",
                "player": f"Player {idx}",
                "mlbam_id": 1000 + idx,
                "rank": idx + 1,
                "score": 0.15 + 0.001 * idx,
                "best_book": "DraftKings",
                "best_odds": 450,
                "game_start_at": f"{slate}T23:00:00Z",
                "result": "WIN",
                "profit_units": 4.5,
            })
    return rows


class HrPicksResearchTests(unittest.TestCase):
    def test_positive_holdout_is_not_promoted_without_minimum_bets(self):
        result = build_hr_picks_research(make_rows(1), date(2026, 9, 21))
        self.assertEqual(result["status"], "hold")
        self.assertFalse(result["promoted"])
        self.assertIsNotNone(result["winner"])
        self.assertEqual(result["winner"]["rule"]["checkpoint"], "1717")
        self.assertEqual(result["winner"]["holdout"]["bets"], 14)
        self.assertFalse(result["holdout_pass"])

    def test_promotes_only_after_holdout_gate_is_met(self):
        result = build_hr_picks_research(make_rows(2), date(2026, 9, 21))
        self.assertEqual(result["status"], "promoted")
        self.assertTrue(result["promoted"])
        self.assertGreaterEqual(result["winner"]["holdout"]["bets"], 20)
        self.assertGreaterEqual(result["winner"]["holdout"]["profitable_slates"], 3)
        self.assertGreater(result["winner"]["holdout"]["roi"], 0)


if __name__ == "__main__":
    unittest.main()
