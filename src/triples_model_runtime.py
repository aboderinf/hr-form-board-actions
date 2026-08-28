from __future__ import annotations

import base64
import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Sequence
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from src.triples_model import read_state_parts


ROOT = Path(__file__).resolve().parents[1]
ET = ZoneInfo("America/New_York")
REDIS_TTL_SECONDS = 400 * 24 * 60 * 60
LOCK_TTL_SECONDS = 10 * 60
OUTPUT_PREFIX = "mlbhr:triples-model"
STATE_POINTER_KEY = f"{OUTPUT_PREFIX}:state:latest"
VALID_STATUSES = {"ready", "no_scheduled_players"}
PART_NAME = re.compile(r"^part-[0-9]{3}\.bin$")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _env_first(*names: str) -> str:
    for name in names:
        value = str(os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


class RedisRest:
    def __init__(self, url: str, token: str, timeout: float = 30.0) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout

    @classmethod
    def from_environment(cls) -> "RedisRest":
        url = _env_first("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL")
        token = _env_first("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN")
        if not url or not token:
            raise RuntimeError("Upstash Redis REST environment is missing")
        return cls(url, token)

    def command(self, command: Sequence[Any]) -> Any:
        request = Request(
            self.url,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            data=_json(list(command)).encode("utf-8"),
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                status = response.status
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            status = error.code
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = {}
        error_message = payload.get("error") if isinstance(payload, dict) else None
        if status >= 400 or error_message:
            raise RuntimeError(error_message or f"Redis HTTP {status}")
        if not isinstance(payload, dict):
            raise RuntimeError("Redis returned an invalid response")
        return payload.get("result")


def current_et_date(now: datetime | None = None) -> str:
    moment = now or datetime.now(timezone.utc)
    return moment.astimezone(ET).date().isoformat()


def expected_state_date(slate_date: str) -> str:
    return (date.fromisoformat(slate_date) - timedelta(days=1)).isoformat()


def usable_board(payload: Any, slate_date: str, *, require_fresh_state: bool) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("slate_date") != slate_date or payload.get("status") not in VALID_STATUSES:
        return False
    if int(payload.get("sports_game_odds_objects_added") or 0) != 0:
        return False
    if require_fresh_state:
        state_as_of = str(payload.get("state_as_of") or "")
        if state_as_of < expected_state_date(slate_date):
            return False
    return True


def _decode_json(raw: Any) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        value = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
    except (AttributeError, UnicodeDecodeError, json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _output_key(slate_date: str) -> str:
    return f"{OUTPUT_PREFIX}:{slate_date}"


def _state_part_key(version: str, part_name: str) -> str:
    return f"{OUTPUT_PREFIX}:state:{version}:{part_name}"


def read_redis_board(store: Any, slate_date: str) -> dict[str, Any] | None:
    direct = _decode_json(store.command(["GET", _output_key(slate_date)]))
    if usable_board(direct, slate_date, require_fresh_state=False):
        return direct
    latest = _decode_json(store.command(["GET", f"{OUTPUT_PREFIX}:latest"]))
    return latest if usable_board(latest, slate_date, require_fresh_state=False) else None


def read_static_board(root: Path = ROOT) -> dict[str, Any] | None:
    try:
        payload = json.loads((root / "data" / "triples-model.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def read_model_board(
    slate_date: str | None = None,
    *,
    store: Any | None = None,
    root: Path = ROOT,
) -> tuple[dict[str, Any] | None, str]:
    resolved_date = slate_date or current_et_date()
    resolved_store = store or RedisRest.from_environment()
    try:
        redis_board = read_redis_board(resolved_store, resolved_date)
    except Exception:
        redis_board = None
    if redis_board:
        return redis_board, "redis"
    return read_static_board(root), "static-fallback"


def materialize_state(store: Any, destination: Path, *, root: Path = ROOT) -> str:
    pointer = _decode_json(store.command(["GET", STATE_POINTER_KEY]))
    if pointer:
        version = str(pointer.get("version") or "")
        manifest = pointer.get("manifest")
        parts = manifest.get("parts") if isinstance(manifest, dict) else None
        if version and isinstance(parts, list) and parts:
            try:
                destination.mkdir(parents=True, exist_ok=True)
                for part_name in parts:
                    if not PART_NAME.fullmatch(str(part_name)):
                        raise ValueError("Invalid Triples model state part name")
                    encoded = store.command(["GET", _state_part_key(version, str(part_name))])
                    if not encoded:
                        raise ValueError(f"Missing Redis state part {part_name}")
                    (destination / str(part_name)).write_bytes(base64.b64decode(encoded, validate=True))
                (destination / "manifest.json").write_text(
                    json.dumps(manifest, indent=2) + "\n",
                    encoding="utf-8",
                )
                read_state_parts(destination)
                return "redis"
            except Exception:
                shutil.rmtree(destination, ignore_errors=True)

    static_state = root / "data" / "triples-model" / "state-parts"
    shutil.copytree(static_state, destination)
    read_state_parts(destination)
    return "static-fallback"


def persist_state(store: Any, state_path: Path, *, state_as_of: str | None) -> str:
    manifest = json.loads((state_path / "manifest.json").read_text(encoding="utf-8"))
    parts = manifest.get("parts") or []
    if not parts or any(not PART_NAME.fullmatch(str(name)) for name in parts):
        raise ValueError("Invalid Triples model state manifest")
    version = f"{state_as_of or 'unknown'}-{str(manifest.get('sha256') or '')[:16]}"
    for part_name in parts:
        encoded = base64.b64encode((state_path / str(part_name)).read_bytes()).decode("ascii")
        store.command(
            [
                "SET",
                _state_part_key(version, str(part_name)),
                encoded,
                "EX",
                REDIS_TTL_SECONDS,
            ]
        )
    pointer = {
        "schema_version": 1,
        "version": version,
        "state_as_of": state_as_of,
        "manifest": manifest,
        "written_at": datetime.now(timezone.utc).isoformat(),
    }
    store.command(["SET", STATE_POINTER_KEY, _json(pointer), "EX", REDIS_TTL_SECONDS])
    return version


def publish_board(store: Any, board: dict[str, Any]) -> None:
    slate_date = str(board["slate_date"])
    compact = _json(board)
    store.command(["SET", _output_key(slate_date), compact, "EX", REDIS_TTL_SECONDS])
    store.command(["SET", f"{OUTPUT_PREFIX}:latest", compact, "EX", REDIS_TTL_SECONDS])


def _release_lock(store: Any, lock_key: str, token: str) -> None:
    try:
        if store.command(["GET", lock_key]) == token:
            store.command(["DEL", lock_key])
    except Exception:
        pass


def build_and_publish(
    slate_date: str | None = None,
    *,
    store: Any | None = None,
    root: Path = ROOT,
    build_fn: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    resolved_date = slate_date or current_et_date()
    date.fromisoformat(resolved_date)
    resolved_store = store or RedisRest.from_environment()
    existing = read_redis_board(resolved_store, resolved_date)
    if usable_board(existing, resolved_date, require_fresh_state=True):
        return {"status": "already_current", "board": existing, "state_source": "redis"}

    lock_key = f"{OUTPUT_PREFIX}:lock:{resolved_date}"
    lock_token = uuid.uuid4().hex
    acquired = resolved_store.command(["SET", lock_key, lock_token, "NX", "EX", LOCK_TTL_SECONDS])
    if acquired != "OK":
        return {"status": "build_in_progress", "board": existing, "state_source": None}

    try:
        existing = read_redis_board(resolved_store, resolved_date)
        if usable_board(existing, resolved_date, require_fresh_state=True):
            return {"status": "already_current", "board": existing, "state_source": "redis"}

        with tempfile.TemporaryDirectory(prefix="triples-model-") as temporary:
            temp = Path(temporary)
            state_path = temp / "state-parts"
            output_path = temp / "triples-model.json"
            state_source = materialize_state(resolved_store, state_path, root=root)
            if build_fn is None:
                from scripts import build_triples_model

                builder = build_triples_model.build_board
            else:
                builder = build_fn
            board = builder(
                slate=date.fromisoformat(resolved_date),
                state_path=state_path,
                model_path=root / "data" / "triples-model" / "model.json",
                performance_path=root / "data" / "triples-model" / "performance.json",
                output_path=output_path,
            )
            if not isinstance(board, dict) and output_path.exists():
                board = json.loads(output_path.read_text(encoding="utf-8"))
            if not usable_board(board, resolved_date, require_fresh_state=False):
                raise RuntimeError("Triples model builder returned an unusable board")

            board = dict(board)
            board["delivery"] = "qstash-vercel-redis"
            board["state_storage"] = "upstash-redis"
            board["state_source"] = state_source
            state_version = persist_state(
                resolved_store,
                state_path,
                state_as_of=str(board.get("state_as_of") or "") or None,
            )
            board["state_version"] = state_version
            publish_board(resolved_store, board)
            return {"status": "built", "board": board, "state_source": state_source}
    finally:
        _release_lock(resolved_store, lock_key, lock_token)
