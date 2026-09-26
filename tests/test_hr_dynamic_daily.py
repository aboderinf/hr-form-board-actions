from __future__ import annotations

import unittest
from datetime import date, timedelta

from src.hr_dynamic_daily import (
    MAX_PICKS_PER_CHECKPOINT,
    build_hr_dynamic_daily,
    qualifying_cells,
    select_checkpoint,
)


TARGET = date(2026, 9, 26)


def hist_row(day, checkpoint, player_id, result, *, score=0.25, odds=500, book="DraftKings"):
    profit = odds / 100.0 if result == "WIN" else -1.0
    return {
        "slate_date": day.isoformat(),
        "checkpoint": checkpoint,
        "mlbam_id": player_id,
        "player": f"H{checkpoint}-{player_id}",
        "rank": player_id,
        "score": score,
        "best_odds": odds,
        "best_book": book,
        "game_start_at": f"{day.isoformat()}T23:00:00Z",
        "result": result,
        "profit_units": profit,
    }


def strong_history(checkpoint="0817", *, score=0.25, book="DraftKings", odds=500):
    rows = []
    # 50 bets over 10 prior slates. Two wins per slate at +500:
    # +2u per slate, +20u overall, and enough volume in the recent windows.
    for offset in range(10, 0, -1):
        day = TARGET - timedelta(days=offset)
        for i in range(5):
            rows.append(
                hist_row(
                    day,
                    checkpoint,
                    offset * 100 + i,
                    "WIN" if i < 2 else "LOSS",
                    score=score,
                    odds=odds,
                    book=book,
                )
            )
    return rows


def today_row(player_id, checkpoint="0817", *, score=0.25, odds=500, book="DraftKings", result="PENDING"):
    return {
        "slate_date": TARGET.isoformat(),
        "checkpoint": checkpoint,
        "mlbam_id": player_id,
        "player": f"P{player_id}",
        "rank": player_id,
        "score": score,
        "best_odds": odds,
        "best_book": book,
        "game_start_at": "2026-09-26T23:00:00Z",
        "result": result,
        "profit_units": odds / 100.0 if result == "WIN" else None,
        "home_runs": 1 if result == "WIN" else None,
    }


class HrDynamicDailyTests(unittest.TestCase):
    def test_cell_requires_all_history_recent_and_month_support(self):
        rows = strong_history()
        cells = qualifying_cells(rows, TARGET, "0817")
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]["book"], "DraftKings")
        self.assertEqual(cells[0]["form_id"], "200_299")

    def test_current_slate_cannot_create_its_own_evidence(self):
        rows = strong_history()[:39]
        rows.append(today_row(999, result="WIN"))
        self.assertEqual(qualifying_cells(rows, TARGET, "0817"), [])

    def test_checkpoint_caps_players_at_two(self):
        rows = strong_history()
        rows.extend([
            today_row(1001, score=0.29, odds=500),
            today_row(1002, score=0.28, odds=550),
            today_row(1003, score=0.27, odds=600),
        ])
        cells, picks = select_checkpoint(rows, TARGET, "0817", set(), freeze=True)
        self.assertTrue(cells)
        self.assertEqual(len(picks), MAX_PICKS_PER_CHECKPOINT)
        self.assertEqual([pick["mlbam_id"] for pick in picks], [1001, 1002])

    def test_first_checkpoint_freezes_duplicate_player(self):
        rows = strong_history("0817") + strong_history("1117")
        rows.extend([
            today_row(777, "0817", odds=500),
            today_row(777, "1117", odds=700),
        ])
        built = build_hr_dynamic_daily(rows, TARGET, {})
        picks = built["current"]["picks"]
        self.assertEqual(len(picks), 1)
        self.assertEqual(picks[0]["checkpoint"], "0817")
        self.assertEqual(picks[0]["odds"], 500)

    def test_existing_forward_price_is_immutable_when_graded(self):
        rows = strong_history()
        rows.append(today_row(888, odds=500))
        first = build_hr_dynamic_daily(rows, TARGET, {})
        self.assertEqual(first["current"]["picks"][0]["odds"], 500)

        settled = strong_history()
        settled.append(today_row(888, odds=900, result="WIN"))
        second = build_hr_dynamic_daily(settled, TARGET, first)
        pick = second["current"]["picks"][0]
        self.assertEqual(pick["odds"], 500)
        self.assertEqual(pick["result"], "WIN")
        self.assertEqual(pick["profit_units"], 5.0)


if __name__ == "__main__":
    unittest.main()
