from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from src.triples_model import (
    FEATURE_NAMES,
    build_feature_row,
    group_statcast_games,
    new_entity_state,
    predict_model_probability,
    predict_probability,
    read_state_parts,
    summarize_pa_rows,
    update_entity,
    write_state_parts,
)


ROOT = Path(__file__).resolve().parents[1]


class TriplesModelTests(unittest.TestCase):
    def test_statcast_rows_are_grouped_without_same_game_feature_leakage(self) -> None:
        header = [
            "game_date",
            "game_pk",
            "events",
            "inning_topbot",
            "away_team",
            "home_team",
            "batter",
            "pitcher",
            "at_bat_number",
            "player_name",
            "stand",
            "p_throws",
            "age_bat",
            "age_pit",
            "hit_location",
            "bb_type",
            "launch_speed",
            "launch_angle",
            "estimated_ba_using_speedangle",
            "estimated_slg_using_speedangle",
            "hit_distance_sc",
        ]
        rows = [
            ["2026-08-01", "123", "triple", "Top", "BOS", "NYY", "10", "20", "1", "Finn Fast", "L", "R", "24", "29", "8", "line_drive", "101", "18", ".800", "1.900", "380"],
            ["2026-08-01", "123", "strikeout", "Top", "BOS", "NYY", "10", "20", "10", "Finn Fast", "L", "R", "24", "29", "", "", "", "", "", "", ""],
            ["2026-08-01", "123", "field_out", "Bot", "BOS", "NYY", "30", "40", "5", "Hank Home", "R", "L", "27", "31", "6", "ground_ball", "83", "-5", ".100", ".100", "90"],
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".csv", newline="", delete=False) as handle:
            handle.write(",".join(header) + "\n")
            for row in rows:
                handle.write(",".join(row) + "\n")
            path = Path(handle.name)
        try:
            games = group_statcast_games(path)["2026-08-01"]
        finally:
            path.unlink(missing_ok=True)
        self.assertEqual(len(games), 1)
        self.assertEqual(games[0]["home_team"], "NYY")
        away = next(side for side in games[0]["sides"] if side["team"] == "BOS")
        self.assertEqual(away["starters"][0]["metrics"]["triple"], 1.0)
        self.assertEqual(away["starters"][0]["metrics"]["pa"], 2.0)

    def test_rolling_state_decays_and_preserves_previous_season(self) -> None:
        entity = new_entity_state()
        first = summarize_pa_rows([{"events": "triple", "hit_location": "8", "bb_type": "line_drive"}])
        update_entity(entity, first, date(2025, 9, 1), last_slot=1)
        update_entity(entity, summarize_pa_rows([{"events": "field_out"}]), date(2026, 4, 1))
        self.assertEqual(entity["previous"]["triple"], 1.0)
        self.assertEqual(entity["season"]["pa"], 1.0)
        self.assertLess(entity["ewma"]["30"]["triple"], 0.02)

    def test_chunked_state_round_trip_and_checksum(self) -> None:
        state = {"as_of": "2026-08-15", "batters": {"1": new_entity_state()}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state-parts"
            write_state_parts(path, state, part_bytes=32)
            self.assertEqual(read_state_parts(path), state)
            part = sorted(path.glob("part-*.bin"))[0]
            part.write_bytes(part.read_bytes() + b"x")
            with self.assertRaisesRegex(ValueError, "checksum"):
                read_state_parts(path)

    def test_exported_model_and_feature_contract(self) -> None:
        artifact = json.loads((ROOT / "data" / "triples-model" / "model.json").read_text())
        features = build_feature_row(None, None, None, {}, date(2026, 8, 16))
        self.assertEqual(tuple(features), FEATURE_NAMES)
        raw = predict_model_probability(artifact, features)
        calibrated = predict_probability(artifact, features)
        self.assertGreater(raw, 0)
        self.assertLess(raw, 0.25)
        self.assertGreater(calibrated, 0)
        self.assertLess(calibrated, 0.25)

    def test_published_model_board_is_current_and_ranked(self) -> None:
        payload = json.loads((ROOT / "data" / "triples-model.json").read_text())
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["sports_game_odds_objects_added"], 0)
        players = payload["players"]
        self.assertGreater(len(players), 100)
        self.assertEqual([row["probability_rank"] for row in players[:10]], list(range(1, 11)))
        self.assertTrue(all(0 < row["predicted_hit_probability"] < 0.25 for row in players))


if __name__ == "__main__":
    unittest.main()
