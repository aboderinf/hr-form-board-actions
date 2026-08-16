from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from typing import Any, Iterable

from .discovery import best_price


TEAM_CODE_ALIASES = {
    "ATH": "OAK",
    "CWS": "CHW",
    "KCR": "KC",
    "SDP": "SD",
    "SFG": "SF",
    "TBR": "TB",
    "WSN": "WSH",
}
FINAL_STATES = {"final", "completed early", "game over"}
NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def normalize_name(value: str | None) -> str:
    folded = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode("ascii")
    return " ".join(re.findall(r"[a-z0-9]+", folded.lower()))


def normalize_team_code(value: str | None) -> str:
    code = re.sub(r"[^A-Z]", "", (value or "").upper())
    return TEAM_CODE_ALIASES.get(code, code)


def matchup_codes(value: str | None) -> tuple[str, str] | None:
    match = re.match(r"\s*([A-Za-z]+)\s*@\s*([A-Za-z]+)\s*$", value or "")
    if not match:
        return None
    return normalize_team_code(match.group(1)), normalize_team_code(match.group(2))


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def team_code_index(teams: Iterable[dict[str, Any]]) -> dict[str, int]:
    output: dict[str, int] = {}
    for team in teams:
        team_id = team.get("id")
        if not team_id:
            continue
        for code in (team.get("abbreviation"), team.get("teamCode"), team.get("fileCode")):
            normalized = normalize_team_code(str(code or ""))
            if normalized:
                output[normalized] = int(team_id)
    return output


def map_event_game(
    provider_row: dict[str, Any],
    games: Iterable[dict[str, Any]],
    codes: dict[str, int],
) -> dict[str, Any] | None:
    games = list(games)
    matchup = matchup_codes(provider_row.get("matchup"))
    exact: list[dict[str, Any]] = []
    if matchup:
        away_id = codes.get(matchup[0])
        home_id = codes.get(matchup[1])
        if away_id and home_id:
            exact = [
                game
                for game in games
                if int(game.get("away_team_id") or 0) == away_id
                and int(game.get("home_team_id") or 0) == home_id
            ]

    candidates = exact or games
    provider_time = parse_timestamp(provider_row.get("gameStartAt"))
    scored: list[tuple[float, dict[str, Any]]] = []
    for game in candidates:
        game_time = parse_timestamp(game.get("game_date"))
        if provider_time and game_time:
            distance = abs((provider_time - game_time).total_seconds())
        else:
            distance = 0.0 if len(candidates) == 1 else float("inf")
        scored.append((distance, game))
    if not scored:
        return None
    scored.sort(key=lambda item: (item[0], int(item[1].get("game_pk") or 0)))
    distance, selected = scored[0]
    if not exact and distance > 30 * 60:
        return None
    return selected


def _surname(tokens: list[str]) -> str:
    if tokens and tokens[-1] in NAME_SUFFIXES:
        tokens = tokens[:-1]
    return tokens[-1] if tokens else ""


def player_indexes(pool: Iterable[dict[str, Any]]) -> tuple[dict[str, list[int]], dict[str, list[int]]]:
    exact: dict[str, list[int]] = {}
    initial_last: dict[str, list[int]] = {}
    for player in pool:
        player_id = int(player["mlbam_id"])
        normalized = normalize_name(player.get("player"))
        tokens = normalized.split()
        if not tokens:
            continue
        exact.setdefault(normalized, []).append(player_id)
        compact = normalized.replace(" ", "")
        if compact != normalized:
            exact.setdefault(compact, []).append(player_id)
        initial_last.setdefault(f"{tokens[0][0]} {_surname(tokens)}", []).append(player_id)
    return exact, initial_last


def resolve_player_id(
    provider_name: str | None,
    game_pk: int | None,
    exact: dict[str, list[int]],
    initial_last: dict[str, list[int]],
    logs: dict[int, list[dict[str, Any]]],
) -> int | None:
    normalized = normalize_name(provider_name)
    candidates = list(exact.get(normalized, []))
    if not candidates:
        candidates = list(exact.get(normalized.replace(" ", ""), []))
    if not candidates:
        tokens = normalized.split()
        if tokens:
            candidates = list(initial_last.get(f"{tokens[0][0]} {_surname(tokens)}", []))
    if len(candidates) == 1:
        return candidates[0]
    if game_pk:
        appearing = [
            player_id
            for player_id in candidates
            if any(int(game.get("gamePk") or 0) == int(game_pk) for game in logs.get(player_id, []))
        ]
        if len(appearing) == 1:
            return appearing[0]
    return None


def best_archived_quote(odds: dict[str, Any] | None) -> dict[str, Any] | None:
    prices = []
    for book, quote in (odds or {}).items():
        value = quote.get("americanOdds") if isinstance(quote, dict) else None
        if isinstance(value, int) and value != 0:
            prices.append({"book": book, "odds": value})
    return best_price(prices)


def settle_player_game(
    games: Iterable[dict[str, Any]],
    game_pk: int | None,
    abstract_state: str | None,
    detailed_state: str | None,
) -> tuple[str, int | None, int | None]:
    state_values = {str(abstract_state or "").lower(), str(detailed_state or "").lower()}
    if not state_values.intersection(FINAL_STATES):
        return "PENDING", None, None
    matching = [game for game in games if int(game.get("gamePk") or 0) == int(game_pk or 0)]
    if not matching:
        return "VOID", 0, 0
    game = matching[0]
    plate_appearances = int(game.get("plateAppearances") or 0)
    triples = int(game.get("triples") or 0)
    if plate_appearances <= 0:
        return "VOID", triples, plate_appearances
    return ("WIN" if triples > 0 else "LOSS"), triples, plate_appearances
