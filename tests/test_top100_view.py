import unittest
from datetime import date

from src.top100_view import attach_market_data, compact_recent_games


class Top100ViewTests(unittest.TestCase):
    def test_compact_recent_games_preserves_newest_first(self):
        games = [
            {
                "date": "2026-08-01",
                "gamePk": 1,
                "opponent": "Boston Red Sox",
                "homeRuns": 2,
                "plateAppearances": 5,
            },
            {
                "date": "2026-07-31",
                "gamePk": 2,
                "opponent": "Baltimore Orioles",
                "homeRuns": 0,
                "plateAppearances": 4,
            },
        ]
        compact = compact_recent_games(games)
        self.assertEqual(compact[0]["date"], "2026-08-01")
        self.assertTrue(compact[0]["hr_game"])
        self.assertEqual(compact[0]["home_runs"], 2)
        self.assertFalse(compact[1]["hr_game"])

    def test_attach_market_data_uses_id_and_best_price(self):
        players = [
            {
                "player": "Test Hitter",
                "mlbam_id": 123,
                "recent_games": [],
            }
        ]
        edge = {
            "source_date": "2026-08-02",
            "status": "live",
            "generated_at": "2026-08-02T15:17:00-04:00",
            "books": ["FanDuel", "DraftKings", "BetMGM"],
            "players": [
                {
                    "batter_id": 123,
                    "name": "Test Hitter",
                    "game_pk": 999,
                    "game_start_at": "2026-08-02T23:05:00Z",
                    "matchup": "BOS @ NYY",
                    "prices": [
                        {"book": "DraftKings", "odds": 550, "captured_at": "a"},
                        {"book": "FanDuel", "odds": 650, "captured_at": "b"},
                    ],
                }
            ],
        }
        metadata = attach_market_data(players, edge, date(2026, 8, 2))
        self.assertEqual(metadata["priced_players"], 1)
        self.assertEqual(metadata["coverage"], 1.0)
        self.assertEqual(players[0]["best_odds"], 650)
        self.assertEqual(players[0]["best_book"], "FanDuel")
        self.assertEqual(players[0]["game_pk"], 999)

    def test_wrong_slate_does_not_attach_prices(self):
        players = [{"player": "Test Hitter", "mlbam_id": 123, "recent_games": []}]
        metadata = attach_market_data(
            players,
            {"source_date": "2026-08-01", "players": []},
            date(2026, 8, 2),
        )
        self.assertFalse(metadata["same_slate"])
        self.assertFalse(players[0]["odds_available"])
        self.assertIsNone(players[0]["best_odds"])


if __name__ == "__main__":
    unittest.main()
