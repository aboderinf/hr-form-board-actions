from __future__ import annotations

from typing import Any

from .model import normalize_name
from .sources import season_hitter_pool


# SportsGameOdds sometimes uses a legal/formal first name while MLB Stats uses
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


def provider_name_key(name: str) -> str:
    key = normalize_name(name)
    return PROVIDER_NAME_ALIASES.get(key, key)


def hydrate_mlbam_ids(client: Any, market: dict[str, Any], season: int) -> None:
    """Resolve missing provider batter IDs from the unambiguous MLB hitter pool.

    Rows that cannot be resolved deterministically are excluded before callers
    fetch game logs. Existing provider IDs are preserved and normalized to int.
    """
    players = list(market.get("players") or [])
    missing = [row for row in players if not row.get("batter_id")]

    by_name: dict[str, int] = {}
    duplicates: set[str] = set()
    if missing:
        for row in season_hitter_pool(client, season):
            key = normalize_name(str(row["player"]))
            player_id = int(row["mlbam_id"])
            if key in by_name and by_name[key] != player_id:
                duplicates.add(key)
            else:
                by_name[key] = player_id
        for key in duplicates:
            by_name.pop(key, None)

    resolved: list[dict[str, Any]] = []
    unresolved: list[str] = []
    added = 0
    for row in players:
        existing = row.get("batter_id")
        if existing:
            try:
                row["batter_id"] = int(existing)
            except (TypeError, ValueError):
                existing = None
            else:
                resolved.append(row)
                continue

        player_id = by_name.get(provider_name_key(str(row.get("name") or "")))
        if player_id is None:
            unresolved.append(str(row.get("name") or ""))
            continue
        row["batter_id"] = player_id
        resolved.append(row)
        added += 1

    market["players"] = resolved
    # Preserve the original field's total-resolved meaning for compatibility,
    # while exposing the number actually added as a separate diagnostic.
    market["mlbam_ids_hydrated"] = len(resolved)
    market["mlbam_ids_added"] = added
    market["unresolved_player_names"] = sorted(set(unresolved))
