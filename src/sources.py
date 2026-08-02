from __future__ import annotations

import json
import time
from datetime import date
from typing import Any
from urllib.parse import urlencode

import requests

MLB = "https://statsapi.mlb.com/api/v1"


class HttpClient:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (compatible; HRFormBoardActions/2.0)",
                "Accept-Language": "en-US,en;q=.9",
            }
        )

    def text(self, url: str) -> str:
        error: Exception | None = None
        for attempt in range(3):
            try:
                response = self.s.get(url, timeout=30)
                response.raise_for_status()
                return response.text
            except Exception as exc:
                error = exc
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"GET failed {url}: {error}")

    def json(self, url: str) -> dict[str, Any]:
        return json.loads(self.text(url))


def season_hitter_pool(client: HttpClient, season: int) -> list[dict[str, Any]]:
    """Return every MLB player with a hitting appearance in the season.

    This is intentionally independent of confirmed lineups and sportsbook
    markets. New call-ups enter automatically as soon as MLB records a hitting
    appearance for them.
    """
    params = urlencode(
        {
            "stats": "season",
            "group": "hitting",
            "season": season,
            "playerPool": "ALL",
            "sportIds": 1,
            "limit": 2000,
        }
    )
    payload = client.json(f"{MLB}/stats?{params}")
    splits = (payload.get("stats") or [{}])[0].get("splits", [])
    players: dict[int, dict[str, Any]] = {}
    for row in splits:
        person = row.get("player") or row.get("person") or {}
        player_id = person.get("id")
        name = person.get("fullName")
        if not player_id or not name:
            continue
        stat = row.get("stat") or {}
        try:
            plate_appearances = int(stat.get("plateAppearances") or 0)
        except (TypeError, ValueError):
            plate_appearances = 0
        if plate_appearances <= 0:
            continue
        team = row.get("team") or {}
        players[int(player_id)] = {
            "mlbam_id": int(player_id),
            "player": str(name),
            "team_id": team.get("id"),
            "team": team.get("name"),
            "season_plate_appearances": plate_appearances,
        }
    return sorted(players.values(), key=lambda row: row["player"])


def game_log(client: HttpClient, player_id: int, season: int) -> list[dict]:
    payload = client.json(
        f"{MLB}/people/{player_id}/stats?stats=gameLog&group=hitting&season={season}&gameType=R"
    )
    splits = (payload.get("stats") or [{}])[0].get("splits", [])
    return [
        {
            "date": row.get("date"),
            "gamePk": (row.get("game") or {}).get("gamePk"),
            "opponent": (row.get("opponent") or {}).get("name"),
            "homeRuns": int((row.get("stat") or {}).get("homeRuns") or 0),
            "plateAppearances": int(
                (row.get("stat") or {}).get("plateAppearances") or 0
            ),
        }
        for row in splits
    ]


def schedule(client: HttpClient, day: date) -> dict[int, dict]:
    payload = client.json(
        f"{MLB}/schedule?sportId=1&date={day.isoformat()}&hydrate=status,teams"
    )
    out: dict[int, dict] = {}
    for date_row in payload.get("dates", []):
        for game in date_row.get("games", []):
            info = {
                "gamePk": game.get("gamePk"),
                "gameDate": game.get("gameDate"),
                "status": (game.get("status") or {}).get("detailedState"),
                "abstractState": (game.get("status") or {}).get(
                    "abstractGameState"
                ),
            }
            teams = game.get("teams") or {}
            home = (teams.get("home") or {}).get("team") or {}
            away = (teams.get("away") or {}).get("team") or {}
            if home.get("id"):
                out[int(home["id"])] = {
                    **info,
                    "team": home.get("name"),
                    "opponent": away.get("name"),
                }
            if away.get("id"):
                out[int(away["id"])] = {
                    **info,
                    "team": away.get("name"),
                    "opponent": home.get("name"),
                }
    return out
