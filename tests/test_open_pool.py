from datetime import date
import unittest

from src.model import calculate_form_open_pool, rank_form_scores


class OpenPoolFormTests(unittest.TestCase):
    def test_new_hitter_uses_fixed_denominators(self):
        games = [
            {
                "date": "2026-07-30",
                "gamePk": 1,
                "plateAppearances": 4,
                "homeRuns": 1,
            },
            {
                "date": "2026-07-31",
                "gamePk": 2,
                "plateAppearances": 4,
                "homeRuns": 1,
            },
        ]
        form = calculate_form_open_pool(games, date(2026, 8, 2))
        self.assertIsNotNone(form)
        self.assertTrue(form["provisional"])
        self.assertEqual(form["games_available"], 2)
        expected = 0.50 * 2 / 5 + 0.30 * 2 / 7 + 0.20 * 2 / 15
        self.assertAlmostEqual(form["score"], expected)

    def test_player_without_recent_hr_is_not_in_form(self):
        games = [
            {
                "date": "2026-07-31",
                "gamePk": 3,
                "plateAppearances": 3,
                "homeRuns": 0,
            }
        ]
        self.assertIsNone(calculate_form_open_pool(games, date(2026, 8, 2)))

    def test_ranking_does_not_require_odds(self):
        rows = [
            {
                "player": "New Player",
                "score": 0.30,
                "hr_games_l5": 2,
                "hr_games_l7": 2,
                "hr_games_l15": 2,
                "home_runs_l15": 2,
                "games_available": 2,
            },
            {
                "player": "Veteran Player",
                "score": 0.25,
                "hr_games_l5": 2,
                "hr_games_l7": 2,
                "hr_games_l15": 3,
                "home_runs_l15": 3,
                "games_available": 15,
            },
        ]
        self.assertEqual(rank_form_scores(rows)[0]["player"], "New Player")


if __name__ == "__main__":
    unittest.main()
