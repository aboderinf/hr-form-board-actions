from datetime import date
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.player_ids import hydrate_mlbam_ids


ROOT = Path(__file__).resolve().parents[1]


def load_refresh_script():
    path = ROOT / "scripts" / "refresh_latest.py"
    spec = importlib.util.spec_from_file_location("refresh_latest", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


refresh_latest = load_refresh_script()


class PlayerIdHydrationTests(unittest.TestCase):
    @patch("src.player_ids.season_hitter_pool")
    def test_missing_ids_are_resolved_and_unresolved_rows_are_removed(self, pool):
        pool.return_value = [
            {"player": "Ben Rice", "mlbam_id": 700001},
            {"player": "Known Hitter", "mlbam_id": 700002},
        ]
        market = {
            "players": [
                {"name": "Already Known", "batter_id": "600001"},
                {"name": "Benjamin Rice", "batter_id": None},
                {"name": "Unresolvable Hitter", "batter_id": None},
            ]
        }

        hydrate_mlbam_ids(object(), market, 2026)

        self.assertEqual(
            [(row["name"], row["batter_id"]) for row in market["players"]],
            [("Already Known", 600001), ("Benjamin Rice", 700001)],
        )
        self.assertEqual(market["mlbam_ids_hydrated"], 2)
        self.assertEqual(market["mlbam_ids_added"], 1)
        self.assertEqual(
            market["unresolved_player_names"], ["Unresolvable Hitter"]
        )

    @patch("src.player_ids.season_hitter_pool")
    def test_existing_ids_do_not_require_an_extra_mlb_pool_call(self, pool):
        market = {"players": [{"name": "Known", "batter_id": 600001}]}
        hydrate_mlbam_ids(object(), market, 2026)
        pool.assert_not_called()

    def test_today_reader_accepts_only_the_exact_materialized_checkpoint(self):
        payload = {
            "source": "mlb-hr-edge-database",
            "delivery": "qstash-vercel-redis",
            "status": "ready",
            "date": "2026-08-15",
            "checkpoint": "1117",
            "asOf": "2026-08-15T15:32:00+00:00",
            "generatedAt": "2026-08-15T15:17:04+00:00",
            "quoteCount": 1,
            "rows": [
                {
                    "gameDate": "2026-08-15",
                    "batterId": None,
                    "batterName": "Benjamin Rice",
                    "lineupConfirmed": False,
                    "odds": {
                        "fanduel": {
                            "americanOdds": 650,
                            "capturedAt": "2026-08-15T15:17:04+00:00",
                        }
                    },
                }
            ],
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "latest.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            market = refresh_latest.load_cached_market(
                path, date(2026, 8, 15), "11:17"
            )
            self.assertEqual(market["checkpoint"], "1117")
            self.assertIsNone(market["players"][0]["batter_id"])
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                refresh_latest.load_cached_market(
                    path, date(2026, 8, 15), "17:17"
                )

    def test_optional_today_refresh_cannot_precede_checkpoint_capture(self):
        workflow = (
            ROOT / ".github" / "workflows" / "sync-shared-odds-mirror.yml"
        ).read_text(encoding="utf-8")
        capture = workflow.index("python scripts/capture_top100_checkpoint.py")
        today = workflow.index("id: today")
        commit = workflow.index("- name: Commit board update")
        self.assertLess(capture, today)
        self.assertLess(today, commit)
        self.assertIn("continue-on-error: true", workflow[today:commit])


if __name__ == "__main__":
    unittest.main()
