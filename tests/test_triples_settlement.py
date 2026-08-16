import unittest

from src.triples_settlement import (
    best_archived_quote,
    map_event_game,
    player_indexes,
    resolve_player_id,
    settle_player_game,
    team_code_index,
)


class TriplesSettlementTests(unittest.TestCase):
    def test_maps_exact_matchup_and_doubleheader_start(self):
        teams = [
            {"id": 1, "abbreviation": "NYM"},
            {"id": 2, "abbreviation": "PIT"},
        ]
        games = [
            {"game_pk": 10, "game_date": "2026-08-07T17:05:00Z", "away_team_id": 1, "home_team_id": 2},
            {"game_pk": 11, "game_date": "2026-08-07T22:40:00Z", "away_team_id": 1, "home_team_id": 2},
        ]
        row = {"matchup": "NYM @ PIT", "gameStartAt": "2026-08-07T22:40:00.000Z"}
        self.assertEqual(map_event_game(row, games, team_code_index(teams))["game_pk"], 11)

    def test_resolves_initial_and_last_name_with_game(self):
        pool = [
            {"mlbam_id": 1, "player": "J.P. Crawford"},
            {"mlbam_id": 2, "player": "James Crawford"},
        ]
        exact, short = player_indexes(pool)
        logs = {1: [{"gamePk": 99}], 2: [{"gamePk": 88}]}
        self.assertEqual(resolve_player_id("J Crawford", 99, exact, short, logs), 1)

    def test_resolves_provider_names_that_drop_punctuation(self):
        pool = [
            {"mlbam_id": 3, "player": "Pete Crow-Armstrong"},
            {"mlbam_id": 4, "player": "Tyler O'Neill"},
        ]
        exact, short = player_indexes(pool)
        self.assertEqual(resolve_player_id("Pete Crowarmstrong", 1, exact, short, {}), 3)
        self.assertEqual(resolve_player_id("Tyler Oneill", 1, exact, short, {}), 4)

    def test_settles_only_final_games_and_voids_no_appearance(self):
        games = [{"gamePk": 7, "triples": 1, "plateAppearances": 4}]
        self.assertEqual(settle_player_game(games, 7, "Final", "Final")[0], "WIN")
        self.assertEqual(settle_player_game(games, 7, "Live", "In Progress")[0], "PENDING")
        self.assertEqual(settle_player_game([], 7, "Final", "Final")[0], "VOID")

    def test_picks_highest_available_price(self):
        quote = best_archived_quote({
            "draftkings": {"americanOdds": 2200},
            "fanduel": {"americanOdds": 5000},
        })
        self.assertEqual(quote, {"book": "fanduel", "odds": 5000})


if __name__ == "__main__":
    unittest.main()
