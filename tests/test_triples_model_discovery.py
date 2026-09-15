import unittest
from datetime import date

from src.discovery import profit_units
from src.triples_model_discovery import (
    build_daily_archive,
    build_reports,
    select_checkpoint_policies,
)


def prediction(player_id, game_pk, probability, rank):
    return {
        "player": f"Player {player_id}",
        "mlbam_id": player_id,
        "game_pk": game_pk,
        "game_start_at": "2026-08-16T23:00:00Z",
        "predicted_hit_probability": probability,
        "model_rank_score": probability + 0.001,
        "probability_rank": rank,
        "fair_american_odds": round(100 * (1 - probability) / probability),
    }


def quote(player_id, game_pk, checkpoint, odds, result="LOSS"):
    return {
        "slate_date": "2026-08-16",
        "checkpoint": checkpoint,
        "captured_at": {
            "0817": "2026-08-16T12:17:00Z",
            "1117": "2026-08-16T15:17:00Z",
            "1717": "2026-08-16T21:17:00Z",
        }[checkpoint],
        "game_pk": game_pk,
        "game_start_at": "2026-08-16T23:00:00Z",
        "matchup": "AAA @ BBB",
        "player": f"Player {player_id}",
        "mlbam_id": player_id,
        "best_book": "fanduel",
        "best_odds": odds,
        "result": result,
        "triples": 1 if result == "WIN" else 0,
        "plate_appearances": 4,
        "profit_units": profit_units(odds, result),
    }


class TriplesModelDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.board = {
            "status": "ready",
            "slate_date": "2026-08-16",
            "generated_at": "2026-08-16T10:00:00Z",
            "sports_game_odds_objects_added": 0,
            "players": [
                prediction(1, 101, 0.08, 1),
                prediction(2, 102, 0.06, 2),
                prediction(3, 103, 0.05, 3),
                prediction(4, 104, 0.04, 4),
                prediction(5, 105, 0.03, 5),
                prediction(6, 106, 0.02, 6),
            ],
        }

    def test_hit_policy_ignores_price_and_takes_top_five_probabilities(self):
        rows = [
            quote(1, 101, "0817", 800),
            quote(2, 102, "0817", 1200),
            quote(3, 103, "0817", 1800),
            quote(4, 104, "0817", 2400),
            quote(5, 105, "0817", 4000),
            quote(6, 106, "0817", 10000),
        ]
        selected = select_checkpoint_policies(self.board, rows)
        self.assertEqual([row["mlbam_id"] for row in selected["hit_probability"]], [1, 2, 3, 4, 5])

    def test_value_policy_applies_edge_and_roi_gate_then_ranks_expected_roi(self):
        rows = [
            quote(1, 101, "0817", 2000),
            quote(2, 102, "0817", 1000),
            quote(3, 103, "0817", 4000),
        ]
        selected = select_checkpoint_policies(self.board, rows)
        self.assertEqual([row["mlbam_id"] for row in selected["positive_ev"]], [3, 1])
        self.assertGreater(selected["positive_ev"][0]["expected_roi"], selected["positive_ev"][1]["expected_roi"])

    def test_prediction_created_after_checkpoint_is_not_backfilled(self):
        board = {**self.board, "generated_at": "2026-08-16T13:00:00Z"}
        selected = select_checkpoint_policies(board, [quote(1, 101, "0817", 2000)])
        self.assertEqual(selected["status"], "model_not_available_at_checkpoint")
        self.assertEqual(selected["hit_probability"], [])

    def test_started_games_are_excluded(self):
        row = quote(1, 101, "1717", 2000)
        row["game_start_at"] = "2026-08-16T20:00:00Z"
        selected = select_checkpoint_policies(self.board, [row])
        self.assertEqual(selected["status"], "no_model_price_matches")
        self.assertEqual(selected["post_start_rows_excluded"], 1)

    def test_reports_keep_checkpoints_and_policies_separate(self):
        rows = [
            quote(1, 101, "0817", 2000, "WIN"),
            quote(2, 102, "0817", 1000, "LOSS"),
            quote(1, 101, "1117", 3000, "WIN"),
        ]
        archive = build_daily_archive(self.board, rows, source="test")
        report = build_reports([archive], date(2026, 8, 16))["all_time"]
        by_checkpoint = {row["label"]: row for row in report["checkpoints"]}
        self.assertEqual(by_checkpoint["0817"]["hit_probability"]["bets"], 2)
        self.assertEqual(by_checkpoint["1117"]["hit_probability"]["bets"], 1)
        self.assertEqual(by_checkpoint["1717"]["hit_probability"]["bets"], 0)
        self.assertEqual(by_checkpoint["0817"]["hit_probability"]["net_units"], 19.0)


if __name__ == "__main__":
    unittest.main()
