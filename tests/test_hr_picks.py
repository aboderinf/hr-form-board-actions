from __future__ import annotations

import unittest

from src.hr_picks import (
    _promotion_pass,
    pregame_eligible,
    select_rule,
    strategy_summary,
)


RULE = {
    "checkpoint": "1717",
    "form_id": "100_199",
    "form_label": "0.100–0.199",
    "odds_id": "400_499",
    "odds_label": "+400–499",
    "book_id": "all",
    "book_label": "Any best-price book",
    "top_n": 3,
    "rule_id": "test-rule",
    "label": "test",
}


def row(player_id, score, odds, result="LOSS", *, started=False, captured="2026-09-21T21:17:00Z", game="2026-09-22T00:00:00Z"):
    profit = -1.0
    if result == "WIN":
        profit = odds / 100.0
    elif result == "VOID":
        profit = 0.0
    return {
        "slate_date": "2026-09-21",
        "checkpoint": "1717",
        "mlbam_id": player_id,
        "player": f"P{player_id}",
        "rank": player_id,
        "score": score,
        "best_odds": odds,
        "best_book": "DraftKings",
        "captured_at": captured,
        "game_start_at": game,
        "game_started_at_checkpoint": started,
        "result": result,
        "profit_units": profit,
    }


class HrPicksTests(unittest.TestCase):
    def test_rule_selection_is_pregame_and_top_n(self):
        rows = [
            row(1, 0.19, 420),
            row(2, 0.18, 480),
            row(3, 0.17, 450),
            row(4, 0.16, 470),
            row(5, 0.21, 450),
            row(6, 0.15, 510),
            row(7, 0.199, 440, started=True),
        ]
        selected = select_rule(rows, RULE)
        self.assertEqual([item["mlbam_id"] for item in selected], [1, 2, 3])

    def test_capture_after_game_start_is_not_executable(self):
        late = row(
            1,
            0.15,
            450,
            captured="2026-09-22T00:30:00Z",
            game="2026-09-22T00:00:00Z",
        )
        self.assertFalse(pregame_eligible(late))

    def test_strategy_summary_uses_flat_one_unit(self):
        values = [
            row(1, 0.19, 400, "WIN"),
            row(2, 0.18, 450, "LOSS"),
            row(3, 0.17, 450, "VOID"),
        ]
        summary = strategy_summary(values)
        self.assertEqual(summary["bets"], 2)
        self.assertEqual(summary["wins"], 1)
        self.assertEqual(summary["losses"], 1)
        self.assertEqual(summary["voids"], 1)
        self.assertAlmostEqual(summary["net_units"], 3.0)
        self.assertAlmostEqual(summary["roi"], 1.5)

    def test_promotion_gate_matches_two_plus_bases_standard(self):
        passing = {"bets": 20, "slates": 5, "roi": 0.01, "profitable_slates": 3}
        failing = {"bets": 19, "slates": 5, "roi": 1.0, "profitable_slates": 5}
        self.assertTrue(_promotion_pass(passing))
        self.assertFalse(_promotion_pass(failing))


if __name__ == "__main__":
    unittest.main()
