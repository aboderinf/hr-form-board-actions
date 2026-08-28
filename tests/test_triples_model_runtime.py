from __future__ import annotations

import json
import importlib.util
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

from src.triples_model import read_state_parts, write_state_parts
from src.triples_model_runtime import (
    STATE_POINTER_KEY,
    build_and_publish,
    current_et_date,
    materialize_state,
    persist_state,
    read_model_board,
    usable_board,
)


API_PATH = Path(__file__).resolve().parents[1] / "api" / "qstash-0817-diagnostic.py"


def load_qstash_api():
    spec = importlib.util.spec_from_file_location("qstash_0817_diagnostic", API_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def command(self, command):
        name = str(command[0]).upper()
        key = str(command[1]) if len(command) > 1 else ""
        if name == "GET":
            return self.values.get(key)
        if name == "SET":
            if "NX" in command[3:] and key in self.values:
                return None
            self.values[key] = str(command[2])
            return "OK"
        if name == "DEL":
            return 1 if self.values.pop(key, None) is not None else 0
        raise AssertionError(f"Unsupported fake Redis command: {command}")


def sample_state(as_of: str = "2026-08-26") -> dict:
    return {
        "schema_version": 1,
        "as_of": as_of,
        "batters": {},
        "pitchers": {},
        "teams": {},
        "static": {},
    }


def write_runtime_fixture(root: Path, *, state_as_of: str = "2026-08-26") -> None:
    state_path = root / "data" / "triples-model" / "state-parts"
    write_state_parts(state_path, sample_state(state_as_of))
    (root / "data" / "triples-model" / "model.json").write_text("{}\n", encoding="utf-8")
    (root / "data" / "triples-model" / "performance.json").write_text("{}\n", encoding="utf-8")
    (root / "data" / "triples-model.json").write_text(
        json.dumps(
            {
                "status": "ready",
                "slate_date": "2026-08-27",
                "state_as_of": state_as_of,
                "sports_game_odds_objects_added": 0,
                "players": [],
            }
        ),
        encoding="utf-8",
    )


class TriplesModelRuntimeTests(unittest.TestCase):
    def test_current_et_date_observes_baseball_day(self) -> None:
        self.assertEqual(
            current_et_date(datetime(2026, 8, 28, 3, 30, tzinfo=timezone.utc)),
            "2026-08-27",
        )
        self.assertEqual(
            current_et_date(datetime(2026, 8, 28, 13, 30, tzinfo=timezone.utc)),
            "2026-08-28",
        )

    def test_usable_board_requires_current_slate_and_optional_fresh_state(self) -> None:
        board = {
            "status": "ready",
            "slate_date": "2026-08-28",
            "state_as_of": "2026-08-26",
            "sports_game_odds_objects_added": 0,
        }
        self.assertTrue(usable_board(board, "2026-08-28", require_fresh_state=False))
        self.assertFalse(usable_board(board, "2026-08-28", require_fresh_state=True))
        board["state_as_of"] = "2026-08-27"
        self.assertTrue(usable_board(board, "2026-08-28", require_fresh_state=True))
        board["sports_game_odds_objects_added"] = 1
        self.assertFalse(usable_board(board, "2026-08-28", require_fresh_state=False))

    def test_state_round_trip_uses_redis_after_static_seed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_runtime_fixture(root)
            store = FakeRedis()
            first = root / "first"
            self.assertEqual(materialize_state(store, first, root=root), "static-fallback")
            state = read_state_parts(first)
            state["as_of"] = "2026-08-27"
            state["batters"]["123"] = {"last_date": "2026-08-27"}
            write_state_parts(first, state)
            version = persist_state(store, first, state_as_of="2026-08-27")
            self.assertIn("2026-08-27", version)
            self.assertIn(STATE_POINTER_KEY, store.values)

            second = root / "second"
            self.assertEqual(materialize_state(store, second, root=root), "redis")
            self.assertEqual(read_state_parts(second), state)

    def test_build_publishes_once_then_reuses_fresh_board(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_runtime_fixture(root)
            store = FakeRedis()
            calls: list[date] = []

            def fake_build(*, slate, state_path, model_path, performance_path, output_path):
                calls.append(slate)
                state = read_state_parts(state_path)
                state["as_of"] = "2026-08-27"
                write_state_parts(state_path, state)
                board = {
                    "schema_version": 1,
                    "status": "ready",
                    "slate_date": slate.isoformat(),
                    "generated_at": "2026-08-28T08:05:00+00:00",
                    "state_as_of": state["as_of"],
                    "player_count": 1,
                    "sports_game_odds_objects_added": 0,
                    "players": [{"player": "Test Batter"}],
                }
                output_path.write_text(json.dumps(board), encoding="utf-8")
                return board

            first = build_and_publish(
                "2026-08-28",
                store=store,
                root=root,
                build_fn=fake_build,
            )
            self.assertEqual(first["status"], "built")
            self.assertEqual(first["state_source"], "static-fallback")
            self.assertEqual(first["board"]["delivery"], "qstash-vercel-redis")
            self.assertEqual(first["board"]["sports_game_odds_objects_added"], 0)

            second = build_and_publish(
                "2026-08-28",
                store=store,
                root=root,
                build_fn=fake_build,
            )
            self.assertEqual(second["status"], "already_current")
            self.assertEqual(calls, [date(2026, 8, 28)])
            board, source = read_model_board("2026-08-28", store=store, root=root)
            self.assertEqual(source, "redis")
            self.assertEqual(board["players"][0]["player"], "Test Batter")

    def test_active_lock_returns_without_running_builder(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_runtime_fixture(root)
            store = FakeRedis()
            store.values["mlbhr:triples-model:lock:2026-08-28"] = "other-build"
            result = build_and_publish(
                "2026-08-28",
                store=store,
                root=root,
                build_fn=lambda **_: self.fail("builder should not run"),
            )
            self.assertEqual(result["status"], "build_in_progress")

    def test_qstash_schedule_is_idempotent_when_exact_schedule_exists(self) -> None:
        api = load_qstash_api()
        config = api.SCHEDULES["ensure-triples-model-schedule"]
        api.resolve_qstash = lambda: (
            "https://qstash.example",
            "secret",
            [
                {
                    "scheduleId": "model-daily",
                    "destination": config["destination"],
                    "cron": config["cron"],
                    "isPaused": False,
                }
            ],
        )
        status, payload = api.ensure_schedule(config)
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "already_configured")
        self.assertEqual(payload["scheduleId"], "model-daily")

    def test_qstash_schedule_creation_forwards_retries_and_timeout(self) -> None:
        api = load_qstash_api()
        config = api.SCHEDULES["ensure-triples-model-schedule"]
        captured: dict = {}
        api.resolve_qstash = lambda: ("https://qstash.example", "secret", [])

        def fake_request(url, **kwargs):
            captured.update({"url": url, **kwargs})
            return 201, {"scheduleId": "new-model-daily"}

        api._request_json = fake_request
        status, payload = api.ensure_schedule(config)
        self.assertEqual(status, 201)
        self.assertEqual(payload["status"], "created")
        self.assertEqual(captured["headers"]["Upstash-Cron"], "5 8,9,10,11 * * *")
        self.assertEqual(captured["headers"]["Upstash-Retries"], "2")
        self.assertEqual(captured["headers"]["Upstash-Timeout"], "5m")


if __name__ == "__main__":
    unittest.main()
