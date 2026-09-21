from __future__ import annotations

import unittest
from datetime import date, timedelta

from src.hr_companion import build_hr_companion, qualifying_cells


TARGET = date(2026, 9, 21)


def hist_row(day, checkpoint, player_id, result, *, score=0.15, odds=500):
    profit = odds / 100.0 if result == "WIN" else -1.0
    return {
        "slate_date": day.isoformat(),
        "checkpoint": checkpoint,
        "mlbam_id": player_id,
        "player": f"H{checkpoint}-{player_id}",
        "rank": player_id,
        "score": score,
        "best_odds": odds,
        "best_book": "DraftKings",
        "captured_at": f"{day.isoformat()}T12:17:00Z",
        "game_start_at": f"{day.isoformat()}T23:00:00Z",
        "game_started_at_checkpoint": False,
        "result": result,
        "profit_units": profit,
    }


def qualifying_history(checkpoints=("0817",)):
    rows = []
    # 50 settled bets per checkpoint over five prior slates; 10 wins at +500.
    # Net = +10u, clearing all-history/30d/14d and parent-support gates.
    for offset in range(5, 0, -1):
        day = TARGET - timedelta(days=offset)
        for checkpoint in checkpoints:
            for i in range(10):
                rows.append(hist_row(day, checkpoint, offset * 100 + i, "WIN" if i < 2 else "LOSS"))
    return rows


def today_row(player_id, checkpoint="0817", *, result="PENDING", odds=500, score=0.15):
    return {
        "slate_date": TARGET.isoformat(),
        "checkpoint": checkpoint,
        "mlbam_id": player_id,
        "player": f"P{player_id}",
        "rank": player_id,
        "score": score,
        "best_odds": odds,
        "best_book": "FanDuel",
        "captured_at": "2026-09-21T12:17:00Z" if checkpoint == "0817" else "2026-09-21T15:17:00Z",
        "game_start_at": "2026-09-21T23:00:00Z",
        "game_started_at_checkpoint": False,
        "result": result,
        "home_runs": 1 if result == "WIN" else None,
        "profit_units": odds / 100.0 if result == "WIN" else None,
    }


class HrCompanionTests(unittest.TestCase):
    def test_prior_settled_only_controls_qualification(self):
        rows = qualifying_history()
        cells = qualifying_cells(rows, TARGET, "0817")
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]["form_id"], "100_199")
        self.assertEqual(cells[0]["odds_id"], "500_599")

    def test_current_slate_cannot_create_its_own_evidence(self):
        rows = qualifying_history()
        rows = rows[:39]
        rows.append(today_row(999, result="WIN"))
        self.assertEqual(qualifying_cells(rows, TARGET, "0817"), [])

    def test_companion_has_no_pick_cap(self):
        rows = qualifying_history()
        rows.extend(today_row(1000 + i) for i in range(12))
        built = build_hr_companion(rows, TARGET, {})
        self.assertEqual(len(built["current"]["picks"]), 12)

    def test_first_qualifying_checkpoint_freezes_duplicate_player(self):
        rows = qualifying_history(("0817", "1117"))
        rows.extend([
            today_row(777, "0817", odds=500),
            today_row(777, "1117", odds=550),
        ])
        built = build_hr_companion(rows, TARGET, {})
        picks = built["current"]["picks"]
        self.assertEqual(len(picks), 1)
        self.assertEqual(picks[0]["checkpoint"], "0817")
        self.assertEqual(picks[0]["odds"], 500)
        self.assertEqual(picks[0]["book"], "FanDuel")

    def test_existing_snapshot_keeps_frozen_price_when_settled(self):
        rows = qualifying_history()
        rows.append(today_row(888, "0817", result="PENDING", odds=500))
        first = build_hr_companion(rows, TARGET, {})
        self.assertEqual(first["current"]["picks"][0]["odds"], 500)

        settled = qualifying_history()
        settled.append(today_row(888, "0817", result="WIN", odds=900))
        second = build_hr_companion(settled, TARGET, first)
        pick = second["current"]["picks"][0]
        self.assertEqual(pick["odds"], 500)
        self.assertEqual(pick["result"], "WIN")
        self.assertEqual(pick["profit_units"], 5.0)


if __name__ == "__main__":
    unittest.main()
