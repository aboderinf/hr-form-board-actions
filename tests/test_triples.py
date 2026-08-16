import unittest
from datetime import date

from src.triples import calculate_triples_form_open_pool, rank_triples_scores


class TriplesFormTests(unittest.TestCase):
    def test_fixed_denominators_and_newest_first_strip(self):
        games = [
            {
                "date": "2026-08-10",
                "gamePk": 1,
                "opponent": "Club A",
                "triples": 1,
                "plateAppearances": 4,
            },
            {
                "date": "2026-08-11",
                "gamePk": 2,
                "opponent": "Club B",
                "triples": 0,
                "plateAppearances": 4,
            },
            {
                "date": "2026-08-12",
                "gamePk": 3,
                "opponent": "Club C",
                "triples": 1,
                "plateAppearances": 3,
            },
        ]

        form = calculate_triples_form_open_pool(games, date(2026, 8, 15))

        self.assertIsNotNone(form)
        self.assertAlmostEqual(form["score"], 0.50 * 2 / 5 + 0.30 * 2 / 7 + 0.20 * 2 / 15)
        self.assertEqual(form["triple_games_l5"], 2)
        self.assertEqual(form["triples_l15"], 2)
        self.assertTrue(form["provisional"])
        self.assertEqual(form["recent_games"][0]["date"], "2026-08-12")
        self.assertTrue(form["recent_games"][0]["triple_game"])

    def test_requires_a_prior_triple_and_ignores_slate_game(self):
        games = [
            {"date": "2026-08-14", "gamePk": 1, "triples": 0, "plateAppearances": 4},
            {"date": "2026-08-15", "gamePk": 2, "triples": 1, "plateAppearances": 4},
        ]
        self.assertIsNone(calculate_triples_form_open_pool(games, date(2026, 8, 15)))

    def test_ranker_uses_recent_windows_before_name(self):
        rows = [
            {
                "player": "Beta Batter",
                "score": 0.1,
                "triple_games_l5": 1,
                "triple_games_l7": 1,
                "triple_games_l15": 1,
                "triples_l15": 1,
                "games_available": 15,
            },
            {
                "player": "Alpha Batter",
                "score": 0.2,
                "triple_games_l5": 2,
                "triple_games_l7": 2,
                "triple_games_l15": 2,
                "triples_l15": 2,
                "games_available": 15,
            },
        ]
        self.assertEqual(rank_triples_scores(rows)[0]["player"], "Alpha Batter")


if __name__ == "__main__":
    unittest.main()
