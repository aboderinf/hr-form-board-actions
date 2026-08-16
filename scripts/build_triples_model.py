#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.model import ET  # noqa: E402
from src.sources import HttpClient, MLB, season_hitter_pool  # noqa: E402
from src.storage import write_json  # noqa: E402
from src.triples_model import (  # noqa: E402
    build_feature_row,
    fair_american,
    group_statcast_games,
    new_entity_state,
    predict_model_probability,
    predict_probability,
    read_state_parts,
    update_entity,
    write_state_parts,
)


SAVANT = "https://baseballsavant.mlb.com"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
PA_EVENTS = (
    "field_out",
    "strikeout",
    "single",
    "walk",
    "double",
    "home_run",
    "force_out",
    "grounded_into_double_play",
    "hit_by_pitch",
    "intent_walk",
    "sac_bunt",
    "sac_fly",
    "field_error",
    "triple",
    "fielders_choice_out",
    "truncated_pa",
    "strikeout_double_play",
    "fielders_choice",
    "double_play",
    "catcher_interf",
    "sac_fly_double_play",
    "other_out",
    "runner_double_play",
    "sac_bunt_double_play",
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def savant_team_code(value: str) -> str:
    return {"ARI": "AZ", "OAK": "ATH"}.get(value, value)


def update_day_state(state: dict[str, Any], games: list[dict[str, Any]], on_date: date) -> None:
    for game in games:
        for side in game.get("sides") or []:
            for batter in side.get("batters") or []:
                key = str(batter["batter"])
                entity = state["batters"].setdefault(key, new_entity_state())
                update_entity(
                    entity,
                    batter["metrics"],
                    on_date,
                    name=batter.get("name"),
                    team=side.get("team"),
                    stand=batter.get("stand"),
                    age=batter.get("age"),
                    last_slot=batter.get("slot"),
                )
            opponent = str(side.get("opponent") or "")
            if opponent:
                entity = state["teams"].setdefault(opponent, new_entity_state())
                update_entity(entity, side["team_metrics"], on_date)
        for pitcher_id, pitcher in (game.get("pitchers") or {}).items():
            entity = state["pitchers"].setdefault(str(pitcher_id), new_entity_state())
            update_entity(
                entity,
                pitcher["metrics"],
                on_date,
                throws=pitcher.get("throws"),
                age=pitcher.get("age"),
            )


def fetch_statcast_day(client: HttpClient, slate: date) -> list[dict[str, Any]]:
    params = urlencode(
        {
            "all": "true",
            "type": "details",
            "player_type": "batter",
            "game_date_gt": slate.isoformat(),
            "game_date_lt": slate.isoformat(),
            "hfGT": "R|",
            "hfAB": "|".join(PA_EVENTS) + "|",
        }
    )
    payload = client.text(f"{SAVANT}/statcast_search/csv?{params}")
    if payload.count("\n") < 2:
        return []
    with tempfile.NamedTemporaryFile("w", suffix=".csv", encoding="utf-8", newline="", delete=False) as handle:
        handle.write(payload)
        path = Path(handle.name)
    try:
        return group_statcast_games(path).get(slate.isoformat(), [])
    finally:
        path.unlink(missing_ok=True)


def schedule_games(client: HttpClient, slate: date) -> list[dict[str, Any]]:
    payload = client.json(
        f"{MLB}/schedule?sportId=1&date={slate.isoformat()}&hydrate=probablePitcher,venue,weather,status,teams"
    )
    return [game for row in payload.get("dates") or [] for game in row.get("games") or []]


def team_codes(client: HttpClient, season: int) -> dict[int, str]:
    payload = client.json(f"{MLB}/teams?sportId=1&season={season}")
    return {
        int(team["id"]): savant_team_code(str(team.get("abbreviation") or ""))
        for team in payload.get("teams") or []
        if team.get("id") and team.get("abbreviation")
    }


def parse_schedule_weather(game: dict[str, Any]) -> dict[str, Any]:
    raw = game.get("weather") or {}
    try:
        temperature = float(raw.get("temp"))
    except (TypeError, ValueError):
        temperature = None
    wind = str(raw.get("wind") or "")
    match = re.search(r"([0-9.]+)\s*mph", wind, re.IGNORECASE)
    speed = float(match.group(1)) if match else 0.0
    lower = wind.lower()
    return {
        "temperature_f": temperature,
        "wind_speed_mph": speed,
        "wind_out_mph": speed if "out to" in lower else -speed if "in from" in lower else 0.0,
        "condition": raw.get("condition"),
    }


def nearest_hour_index(times: list[str], game_time: datetime) -> int | None:
    if not times:
        return None
    target = game_time.astimezone(timezone.utc).replace(tzinfo=None)
    parsed = [datetime.fromisoformat(value) for value in times]
    return min(range(len(parsed)), key=lambda index: abs((parsed[index] - target).total_seconds()))


def open_meteo_weather(client: HttpClient, venue: dict[str, Any], game_time: datetime) -> dict[str, Any]:
    location = venue.get("location") or {}
    latitude, longitude = location.get("latitude"), location.get("longitude")
    if latitude is None or longitude is None:
        return {}
    params = urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "hourly": "temperature_2m,relative_humidity_2m,surface_pressure,precipitation,wind_speed_10m,wind_direction_10m",
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "timezone": "UTC",
            "forecast_days": 3,
        }
    )
    payload = client.json(f"{OPEN_METEO}?{params}")
    hourly = payload.get("hourly") or {}
    index = nearest_hour_index(list(hourly.get("time") or []), game_time)
    if index is None:
        return {}

    def at(key: str, default: float = 0.0) -> float:
        values = hourly.get(key) or []
        try:
            return float(values[index])
        except (IndexError, TypeError, ValueError):
            return default

    speed = at("wind_speed_10m")
    direction_from = at("wind_direction_10m")
    azimuth = float(location.get("azimuth") or 0.0)
    direction_toward = (direction_from + 180.0) % 360.0
    wind_out = speed * math.cos(math.radians(direction_toward - azimuth))
    return {
        "temperature_f": at("temperature_2m", 72.0),
        "humidity_pct": at("relative_humidity_2m", 55.0),
        "pressure_hpa": at("surface_pressure", 1013.0),
        "precipitation_mm": at("precipitation", 0.0),
        "wind_speed_mph": speed,
        "wind_out_mph": wind_out,
        "source": "Open-Meteo game-time forecast",
    }


