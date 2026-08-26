import unittest
from datetime import date

from src.total_bases_model import (
    FEATURE_NAMES,
    build_feature_row,
    form_probability,
    game_total_bases,
    target_two_plus,
    vectorize,
)
from src.triples_model import new_entity_state, update_entity


class TotalBasesModelV2Tests(unittest.TestCase):
    def test_target_is_game_total_bases(self):
        self.assertEqual(game_total_bases({"single": 2}), 2)
        self.assertEqual(game_total_bases({"double": 1}), 2)
        self.assertEqual(game_total_bases({"triple": 1}), 3)
        self.assertEqual(game_total_bases({"home_run": 1}), 4)
        self.assertEqual(target_two_plus({"single": 1}), 0)
        self.assertEqual(target_two_plus({"single": 2}), 1)
        self.assertEqual(target_two_plus({"double": 1}), 1)

    def test_form_uses_prior_history_only(self):
        cold = form_probability([0, 0, 0, 0, 0], 0.34)
        hot = form_probability([1, 1, 1, 1, 1], 0.34)
        self.assertLess(cold, hot)
        self.assertGreater(hot, 0.34)

    def test_feature_vector_has_total_bases_and_statcast_context(self):
        batter = new_entity_state()
        update_entity(
            batter,
            {
                "games": 1, "pa": 4, "single": 1, "double": 1, "triple": 0,
                "home_run": 0, "walk": 0, "strikeout": 1, "bip": 3,
                "line_drive": 1, "fly_ball": 1, "ground_ball": 1,
                "hard_hit": 2, "ev_sum": 270, "ev_n": 3, "la_sum": 36,
                "la_n": 3, "xba_sum": 0.9, "xslg_sum": 1.5, "xmetric_n": 3,
            },
            date(2026, 8, 1),
            stand="L", last_slot=2, age=27,
        )
        features = build_feature_row(
            batter, None, None,
            {
                "park": {"hit_factor": 101, "double_factor": 103, "hr_factor": 99},
                "weather": {"temperature_f": 82, "wind_speed_mph": 8, "wind_out_mph": 4},
                "venue": {}, "is_home": True, "pitcher_throws": "R", "local_hour": 19,
            },
            date(2026, 8, 2),
        )
        self.assertEqual(set(features), set(FEATURE_NAMES))
        self.assertEqual(len(vectorize(features)), len(FEATURE_NAMES))
        self.assertGreater(features["b_tb_pa_30"], 0)
        self.assertGreater(features["b_xslg_30"], 0)
        self.assertEqual(features["park_double_factor"], 103.0)
        self.assertEqual(features["is_home"], 1.0)


if __name__ == "__main__":
    unittest.main()
