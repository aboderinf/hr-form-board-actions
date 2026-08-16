#!/usr/bin/env python3
from __future__ import annotations

import argparse
import calendar
import gzip
import json
import math
import re
import sys
import time
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.triples_model import (  # noqa: E402
    FEATURE_NAMES,
    build_feature_row,
    group_statcast_games,
    new_entity_state,
    predict_model_probability,
    predict_probability,
    update_entity,
    vectorize,
    write_state_parts,
)


SAVANT = "https://baseballsavant.mlb.com"
MLB = "https://statsapi.mlb.com/api/v1"
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


def get_bytes(url: str, attempts: int = 4) -> bytes:
    error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(
                url,
                headers={
                    "User-Agent": "MLBTriplesResearch/1.0",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            with urlopen(request, timeout=120) as response:
                return response.read()
        except Exception as exc:
            error = exc
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"GET failed {url}: {error}")


def cached_bytes(path: Path, url: str) -> bytes:
    if path.exists() and path.stat().st_size > 0:
        return path.read_bytes()
    payload = get_bytes(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return payload


def cached_json(path: Path, url: str) -> dict[str, Any]:
    return json.loads(cached_bytes(path, url))


def extract_page_data(payload: bytes) -> list[dict[str, Any]]:
    text = payload.decode("utf-8", errors="replace")
    match = re.search(r"\bvar\s+data\s*=\s*(\[.*?\]);\s*\n", text, re.DOTALL)
    if not match:
        raise RuntimeError("Baseball Savant page did not contain its data payload")
    return list(json.loads(match.group(1)))


def month_ranges(start: date, end: date) -> list[tuple[date, date]]:
    output = []
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        last_day = calendar.monthrange(cursor.year, cursor.month)[1]
        left = max(start, cursor)
        right = min(end, date(cursor.year, cursor.month, last_day))
        output.append((left, right))
        cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
    return output


def statcast_path(cache: Path, start: date, end: date) -> Path:
    path = cache / "statcast" / f"pa_{start.isoformat()}_{end.isoformat()}.csv.gz"
    if path.exists() and path.stat().st_size > 100:
        return path
    params = {
        "all": "true",
        "type": "details",
        "player_type": "batter",
        "game_date_gt": start.isoformat(),
        "game_date_lt": end.isoformat(),
        "hfGT": "R|",
        "hfAB": "|".join(PA_EVENTS) + "|",
    }
    raw = get_bytes(f"{SAVANT}/statcast_search/csv?{urlencode(params)}")
    if raw.count(b"\n") < 2:
        raise RuntimeError(f"Statcast returned no PA rows for {start} to {end}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb", compresslevel=6) as handle:
        handle.write(raw)
    return path


def inflate_csv(path: Path, work: Path) -> Path:
    target = work / path.name.removesuffix(".gz")
    if not target.exists() or target.stat().st_size == 0:
        target.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(path, "rb") as source, target.open("wb") as destination:
            destination.write(source.read())
    return target


def schedule_payload(cache: Path, season: int) -> dict[str, Any]:
    params = urlencode(
        {
            "sportId": 1,
            "gameType": "R",
            "startDate": f"{season}-03-01",
            "endDate": f"{season}-11-15",
            "hydrate": "probablePitcher,venue,weather",
        }
    )
    return cached_json(cache / "schedule" / f"{season}.json", f"{MLB}/schedule?{params}")


def venue_payload(cache: Path, venue_ids: set[int]) -> dict[int, dict[str, Any]]:
    ids = sorted(venue_ids)
    path = cache / "venues" / ("-".join(map(str, ids)) + ".json")
    params = urlencode({"venueIds": ",".join(map(str, ids)), "hydrate": "location,fieldInfo"})
    payload = cached_json(path, f"{MLB}/venues?{params}")
    output = {}
    for venue in payload.get("venues") or []:
        location = venue.get("location") or {}
        field = venue.get("fieldInfo") or {}
        output[int(venue["id"])] = {
            "id": int(venue["id"]),
            "name": venue.get("name"),
            "location": {
                "latitude": (location.get("defaultCoordinates") or {}).get("latitude"),
                "longitude": (location.get("defaultCoordinates") or {}).get("longitude"),
                "azimuth": location.get("azimuthAngle"),
                "elevation": location.get("elevation"),
            },
            "field_info": {
                "roof_type": field.get("roofType"),
                "left_center": field.get("leftCenter"),
                "center": field.get("center"),
                "right_center": field.get("rightCenter"),
            },
        }
    return output


def park_factors(cache: Path, season: int) -> dict[int, float]:
    params = urlencode(
        {
            "type": "year",
            "year": season,
            "batSide": "",
            "stat": "index_triple",
            "condition": "All",
            "rolling": "",
        }
    )
    payload = cached_bytes(
        cache / "park" / f"{season}.html",
        f"{SAVANT}/leaderboard/statcast-park-factors?{params}",
    )
    return {
        int(row["venue_id"]): float(row.get("index_3b") or 100.0)
        for row in extract_page_data(payload)
        if row.get("venue_id")
    }


def sprint_speeds(cache: Path, season: int) -> dict[int, dict[str, float]]:
    params = urlencode({"year": season, "position": "", "team": "", "min": 1})
    payload = cached_bytes(
        cache / "sprint" / f"{season}.html",
        f"{SAVANT}/leaderboard/sprint_speed?{params}",
    )
    output = {}
    for row in extract_page_data(payload):
        player_id = row.get("runner_id")
        if not player_id:
            continue
        opportunities = float(row.get("n") or 0.0)
        output[int(player_id)] = {
            "sprint_speed": float(row.get("r_sprint_speed_top50percent") or 27.0),
            "bolts_rate": float(row.get("n_bolts") or 0.0) / opportunities if opportunities else 0.0,
            "home_to_first": float(row.get("hp_to_1b") or 4.45),
        }
    return output


def parse_recorded_weather(game: dict[str, Any]) -> dict[str, Any]:
    raw = game.get("weather") or {}
    temperature = None
    try:
        temperature = float(raw.get("temp"))
    except (TypeError, ValueError):
        pass
    wind = str(raw.get("wind") or "")
    match = re.search(r"([0-9.]+)\s*mph", wind, re.IGNORECASE)
    speed = float(match.group(1)) if match else 0.0
    lower = wind.lower()
    if "out to" in lower:
        wind_out = speed
    elif "in from" in lower:
        wind_out = -speed
    else:
        wind_out = 0.0
    return {
        "temperature_f": temperature,
        "wind_speed_mph": speed,
        "wind_out_mph": wind_out,
        "condition": raw.get("condition"),
    }


def schedule_index(
    cache: Path,
    seasons: list[int],
) -> tuple[
    dict[int, dict[str, Any]],
    dict[int, dict[str, Any]],
    dict[int, tuple[date, date]],
]:
    games: dict[int, dict[str, Any]] = {}
    venue_ids: set[int] = set()
    bounds: dict[int, tuple[date, date]] = {}
    raw_seasons = {season: schedule_payload(cache, season) for season in seasons}
    for season, payload in raw_seasons.items():
        slate_dates = [
            date.fromisoformat(str(row["date"]))
            for row in payload.get("dates") or []
            if row.get("games")
        ]
        if slate_dates:
            bounds[season] = (min(slate_dates), max(slate_dates))
        for date_row in payload.get("dates") or []:
            for game in date_row.get("games") or []:
                venue_id = int((game.get("venue") or {}).get("id") or 0)
                if venue_id:
                    venue_ids.add(venue_id)
                games[int(game["gamePk"])] = {
                    "game_pk": int(game["gamePk"]),
                    "game_date": game.get("gameDate"),
                    "day_game": str(game.get("dayNight") or "").lower() == "day",
                    "venue_id": venue_id or None,
                    "weather": parse_recorded_weather(game),
                }
    venues = venue_payload(cache, venue_ids)
    return games, venues, bounds


def add_totals(left: dict[str, float], right: dict[str, float]) -> dict[str, float]:
    return {key: float(left.get(key) or 0.0) + float(right.get(key) or 0.0) for key in set(left) | set(right)}


def normalized_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(character for character in value if not unicodedata.combining(character))
    value = re.sub(r"\b(jr|sr|ii|iii|iv)\.?\b", "", value.lower())
    if "," in value:
        last, first = value.split(",", 1)
        value = f"{first} {last}"
    return re.sub(r"[^a-z0-9]+", "", value)


def game_context(
    game: dict[str, Any],
    meta: dict[str, Any],
    venues: dict[int, dict[str, Any]],
    factors: dict[int, float],
    sprint: dict[int, dict[str, float]],
    batter: dict[str, Any],
    side: dict[str, Any],
) -> dict[str, Any]:
    venue_id = int(meta.get("venue_id") or 0)
    venue = venues.get(venue_id) or {}
    field = venue.get("field_info") or {}
    return {
        "park": {
            "triple_factor": factors.get(venue_id, 100.0),
            "left_center": field.get("left_center"),
            "center": field.get("center"),
            "right_center": field.get("right_center"),
        },
        "venue": venue,
        "weather": meta.get("weather") or {},
        "sprint": sprint.get(int(batter["batter"])) or {},
        "is_home": side.get("team") == game.get("home_team"),
        "pitcher_throws": side.get("pitcher_throws"),
        "batter_stand": batter.get("stand"),
        "batter_age": batter.get("age"),
        "local_hour": 13 if meta.get("day_game") else 19,
    }


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


def build_examples(
    cache: Path,
    work: Path,
    start: date,
    end: date,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    seasons = list(range(start.year, end.year + 1))
    schedules, venues, season_bounds = schedule_index(cache, seasons)
    parks = {year: park_factors(cache, year) for year in range(start.year - 1, end.year)}
    sprints = {year: sprint_speeds(cache, year) for year in range(start.year - 1, end.year)}
    state: dict[str, Any] = {"schema_version": 1, "as_of": None, "batters": {}, "pitchers": {}, "teams": {}}
    rows: list[list[float]] = []
    targets: list[int] = []
    metadata: list[dict[str, Any]] = []

    ranges: list[tuple[date, date]] = []
    for season in seasons:
        if season not in season_bounds:
            continue
        season_start, season_end = season_bounds[season]
        ranges.extend(month_ranges(max(start, season_start), min(end, season_end)))

    for left, right in ranges:
        print(f"Loading Statcast plate appearances {left} to {right}", flush=True)
        compressed = statcast_path(cache, left, right)
        csv_path = inflate_csv(compressed, work)
        grouped = group_statcast_games(csv_path)
        for day_text in sorted(grouped):
            on_date = date.fromisoformat(day_text)
            day_games = grouped[day_text]
            for game in day_games:
                meta = schedules.get(int(game["game_pk"])) or {}
                factors = parks.get(on_date.year - 1) or {}
                sprint = sprints.get(on_date.year - 1) or {}
                for side in game.get("sides") or []:
                    pitcher_id = str(side.get("starter_pitcher") or "")
                    pitcher_state = state["pitchers"].get(pitcher_id)
                    opponent_state = state["teams"].get(str(side.get("opponent") or ""))
                    for batter in side.get("starters") or []:
                        batter_id = str(batter["batter"])
                        context = game_context(game, meta, venues, factors, sprint, batter, side)
                        features = build_feature_row(
                            state["batters"].get(batter_id),
                            pitcher_state,
                            opponent_state,
                            context,
                            on_date,
                        )
                        rows.append(vectorize(features))
                        target = int(float(batter["metrics"].get("triple") or 0.0) > 0)
                        targets.append(target)
                        metadata.append(
                            {
                                "date": day_text,
                                "year": on_date.year,
                                "game_pk": int(game["game_pk"]),
                                "batter_id": int(batter["batter"]),
                                "player": batter.get("name"),
                                "player_key": normalized_name(str(batter.get("name") or "")),
                                "matchup": f"{game.get('away_team')} @ {game.get('home_team')}",
                                "target": target,
                            }
                        )
            update_day_state(state, day_games, on_date)
            state["as_of"] = day_text
        try:
            csv_path.unlink()
        except OSError:
            pass
    state["source"] = "Baseball Savant Statcast PA-ending pitches; pregame rolling state"
    static = {
        "parks": {str(year): {str(key): value for key, value in values.items()} for year, values in parks.items()},
        "sprints": {str(year): {str(key): value for key, value in values.items()} for year, values in sprints.items()},
        "venues": {str(key): value for key, value in venues.items()},
    }
    return np.asarray(rows, dtype=np.float32), np.asarray(targets, dtype=np.int8), metadata, state, static


def metrics(
    y: np.ndarray,
    probability: np.ndarray,
    dates: list[str],
    ranking_score: np.ndarray | None = None,
) -> dict[str, Any]:
    clipped = np.clip(probability, 1e-6, 1 - 1e-6)
    ranking = ranking_score if ranking_score is not None else probability
    by_date: dict[str, list[int]] = defaultdict(list)
    for index, day in enumerate(dates):
        by_date[day].append(index)
    top5: list[int] = []
    top10: list[int] = []
    for indexes in by_date.values():
        ranked = sorted(indexes, key=lambda index: float(ranking[index]), reverse=True)
        top5.extend(ranked[:5])
        top10.extend(ranked[:10])
    return {
        "rows": int(len(y)),
        "positives": int(y.sum()),
        "prevalence": float(y.mean()),
        "log_loss": float(log_loss(y, clipped, labels=[0, 1])),
        "brier": float(brier_score_loss(y, clipped)),
        "average_precision": float(average_precision_score(y, clipped)),
        "roc_auc": float(roc_auc_score(y, clipped)),
        "top5_hit_rate": float(y[top5].mean()) if top5 else None,
        "top5_hits": int(y[top5].sum()) if top5 else 0,
        "top5_bets": len(top5),
        "top10_hit_rate": float(y[top10].mean()) if top10 else None,
        "top10_hits": int(y[top10].sum()) if top10 else 0,
        "top10_bets": len(top10),
    }


def fit_model(x: np.ndarray, y: np.ndarray, params: dict[str, Any]) -> HistGradientBoostingClassifier:
    model = HistGradientBoostingClassifier(
        loss="log_loss",
        learning_rate=params["learning_rate"],
        max_iter=params["max_iter"],
        max_leaf_nodes=params["max_leaf_nodes"],
        min_samples_leaf=params["min_samples_leaf"],
        l2_regularization=params["l2_regularization"],
        max_bins=255,
        early_stopping=False,
        random_state=20260816,
    )
    model.fit(x, y)
    return model


def export_model(
    model: HistGradientBoostingClassifier,
    calibration: IsotonicRegression,
) -> dict[str, Any]:
    trees = []
    for iteration in model._predictors:  # type: ignore[attr-defined]
        nodes = iteration[0].nodes
        trees.append(
            {
                "children_left": [int(node["left"]) if not bool(node["is_leaf"]) else -1 for node in nodes],
                "children_right": [int(node["right"]) if not bool(node["is_leaf"]) else -1 for node in nodes],
                "feature": [int(node["feature_idx"]) for node in nodes],
                "threshold": [float(node["num_threshold"]) for node in nodes],
                "value": [float(node["value"]) for node in nodes],
            }
        )
    return {
        "type": "hist_gradient_boosting_binary",
        "feature_names": list(FEATURE_NAMES),
        "init_raw": float(np.asarray(model._baseline_prediction).ravel()[0]),  # type: ignore[attr-defined]
        "learning_rate": 1.0,
        "trees": trees,
        "calibration": {
            "method": "isotonic",
            "x": [float(value) for value in calibration.X_thresholds_],
            "y": [float(value) for value in calibration.y_thresholds_],
        },
    }


def american_decimal(odds: int) -> float:
    return 1.0 + (odds / 100.0 if odds > 0 else 100.0 / abs(odds))


def implied_probability(odds: int) -> float:
    return 1.0 / american_decimal(odds)


def settle_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    wins = sum(int(row["target"]) for row in rows)
    net = sum((american_decimal(int(row["odds"])) - 1.0) if row["target"] else -1.0 for row in rows)
    return {
        "bets": len(rows),
        "wins": wins,
        "losses": len(rows) - wins,
        "hit_rate": wins / len(rows) if rows else None,
        "net_units": net,
        "roi": net / len(rows) if rows else None,
        "slates": len({row["date"] for row in rows}),
    }


def archive_backtest(
    metadata: list[dict[str, Any]],
    probabilities: np.ndarray,
    ranking_scores: np.ndarray,
    archive_dir: Path,
) -> dict[str, Any]:
    predictions: dict[tuple[str, str, str], dict[str, Any]] = {}
    loose: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for meta, probability, ranking_score in zip(metadata, probabilities, ranking_scores, strict=True):
        row = {**meta, "probability": float(probability), "ranking_score": float(ranking_score)}
        predictions[(meta["date"], meta["player_key"], meta["matchup"])] = row
        loose[(meta["date"], meta["player_key"])].append(row)

    checkpoint_rows: list[dict[str, Any]] = []
    for path in sorted(archive_dir.glob("*.json")):
        capture = json.loads(path.read_text(encoding="utf-8"))
        slate = str(capture.get("date") or "")
        checkpoint = str(capture.get("checkpoint") or "")
        for provider_row in capture.get("rows") or []:
            quotes = [
                (book, int(quote["americanOdds"]))
                for book, quote in (provider_row.get("odds") or {}).items()
                if quote.get("americanOdds") is not None
            ]
            if not quotes:
                continue
            book, odds = max(quotes, key=lambda item: item[1])
            name_key = normalized_name(str(provider_row.get("batterName") or ""))
            matchup = str(provider_row.get("matchup") or "")
            prediction = predictions.get((slate, name_key, matchup))
            if prediction is None:
                options = loose.get((slate, name_key)) or []
                prediction = options[0] if len(options) == 1 else None
            if prediction is None:
                continue
            p = float(prediction["probability"])
            checkpoint_rows.append(
                {
                    "date": slate,
                    "checkpoint": checkpoint,
                    "player": provider_row.get("batterName"),
                    "odds": odds,
                    "book": book,
                    "probability": p,
                    "ranking_score": float(prediction["ranking_score"]),
                    "target": int(prediction["target"]),
                    "expected_roi": p * american_decimal(odds) - 1.0,
                    "edge_ratio": p / implied_probability(odds),
                }
            )

    best: dict[tuple[str, str], dict[str, Any]] = {}
    for row in checkpoint_rows:
        key = (row["date"], normalized_name(str(row["player"])))
        if key not in best or int(row["odds"]) > int(best[key]["odds"]):
            best[key] = row
    best_rows = list(best.values())
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in best_rows:
        by_date[row["date"]].append(row)

    hit_policy: list[dict[str, Any]] = []
    value_policy: list[dict[str, Any]] = []
    for rows in by_date.values():
        hit_policy.extend(sorted(rows, key=lambda row: row["ranking_score"], reverse=True)[:5])
        eligible = [
            row
            for row in rows
            if row["edge_ratio"] >= 1.25 and row["expected_roi"] >= 0.10
        ]
        value_policy.extend(sorted(eligible, key=lambda row: row["expected_roi"], reverse=True)[:5])
    return {
        "status": "provisional" if len(by_date) < 30 else "developing",
        "archive_rows_matched": len(best_rows),
        "archive_slates": len(by_date),
        "warning": "The odds archive is too short to optimize thresholds. Policies were pre-registered before evaluation and remain provisional.",
        "all_priced": settle_summary(best_rows),
        "top5_hit_probability": settle_summary(hit_policy),
        "top5_positive_ev": settle_summary(value_policy),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2020-07-23")
    parser.add_argument("--end", default="2026-08-15")
    parser.add_argument("--cache-dir", type=Path, default=Path("/tmp/mlb-triples-model-cache"))
    parser.add_argument("--work-dir", type=Path, default=Path("/tmp/mlb-triples-model-work"))
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data" / "triples-model")
    args = parser.parse_args()
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    args.work_dir.mkdir(parents=True, exist_ok=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    x, y, meta, state, static = build_examples(args.cache_dir, args.work_dir, start, end)
    years = np.asarray([int(row["year"]) for row in meta])
    dates = np.asarray([str(row["date"]) for row in meta])
    candidate_params = [
        {"learning_rate": 0.05, "max_iter": 180, "max_leaf_nodes": 7, "min_samples_leaf": 160, "l2_regularization": 2.0},
        {"learning_rate": 0.04, "max_iter": 240, "max_leaf_nodes": 7, "min_samples_leaf": 240, "l2_regularization": 4.0},
        {"learning_rate": 0.035, "max_iter": 260, "max_leaf_nodes": 11, "min_samples_leaf": 240, "l2_regularization": 6.0},
    ]
    train = (years >= 2021) & (years <= 2023)
    validation = years == 2024
    test = years == 2025
    trials = []
    best_trial: tuple[float, dict[str, Any]] | None = None
    for params in candidate_params:
        print(f"Fitting candidate {params}", flush=True)
        model = fit_model(x[train], y[train], params)
        validation_raw = model.predict_proba(x[validation])[:, 1]
        trial_metrics = metrics(y[validation], validation_raw, dates[validation].tolist())
        score = float(trial_metrics["average_precision"]) + 2.0 * float(trial_metrics["top10_hit_rate"])
        trials.append({"params": params, "validation": trial_metrics, "selection_score": score})
        if best_trial is None or score > best_trial[0]:
            best_trial = (score, params)
    assert best_trial is not None
    selected = best_trial[1]

    base = fit_model(x[(years >= 2021) & (years <= 2023)], y[(years >= 2021) & (years <= 2023)], selected)
    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0001, y_max=0.25)
    calibrator.fit(base.predict_proba(x[validation])[:, 1], y[validation])
    test_ranking = base.predict_proba(x[test])[:, 1]
    test_probability = calibrator.predict(test_ranking)
    holdout_2025 = metrics(y[test], test_probability, dates[test].tolist(), test_ranking)

    final_train = (years >= 2021) & (years <= 2025)
    final = fit_model(x[final_train], y[final_train], selected)
    calibration_2026 = (dates >= "2026-03-01") & (dates <= "2026-07-31")
    final_calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0001, y_max=0.25)
    final_calibrator.fit(final.predict_proba(x[calibration_2026])[:, 1], y[calibration_2026])
    artifact = {
        "schema_version": 1,
        "kind": "mlb_batter_triples_probability_model",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_window": {"start": "2021-01-01", "end": "2025-12-31"},
        "calibration_window": {"start": "2026-03-01", "end": "2026-07-31"},
        "feature_names": list(FEATURE_NAMES),
        "selected_params": selected,
        "model": export_model(final, final_calibrator),
    }
    exported_probability = np.asarray(
        [predict_probability(artifact, dict(zip(FEATURE_NAMES, row, strict=True))) for row in x],
        dtype=float,
    )
    exported_ranking = np.asarray(
        [predict_model_probability(artifact, dict(zip(FEATURE_NAMES, row, strict=True))) for row in x],
        dtype=float,
    )
    sklearn_probability = final_calibrator.predict(final.predict_proba(x)[:, 1])
    max_difference = float(np.max(np.abs(exported_probability - sklearn_probability)))
    if max_difference > 1e-8:
        raise RuntimeError(f"Exported tree inference mismatch: {max_difference}")

    august_test = dates >= "2026-08-01"
    holdout_august = metrics(
        y[august_test],
        exported_probability[august_test],
        dates[august_test].tolist(),
        exported_ranking[august_test],
    )
    archive = archive_backtest(
        meta,
        exported_probability,
        exported_ranking,
        ROOT / "data" / "triples-discovery" / "archive",
    )
    performance = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_status": "research_ready",
        "observations": int(len(y)),
        "triples": int(y.sum()),
        "candidate_trials": trials,
        "out_of_time_2025": holdout_2025,
        "out_of_time_august_2026": holdout_august,
        "odds_archive": archive,
        "export_max_probability_difference": max_difference,
        "sources": [
            "MLB Baseball Savant Statcast PA-level CSV",
            "MLB Stats API schedules, probable pitchers, venues, park dimensions, and recorded weather",
            "Baseball Savant sprint speed leaderboard",
            "Baseball Savant Statcast park factors",
            "Existing archived SportsGameOdds triples prices",
        ],
        "leakage_policy": "Every rolling performance feature is calculated before the slate date. Model selection uses 2024, probability testing uses 2025 and August 2026, and the odds archive is not used to fit the hit model or tune the betting thresholds.",
        "warning": "Predictive performance is historical and not a guarantee. Odds-archive ROI remains provisional until substantially more slates settle.",
    }
    state["as_of"] = end.isoformat()
    state["model_feature_schema"] = 1
    prune_before = (end - timedelta(days=450)).isoformat()
    for entity_type in ("batters", "pitchers"):
        state[entity_type] = {
            key: value
            for key, value in state[entity_type].items()
            if str(value.get("last_date") or "") >= prune_before
        }
    state["static"] = {
        "parks": {str(end.year - 1): static["parks"].get(str(end.year - 1), {})},
        "sprints": {str(end.year - 1): static["sprints"].get(str(end.year - 1), {})},
        "venues": static["venues"],
    }

    (args.output_dir / "model.json").write_text(json.dumps(artifact, separators=(",", ":")) + "\n", encoding="utf-8")
    (args.output_dir / "performance.json").write_text(json.dumps(performance, indent=2) + "\n", encoding="utf-8")
    write_state_parts(args.output_dir / "state-parts", state)
    print(json.dumps({"model": artifact["selected_params"], "2025": holdout_2025, "august": holdout_august, "archive": archive}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