def refresh_state(client: HttpClient, state: dict[str, Any], through: date) -> list[str]:
    diagnostics: list[str] = []
    cursor = date.fromisoformat(str(state.get("as_of"))) + timedelta(days=1)
    while cursor <= through:
        games = schedule_games(client, cursor)
        if not games:
            state["as_of"] = cursor.isoformat()
            cursor += timedelta(days=1)
            continue
        statcast_games = fetch_statcast_day(client, cursor)
        if not statcast_games:
            diagnostics.append(f"Statcast state remains at {state.get('as_of')}; {cursor} is not available yet")
            break
        update_day_state(state, statcast_games, cursor)
        state["as_of"] = cursor.isoformat()
        cursor += timedelta(days=1)
    return diagnostics


def prediction_drivers(features: dict[str, float]) -> list[str]:
    candidates: list[tuple[float, str]] = []
    if features["b_sprint_speed"] >= 28.5:
        candidates.append(((features["b_sprint_speed"] - 27.0) / 2.0, f"{features['b_sprint_speed']:.1f} ft/s sprint speed"))
    if features["park_triple_factor"] >= 110:
        candidates.append(((features["park_triple_factor"] - 100.0) / 40.0, f"{features['park_triple_factor']:.0f} triple park factor"))
    if features["b_of_bip_pa_30"] >= 0.20:
        candidates.append((features["b_of_bip_pa_30"], "frequent outfield contact"))
    if features["b_triple_pa_90"] >= 0.006:
        candidates.append((features["b_triple_pa_90"] * 30.0, "stronger 90-day triples rate"))
    if features["p_triple_pa_90"] >= 0.005:
        candidates.append((features["p_triple_pa_90"] * 25.0, "starter has allowed more triples"))
    if features["wind_out_mph"] >= 5:
        candidates.append((features["wind_out_mph"] / 20.0, "wind carrying toward the outfield"))
    if features["b_pa_game_30"] >= 4.2:
        candidates.append(((features["b_pa_game_30"] - 3.5) / 2.0, "high expected plate appearances"))
    return [label for _, label in sorted(candidates, reverse=True)[:3]] or ["balanced pregame profile"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="Slate date YYYY-MM-DD")
    parser.add_argument("--state", type=Path, default=ROOT / "data" / "triples-model" / "state-parts")
    parser.add_argument("--model", type=Path, default=ROOT / "data" / "triples-model" / "model.json")
    parser.add_argument("--performance", type=Path, default=ROOT / "data" / "triples-model" / "performance.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "triples-model.json")
    args = parser.parse_args()
    slate = date.fromisoformat(args.date) if args.date else datetime.now(ET).date()
    now = datetime.now(timezone.utc)
    client = HttpClient()
    state = read_state_parts(args.state)
    artifact = read_json(args.model)
    performance = read_json(args.performance)
    diagnostics = refresh_state(client, state, slate - timedelta(days=1))

    games = schedule_games(client, slate)
    codes = team_codes(client, slate.year)
    pool = season_hitter_pool(client, slate.year)
    static = state.get("static") or {}
    year_key = str(slate.year - 1)
    sprint = (static.get("sprints") or {}).get(year_key) or {}
    park_factors = (static.get("parks") or {}).get(year_key) or {}
    venues = static.get("venues") or {}
    games_by_team: dict[int, dict[str, Any]] = {}
    forecasts: dict[int, dict[str, Any]] = {}

    def forecast(game: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        venue_id = int((game.get("venue") or {}).get("id") or 0)
        venue = venues.get(str(venue_id)) or {}
        raw_time = str(game.get("gameDate") or "")
        game_time = datetime.fromisoformat(raw_time.replace("Z", "+00:00"))
        try:
            return int(game["gamePk"]), open_meteo_weather(client, venue, game_time)
        except Exception as exc:
            diagnostics.append(f"Weather forecast failed for game {game.get('gamePk')}: {exc}")
            return int(game["gamePk"]), parse_schedule_weather(game)

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(forecast, game) for game in games]
        for future in as_completed(futures):
            game_pk, weather = future.result()
            forecasts[game_pk] = weather

    for game in games:
        teams = game.get("teams") or {}
        away = (teams.get("away") or {}).get("team") or {}
        home = (teams.get("home") or {}).get("team") or {}
        if away.get("id"):
            games_by_team[int(away["id"])] = {"game": game, "is_home": False}
        if home.get("id"):
            games_by_team[int(home["id"])] = {"game": game, "is_home": True}

    predictions: list[dict[str, Any]] = []
    for player in pool:
        team_id = int(player.get("team_id") or 0)
        assignment = games_by_team.get(team_id)
        batter_state = (state.get("batters") or {}).get(str(player["mlbam_id"]))
        if not assignment or not batter_state:
            continue
        game = assignment["game"]
        teams = game.get("teams") or {}
        opponent_side = "away" if assignment["is_home"] else "home"
        opponent_team = (teams.get(opponent_side) or {}).get("team") or {}
        probable = (teams.get(opponent_side) or {}).get("probablePitcher") or {}
        pitcher_id = int(probable.get("id") or 0) or None
        pitcher_state = (state.get("pitchers") or {}).get(str(pitcher_id)) if pitcher_id else None
        opponent_code = codes.get(int(opponent_team.get("id") or 0), "")
        opponent_state = (state.get("teams") or {}).get(opponent_code)
        venue_id = int((game.get("venue") or {}).get("id") or 0)
        venue = venues.get(str(venue_id)) or {}
        field = venue.get("field_info") or {}
        raw_time = str(game.get("gameDate") or "")
        game_time = datetime.fromisoformat(raw_time.replace("Z", "+00:00"))
        context = {
            "park": {
                "triple_factor": park_factors.get(str(venue_id), 100.0),
                "left_center": field.get("left_center"),
                "center": field.get("center"),
                "right_center": field.get("right_center"),
            },
            "venue": venue,
            "weather": forecasts.get(int(game["gamePk"])) or parse_schedule_weather(game),
            "sprint": sprint.get(str(player["mlbam_id"])) or {},
            "is_home": assignment["is_home"],
            "pitcher_throws": (pitcher_state or {}).get("throws"),
            "batter_stand": batter_state.get("stand"),
            "batter_age": batter_state.get("age"),
            "local_hour": 13 if str(game.get("dayNight") or "").lower() == "day" else 19,
        }
        features = build_feature_row(batter_state, pitcher_state, opponent_state, context, slate)
        probability = predict_probability(artifact, features)
        ranking_score = predict_model_probability(artifact, features)
        conservative = max(0.0001, probability * 0.75)
        predictions.append(
            {
                "player": player["player"],
                "mlbam_id": int(player["mlbam_id"]),
                "team_id": team_id,
                "team": player.get("team"),
                "game_pk": int(game["gamePk"]),
                "game_start_at": game.get("gameDate"),
                "matchup": f"{codes.get(int(((teams.get('away') or {}).get('team') or {}).get('id') or 0), 'AWAY')} @ {codes.get(int(((teams.get('home') or {}).get('team') or {}).get('id') or 0), 'HOME')}",
                "opponent": opponent_team.get("name"),
                "probable_pitcher": probable.get("fullName"),
                "predicted_hit_probability": probability,
                "model_rank_score": ranking_score,
                "conservative_probability": conservative,
                "fair_american_odds": fair_american(probability),
                "conservative_fair_odds": fair_american(conservative),
                "expected_plate_appearances": features["b_pa_game_30"],
                "last_lineup_slot": int(round(features["b_last_slot"])),
                "sprint_speed": features["b_sprint_speed"],
                "park_triple_factor": features["park_triple_factor"],
                "temperature_f": features["temperature_f"],
                "wind_out_mph": features["wind_out_mph"],
                "drivers": prediction_drivers(features),
            }
        )

    predictions.sort(
        key=lambda row: (
            -float(row["predicted_hit_probability"]),
            -float(row["model_rank_score"]),
            -float(row["expected_plate_appearances"]),
            str(row["player"]),
        )
    )
    for rank, row in enumerate(predictions, 1):
        row["probability_rank"] = rank

    output = {
        "schema_version": 1,
        "kind": "mlb_triples_pregame_probability_board",
        "status": "ready" if predictions else "no_scheduled_players",
        "slate_date": slate.isoformat(),
        "generated_at": now.isoformat(),
        "generated_at_et": now.astimezone(ET).isoformat(),
        "state_as_of": state.get("as_of"),
        "model_trained_through": artifact.get("training_window", {}).get("end"),
        "model_calibrated_through": artifact.get("calibration_window", {}).get("end"),
        "player_count": len(predictions),
        "recommended_policy": {
            "name": "Top five available prices by predicted hit probability",
            "count": 5,
            "price_rule": "Use the best archived pregame price; probability ranking is fixed before odds are applied.",
            "value_gate": "The tested ROI policy requires calibrated probability at least 1.25 times market break-even and expected ROI of at least 10%. The stricter green label also requires the 25%-haircut probability to clear break-even by 10%.",
        },
        "performance": {
            "out_of_time_2025": performance.get("out_of_time_2025"),
            "out_of_time_august_2026": performance.get("out_of_time_august_2026"),
            "odds_archive": performance.get("odds_archive"),
        },
        "sources": [
            "MLB Baseball Savant Statcast",
            "MLB Stats API schedules, probable pitchers and venues",
            "Baseball Savant sprint speed and park factors",
            "Open-Meteo game-time forecast",
        ],
        "sports_game_odds_objects_added": 0,
        "players": predictions,
        "diagnostics": diagnostics[:50],
        "warning": "Triples are rare. Probabilities and ROI are estimates, not guarantees; archive ROI remains provisional.",
    }
    write_state_parts(args.state, state)
    write_json(args.output, output)
    print(f"Triples model built: date={slate} players={len(predictions)} state_as_of={state.get('as_of')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
