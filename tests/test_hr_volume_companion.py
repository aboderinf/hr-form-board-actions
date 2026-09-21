from __future__ import annotations

import unittest
from datetime import date

from src.hr_volume_companion import (
    VOLUME_RULE,
    build_combined_portfolio,
    build_hr_volume_companion,
)
from src.hr_picks import select_rule


TARGET = date(2026, 9, 21)


def row(
    player_id,
    score,
    odds,
    *,
    book="DraftKings",
    result="PENDING",
    checkpoint="1717",
    started=False,
):
    if result == "WIN":
        profit = odds / 100.0
    elif result == "LOSS":
        profit = -1.0
    else:
        profit = 0.0
    return {
        "slate_date": TARGET.isoformat(),
        "checkpoint": checkpoint,
        "mlbam_id": player_id,
        "player": f"P{player_id}",
        "team": "TST",
        "rank": player_id,
        "score": score,
        "best_odds": odds,
        "best_book": book,
        "captured_at": "2026-09-21T21:17:00Z",
        "game_start_at": "2026-09-22T00:00:00Z",
        "game_started_at_checkpoint": started,
        "result": result,
        "home_runs": 1 if result == "WIN" else 0 if result in {"LOSS", "VOID"} else None,
        "profit_units": profit,
    }


class HrVolumeCompanionTests(unittest.TestCase):
    def test_fixed_rule_is_expected_companion(self):
        self.assertEqual(VOLUME_RULE["checkpoint"], "1717")
        self.assertEqual(VOLUME_RULE["form_id"], "200p")
        self.assertEqual(VOLUME_RULE["odds_id"], "u400")
        self.assertEqual(VOLUME_RULE["book_id"], "DK")
        self.assertEqual(VOLUME_RULE["top_n"], 10)

    def test_rule_requires_dk_best_below_400_and_score_200_plus(self):
        rows = [
            row(1, 0.40, 350),
            row(2, 0.30, 390),
            row(3, 0.25, 399),
            row(4, 0.19, 350),
            row(5, 0.40, 400),
            row(6, 0.40, 350, book="FanDuel"),
            row(7, 0.40, 350, checkpoint="1117"),
            row(8, 0.40, 350, started=True),
        ]
        selected = select_rule(rows, VOLUME_RULE)
        self.assertEqual([item["mlbam_id"] for item in selected], [1, 2, 3])

    def test_top_ten_cap(self):
        rows = [row(i, 0.50 - i / 1000.0, 350) for i in range(1, 13)]
        selected = select_rule(rows, VOLUME_RULE)
        self.assertEqual(len(selected), 10)
        self.assertEqual([item["mlbam_id"] for item in selected], list(range(1, 11)))

    def test_snapshot_freezes_original_dk_price(self):
        first = build_hr_volume_companion([row(1, 0.30, 350)], TARGET, {})
        self.assertEqual(first["current"]["picks"][0]["odds"], 350)
        self.assertEqual(first["current"]["picks"][0]["book"], "DraftKings")

        second = build_hr_volume_companion(
            [row(1, 0.30, 390, result="WIN")],
            TARGET,
            first,
        )
        pick = second["current"]["picks"][0]
        self.assertEqual(pick["odds"], 350)
        self.assertEqual(pick["book"], "DraftKings")
        self.assertEqual(pick["result"], "WIN")
        self.assertEqual(pick["profit_units"], 3.5)

    def test_combined_portfolio_unions_and_defensively_dedupes(self):
        primary_pick = {
            "slate_date": TARGET.isoformat(),
            "checkpoint": "1717",
            "mlbam_id": 11,
            "player": "Primary",
            "score": 0.15,
            "odds": 450,
            "book": "FanDuel",
            "rank": 1,
            "result": "WIN",
            "profit_units": 4.5,
        }
        companion_pick = {
            "slate_date": TARGET.isoformat(),
            "checkpoint": "1717",
            "mlbam_id": 22,
            "player": "Companion",
            "score": 0.30,
            "odds": 350,
            "book": "DraftKings",
            "rank": 2,
            "result": "LOSS",
            "profit_units": -1.0,
        }
        duplicate = {**companion_pick, "mlbam_id": 11, "player": "Duplicate", "odds": 350}
        primary = {
            "forward": {"snapshots": [{"slate_date": TARGET.isoformat(), "selections": [primary_pick]}]},
            "current": {"slate_date": TARGET.isoformat()},
        }
        companion = {
            "forward": {"snapshots": [{"slate_date": TARGET.isoformat(), "selections": [companion_pick, duplicate]}]},
            "current": {"slate_date": TARGET.isoformat()},
        }
        portfolio = build_combined_portfolio(primary, companion)
        self.assertEqual(portfolio["overlap_deduped"], 1)
        self.assertEqual(portfolio["forward"]["summary"]["bets"], 2)
        self.assertAlmostEqual(portfolio["forward"]["summary"]["net_units"], 3.5)
        self.assertEqual(len(portfolio["current"]["picks"]), 2)


if __name__ == "__main__":
    unittest.main()
