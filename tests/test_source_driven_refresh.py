from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


orchestrator = load_script(
    "run_source_driven_refresh",
    ROOT / "scripts" / "run_source_driven_refresh.py",
)
central = load_script(
    "sync_shared_odds_mirror",
    ROOT / "scripts" / "sync_shared_odds_mirror.py",
)


class SourceDrivenRefreshTests(unittest.TestCase):
    def payload(self, checkpoint: str = "2017") -> dict:
        return {
            "source": "mlb-hr-edge-database",
            "status": "ready",
            "date": "2026-08-02",
            "checkpoint": checkpoint,
            "providerCallId": "call-1",
            "providerResponseSha256": "a" * 64,
            "rows": [],
        }

    def dashboard(self) -> dict:
        return {
            "source": "database",
            "generatedAt": "2026-08-03T00:25:58+00:00",
            "feedStatus": "live",
            "rows": [
                {
                    "id": "prediction-1",
                    "gameDate": "2026-08-02",
                    "gamePk": 123,
                    "gameStartAt": "2026-08-03T01:10:00+00:00",
                    "batterId": 77,
                    "batterName": "Test Hitter",
                    "batterTeam": "TST",
                    "matchup": "TST @ OPP",
                    "lineupPosition": 2,
                    "odds": {
                        "fanduel": {
                            "americanOdds": 650,
                            "capturedAt": "2026-08-03T00:25:58+00:00",
                        },
                        "draftkings": {
                            "americanOdds": 700,
                            "capturedAt": "2026-08-03T04:40:00+00:00",
                        },
                    },
                }
            ],
        }

    def test_checkpoint_formats_normalize_identically(self) -> None:
        self.assertEqual(orchestrator.normalize_checkpoint("20:17"), "2017")
        self.assertEqual(orchestrator.normalize_checkpoint("8:17"), "0817")
        self.assertEqual(orchestrator.checkpoint_with_colon("0817"), "08:17")
        self.assertEqual(central.normalize_checkpoint("20:17"), "2017")

    def test_exact_source_checkpoint_matches(self) -> None:
        self.assertTrue(
            orchestrator.source_matches(self.payload(), "2026-08-02", "20:17")
        )
        central.validate(
            self.payload(),
            expected_date="2026-08-02",
            expected_checkpoint="20:17",
        )

    def test_stale_source_checkpoint_is_rejected(self) -> None:
        self.assertFalse(
            orchestrator.source_matches(
                self.payload(checkpoint="1717"), "2026-08-02", "20:17"
            )
        )
        with self.assertRaisesRegex(ValueError, "does not match expected"):
            central.validate(
                self.payload(checkpoint="1717"),
                expected_date="2026-08-02",
                expected_checkpoint="20:17",
            )

    def test_every_candidate_is_a_central_database_endpoint(self) -> None:
        urls = central.central_odds_urls("2026-08-02", "20:17")
        self.assertGreaterEqual(len(urls), 2)
        self.assertTrue(all(url.startswith(central.EDGE_BASE_URL) for url in urls))
        self.assertTrue(all("/api/odds?" in url for url in urls))
        self.assertFalse(any("github.io" in url for url in urls))

    def test_local_cache_is_never_used_as_a_source(self) -> None:
        self.assertFalse(hasattr(central, "load_matching_local"))

    def test_dashboard_fallback_is_database_backed_and_checkpoint_scoped(self) -> None:
        payload = central.dashboard_to_shared(
            self.dashboard(), "2026-08-02", "20:17"
        )
        self.assertEqual(payload["checkpoint"], "2017")
        self.assertEqual(payload["source"], "mlb-hr-edge-database")
        self.assertEqual(payload["allAvailableQuoteCount"], 2)
        self.assertEqual(payload["quoteCount"], 1)
        self.assertEqual(payload["excludedLiveOrPostStartQuoteCount"], 1)
        self.assertEqual(
            payload["rows"][0]["odds"]["fanduel"]["americanOdds"], 650
        )
        self.assertEqual(len(payload["providerResponseSha256"]), 64)

    def test_materialized_cache_keeps_provider_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            result = central.materialize(
                self.payload(), output, f"{central.EDGE_BASE_URL}/api/odds?latest=1"
            )
            latest = json.loads((output / "latest.json").read_text(encoding="utf-8"))
            archived = json.loads(
                (output / "archive" / "2026-08-02_2017.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(result["providerCallId"], "call-1")
            self.assertEqual(latest["providerCallId"], "call-1")
            self.assertEqual(archived["providerResponseSha256"], "a" * 64)
            self.assertEqual(latest["delivery"], "central-database-consumer-cache")


if __name__ == "__main__":
    unittest.main()
