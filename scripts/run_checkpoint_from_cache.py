#!/usr/bin/env python3
"""Run the existing checkpoint scorer against the exact local Upstash materialization."""

from __future__ import annotations

from datetime import date
import importlib.util
import json
from pathlib import Path
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.edge_source import parse_edge_payload
from src.model import normalize_name
from src.sources import season_hitter_pool


RUN_CHECKPOINT = ROOT / "scripts" / "run_checkpoint.py"
spec = importlib.util.spec_from_file_location("run_checkpoint_original", RUN_CHECKPOINT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# SportsGameOdds sometimes uses legal/formal first names while MLB Stats uses
# the common baseball name. Keep only explicit, deterministic aliases here;
# never fuzzy-match a price to a different hitter.
PROVIDER_NAME_ALIASES = {
    "benjaminrice": "benrice",
    "jasradochisholm": "jazzchisholm",
    "joshuabell": "joshbell",
    "mikebusch": "michaelbusch",
    "mikemassey": "michaelmassey",
    "nicholaslopez": "nickylopez",
    "zacharyneto": "zachneto",
}


def _provider_name_key(name: str) -> str:
    key = normalize_name(name)
    return PROVIDER_NAME_ALIASES.get(key, key)


def _hydrate_mlbam_ids(client: Any, market: dict[str, Any], season: int) -> None:
    pool = season_hitter_pool(client, season)
    by_name: dict[str, int] = {}
    duplicates: set[str] = set()
    for row in pool:
        key = normalize_name(str(row["player"]))
        if key in by_name and by_name[key] != int(row["mlbam_id"]):
            duplicates.add(key)
        else:
            by_name[key] = int(row["mlbam_id"])
    for key in duplicates:
        by_name.pop(key, None)

    resolved: list[dict[str, Any]] = []
    unresolved: list[str] = []
    for row in market.get("players") or []:
        existing = row.get("batter_id")
        if existing:
            resolved.append(row)
            continue
        player_id = by_name.get(_provider_name_key(str(row.get("name") or "")))
        if player_id is None:
            unresolved.append(str(row.get("name") or ""))
            continue
        row["batter_id"] = player_id
        resolved.append(row)

    market["players"] = resolved
    market["mlbam_ids_hydrated"] = len(resolved)
    market["unresolved_player_names"] = sorted(set(unresolved))


def cached_fetch_edge_odds(client: Any, expected_date: date, as_of: Any) -> dict[str, Any]:
    path = ROOT / "data" / "shared-odds" / "latest.json"
    if not path.exists() or path.stat().st_size == 0:
        raise RuntimeError("Exact Upstash checkpoint cache is missing")
    payload = json.loads(path.read_text(encoding="utf-8"))
    expected_checkpoint = as_of.astimezone(module.ET).strftime("%H%M")
    actual_checkpoint = str(payload.get("checkpoint") or "").replace(":", "")
    if str(payload.get("date") or "") != expected_date.isoformat():
        raise RuntimeError("Cached checkpoint slate date mismatch")
    if actual_checkpoint != expected_checkpoint:
        raise RuntimeError(
            f"Cached checkpoint {actual_checkpoint!r} does not match {expected_checkpoint!r}"
        )
    if payload.get("delivery") != "qstash-vercel-redis":
        raise RuntimeError("Cached checkpoint did not come from QStash/Vercel/Redis")

    market = parse_edge_payload(
        payload,
        expected_date,
        enforce_checkpoint_age=False,
        require_confirmed_lineup=False,
    )
    _hydrate_mlbam_ids(client, market, expected_date.year)
    market["source_url"] = str(path.relative_to(ROOT))
    market["compatibility_fallback"] = "exact_upstash_checkpoint_cache"
    market["checkpoint_at"] = as_of.isoformat()
    return market


module.fetch_edge_odds = cached_fetch_edge_odds

if __name__ == "__main__":
    raise SystemExit(module.main())
