from __future__ import annotations

import csv
import gzip
import hashlib
import json
import math
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Iterable


HALF_LIVES = (7, 30, 90)
RATE_PRIOR_PA = 40.0
TRIPLE_PRIOR = 0.0042

COUNT_METRICS = (
    "games",
    "pa",
    "single",
    "double",
    "triple",
    "home_run",
    "walk",
    "strikeout",
    "bip",
    "of_bip",
    "line_drive",
    "fly_ball",
    "ground_ball",
    "hard_hit",
    "ev_sum",
    "ev_n",
    "la_sum",
    "la_n",
    "xba_sum",
    "xslg_sum",
    "xmetric_n",
    "distance_sum",
    "distance_n",
)


FEATURE_NAMES = (
    "b_triple_pa_7",
    "b_triple_pa_30",
    "b_triple_pa_90",
    "b_triple_pa_season",
    "b_triple_pa_previous",
    "b_triple_game_30",
    "b_triple_game_90",
    "b_double_pa_30",
    "b_double_pa_90",
    "b_home_run_pa_30",
    "b_of_bip_pa_30",
    "b_of_bip_pa_90",
    "b_line_bip_30",
    "b_line_bip_90",
    "b_hard_bip_30",
    "b_hard_bip_90",
    "b_ev_30",
    "b_ev_90",
    "b_launch_angle_30",
    "b_xba_30",
    "b_xslg_30",
    "b_pa_game_7",
    "b_pa_game_30",
    "b_strikeout_pa_30",
    "b_walk_pa_30",
    "b_age",
    "b_rest_days",
    "b_last_slot",
    "b_sprint_speed",
    "b_bolts_rate",
    "b_home_to_first",
    "p_triple_pa_30",
    "p_triple_pa_90",
    "p_triple_pa_season",
    "p_double_pa_30",
    "p_of_bip_pa_30",
    "p_line_bip_30",
    "p_hard_bip_30",
    "p_ev_30",
    "p_xslg_30",
    "p_pa_30",
    "t_triple_pa_30",
    "t_triple_pa_90",
    "t_triple_pa_season",
    "t_double_pa_30",
    "t_of_bip_pa_30",
    "t_hard_bip_30",
    "park_triple_factor",
    "park_left_center",
    "park_center",
    "park_right_center",
    "park_elevation",
    "temperature_f",
    "humidity_pct",
    "pressure_hpa",
    "precipitation_mm",
    "wind_speed_mph",
    "wind_out_mph",
    "roof_closed",
    "is_home",
    "batter_left",
    "pitcher_left",
    "same_hand",
    "day_game",
    "month_sin",
    "month_cos",
)


NON_BIP_EVENTS = {
    "walk",
    "intent_walk",
    "strikeout",
    "strikeout_double_play",
    "hit_by_pitch",
    "catcher_interf",
    "truncated_pa",
}


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def empty_totals() -> dict[str, float]:
    return {key: 0.0 for key in COUNT_METRICS}


def new_entity_state() -> dict[str, Any]:
    return {
        "last_date": None,
        "season_year": None,
        "season": empty_totals(),
        "previous": empty_totals(),
        "ewma": {str(half_life): empty_totals() for half_life in HALF_LIVES},
    }


def decay_entity(entity: dict[str, Any], on_date: date) -> None:
    last_raw = entity.get("last_date")
    if not last_raw:
        return
    elapsed = max(0, (on_date - date.fromisoformat(str(last_raw))).days)
    if elapsed <= 0:
        return
    for half_life in HALF_LIVES:
        factor = math.exp(-math.log(2.0) * elapsed / half_life)
        bucket = (entity.get("ewma") or {}).setdefault(str(half_life), empty_totals())
        for key in COUNT_METRICS:
            bucket[key] = float(bucket.get(key) or 0.0) * factor


def update_entity(
    entity: dict[str, Any],
    metrics: dict[str, float],
    on_date: date,
    **metadata: Any,
) -> None:
    decay_entity(entity, on_date)
    if entity.get("season_year") != on_date.year:
        if entity.get("season_year") is not None:
            entity["previous"] = {
                key: float((entity.get("season") or {}).get(key) or 0.0)
                for key in COUNT_METRICS
            }
        entity["season"] = empty_totals()
        entity["season_year"] = on_date.year
    for key in COUNT_METRICS:
        value = float(metrics.get(key) or 0.0)
        entity["season"][key] = float(entity["season"].get(key) or 0.0) + value
        for half_life in HALF_LIVES:
            bucket = entity["ewma"].setdefault(str(half_life), empty_totals())
            bucket[key] = float(bucket.get(key) or 0.0) + value
    entity["last_date"] = on_date.isoformat()
    for key, value in metadata.items():
        if value is not None:
            entity[key] = value


def _bucket(entity: dict[str, Any] | None, window: int | str) -> dict[str, float]:
    if not entity:
        return empty_totals()
    if window == "season":
        return entity.get("season") or empty_totals()
    if window == "previous":
        return entity.get("previous") or empty_totals()
    return (entity.get("ewma") or {}).get(str(window)) or empty_totals()


def _bucket_at(
    entity: dict[str, Any] | None,
    window: int | str,
    on_date: date,
) -> dict[str, float]:
    if not entity:
        return empty_totals()
    season_year = entity.get("season_year")
    if window == "season":
        return _bucket(entity, "season") if season_year == on_date.year else empty_totals()
    if window == "previous":
        return _bucket(entity, "previous") if season_year == on_date.year else _bucket(entity, "season")
    totals = _bucket(entity, window)
    last_raw = entity.get("last_date")
    elapsed = max(0, (on_date - date.fromisoformat(str(last_raw))).days) if last_raw else 0
    factor = math.exp(-math.log(2.0) * elapsed / int(window)) if elapsed else 1.0
    return {key: float(totals.get(key) or 0.0) * factor for key in COUNT_METRICS}


def _rate(
    totals: dict[str, float],
    numerator: str,
    denominator: str,
    *,
    prior: float = 0.0,
    prior_weight: float = 0.0,
) -> float:
    top = float(totals.get(numerator) or 0.0) + prior * prior_weight
    bottom = float(totals.get(denominator) or 0.0) + prior_weight
    return top / bottom if bottom > 0 else prior


def _mean(totals: dict[str, float], numerator: str, denominator: str, default: float) -> float:
    bottom = float(totals.get(denominator) or 0.0)
    return float(totals.get(numerator) or 0.0) / bottom if bottom > 0 else default


def _triples_rate(totals: dict[str, float]) -> float:
    return _rate(
        totals,
        "triple",
        "pa",
        prior=TRIPLE_PRIOR,
        prior_weight=RATE_PRIOR_PA,
    )


def summarize_pa_rows(rows: Iterable[dict[str, Any]]) -> dict[str, float]:
    rows = list(rows)
    totals = empty_totals()
    totals["games"] = 1.0
    totals["pa"] = float(len(rows))
    for row in rows:
        event = str(row.get("events") or "")
        if event in totals:
            totals[event] += 1.0
        if event in {"intent_walk"}:
            totals["walk"] += 1.0
        if event == "strikeout_double_play":
            totals["strikeout"] += 1.0
        if event not in NON_BIP_EVENTS:
            totals["bip"] += 1.0
            location = int(_number(row.get("hit_location")) or 0)
            if location in {7, 8, 9}:
                totals["of_bip"] += 1.0
            bb_type = str(row.get("bb_type") or "")
            if bb_type == "line_drive":
                totals["line_drive"] += 1.0
            elif bb_type == "fly_ball":
                totals["fly_ball"] += 1.0
            elif bb_type == "ground_ball":
                totals["ground_ball"] += 1.0
            ev = _number(row.get("launch_speed"))
            if ev is not None:
                totals["ev_sum"] += ev
                totals["ev_n"] += 1.0
                if ev >= 95.0:
                    totals["hard_hit"] += 1.0
            angle = _number(row.get("launch_angle"))
            if angle is not None:
                totals["la_sum"] += angle
                totals["la_n"] += 1.0
            xba = _number(row.get("estimated_ba_using_speedangle"))
            xslg = _number(row.get("estimated_slg_using_speedangle"))
            if xba is not None or xslg is not None:
                totals["xba_sum"] += xba or 0.0
                totals["xslg_sum"] += xslg or 0.0
                totals["xmetric_n"] += 1.0
            distance = _number(row.get("hit_distance_sc"))
            if distance is not None:
                totals["distance_sum"] += distance
                totals["distance_n"] += 1.0
    return totals


def group_statcast_games(path: Path) -> dict[str, list[dict[str, Any]]]:
    """Return compact games grouped by date from a Savant PA-ending-pitch CSV."""
    raw_games: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if not row.get("events") or not row.get("game_pk"):
                continue
            raw_games[(str(row["game_date"]), int(row["game_pk"]))].append(row)

    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for (game_date, game_pk), rows in raw_games.items():
        batting: dict[str, dict[int, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
        pitching: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            top = str(row.get("inning_topbot") or "").lower().startswith("top")
            batting_team = str(row.get("away_team") if top else row.get("home_team") or "")
            batter = int(row.get("batter") or 0)
            pitcher = int(row.get("pitcher") or 0)
            if batting_team and batter:
                batting[batting_team][batter].append(row)
            if pitcher:
                pitching[pitcher].append(row)

        sides: list[dict[str, Any]] = []
        for team, batter_rows in batting.items():
            ordered = sorted(
                batter_rows.items(),
                key=lambda item: min(int(row.get("at_bat_number") or 9999) for row in item[1]),
            )
            all_batters = []
            for order_index, (batter, player_rows) in enumerate(ordered, 1):
                first = min(player_rows, key=lambda row: int(row.get("at_bat_number") or 9999))
                all_batters.append(
                    {
                        "batter": batter,
                        "name": str(first.get("player_name") or ""),
                        "slot": order_index if order_index <= 9 else None,
                        "stand": str(first.get("stand") or ""),
                        "age": _number(first.get("age_bat")),
                        "metrics": summarize_pa_rows(player_rows),
                    }
                )
            starters = all_batters[:9]
            if ordered:
                first_rows = [row for _, player_rows in ordered[:9] for row in player_rows]
                first_pa = min(first_rows, key=lambda row: int(row.get("at_bat_number") or 9999))
                starter_pitcher = int(first_pa.get("pitcher") or 0) or None
                pitcher_throws = str(first_pa.get("p_throws") or "")
            else:
                starter_pitcher = None
                pitcher_throws = ""
            sides.append(
                {
                    "team": team,
                    "opponent": next((other for other in batting if other != team), ""),
                    "starter_pitcher": starter_pitcher,
                    "pitcher_throws": pitcher_throws,
                    "starters": starters,
                    "batters": all_batters,
                    "team_metrics": summarize_pa_rows(
                        row for player_rows in batter_rows.values() for row in player_rows
                    ),
                }
            )

        by_date[game_date].append(
            {
                "game_pk": game_pk,
                "date": game_date,
                "home_team": str(rows[0].get("home_team") or ""),
                "away_team": str(rows[0].get("away_team") or ""),
                "sides": sides,
                "pitchers": {
                    str(pitcher): {
                        "metrics": summarize_pa_rows(player_rows),
                        "throws": str(player_rows[0].get("p_throws") or ""),
                        "age": _number(player_rows[0].get("age_pit")),
                    }
                    for pitcher, player_rows in pitching.items()
                },
            }
        )
    return dict(by_date)


def weather_features(context: dict[str, Any]) -> dict[str, float]:
    weather = context.get("weather") or {}
    venue = context.get("venue") or {}
    field = venue.get("field_info") or {}
    location = venue.get("location") or {}
    roof_type = str(field.get("roof_type") or "").lower()
    condition = str(weather.get("condition") or "").lower()
    roof_closed = float(
        "dome" in condition
        or "closed" in condition
        or roof_type in {"dome", "fixed", "indoor"}
    )
    temperature = _number(weather.get("temperature_f"))
    humidity = _number(weather.get("humidity_pct"))
    pressure = _number(weather.get("pressure_hpa"))
    precipitation = _number(weather.get("precipitation_mm"))
    wind_speed = _number(weather.get("wind_speed_mph"))
    wind_out = _number(weather.get("wind_out_mph"))
    if roof_closed:
        temperature, wind_speed, wind_out, precipitation = 72.0, 0.0, 0.0, 0.0
    return {
        "temperature_f": temperature if temperature is not None else 72.0,
        "humidity_pct": humidity if humidity is not None else 55.0,
        "pressure_hpa": pressure if pressure is not None else 1013.0,
        "precipitation_mm": precipitation if precipitation is not None else 0.0,
        "wind_speed_mph": wind_speed if wind_speed is not None else 0.0,
        "wind_out_mph": wind_out if wind_out is not None else 0.0,
        "roof_closed": roof_closed,
        "elevation": _number(location.get("elevation")) or 0.0,
    }


def build_feature_row(
    batter: dict[str, Any] | None,
    pitcher: dict[str, Any] | None,
    opponent: dict[str, Any] | None,
    context: dict[str, Any],
    on_date: date,
) -> dict[str, float]:
    b7, b30, b90 = (_bucket_at(batter, window, on_date) for window in HALF_LIVES)
    bs = _bucket_at(batter, "season", on_date)
    bp = _bucket_at(batter, "previous", on_date)
    p30, p90 = _bucket_at(pitcher, 30, on_date), _bucket_at(pitcher, 90, on_date)
    ps = _bucket_at(pitcher, "season", on_date)
    t30, t90 = _bucket_at(opponent, 30, on_date), _bucket_at(opponent, 90, on_date)
    ts = _bucket_at(opponent, "season", on_date)
    park = context.get("park") or {}
    sprint = context.get("sprint") or {}
    weather = weather_features(context)
    last_raw = batter.get("last_date") if batter else None
    rest = (on_date - date.fromisoformat(str(last_raw))).days if last_raw else 7
    pitcher_left = float(str((pitcher or {}).get("throws") or context.get("pitcher_throws") or "").upper() == "L")
    batter_stand = str((batter or {}).get("stand") or context.get("batter_stand") or "").upper()
    batter_left = 1.0 - pitcher_left if batter_stand == "S" else float(batter_stand == "L")
    game_hour = int(context.get("local_hour") or 19)
    month_angle = 2.0 * math.pi * (on_date.month - 1) / 12.0

    return {
        "b_triple_pa_7": _triples_rate(b7),
        "b_triple_pa_30": _triples_rate(b30),
        "b_triple_pa_90": _triples_rate(b90),
        "b_triple_pa_season": _triples_rate(bs),
        "b_triple_pa_previous": _triples_rate(bp),
        "b_triple_game_30": _rate(b30, "triple", "games", prior=0.018, prior_weight=10),
        "b_triple_game_90": _rate(b90, "triple", "games", prior=0.018, prior_weight=10),
        "b_double_pa_30": _rate(b30, "double", "pa"),
        "b_double_pa_90": _rate(b90, "double", "pa"),
        "b_home_run_pa_30": _rate(b30, "home_run", "pa"),
        "b_of_bip_pa_30": _rate(b30, "of_bip", "pa"),
        "b_of_bip_pa_90": _rate(b90, "of_bip", "pa"),
        "b_line_bip_30": _rate(b30, "line_drive", "bip"),
        "b_line_bip_90": _rate(b90, "line_drive", "bip"),
        "b_hard_bip_30": _rate(b30, "hard_hit", "ev_n"),
        "b_hard_bip_90": _rate(b90, "hard_hit", "ev_n"),
        "b_ev_30": _mean(b30, "ev_sum", "ev_n", 88.0),
        "b_ev_90": _mean(b90, "ev_sum", "ev_n", 88.0),
        "b_launch_angle_30": _mean(b30, "la_sum", "la_n", 12.0),
        "b_xba_30": _mean(b30, "xba_sum", "xmetric_n", 0.245),
        "b_xslg_30": _mean(b30, "xslg_sum", "xmetric_n", 0.410),
        "b_pa_game_7": _rate(b7, "pa", "games"),
        "b_pa_game_30": _rate(b30, "pa", "games"),
        "b_strikeout_pa_30": _rate(b30, "strikeout", "pa"),
        "b_walk_pa_30": _rate(b30, "walk", "pa"),
        "b_age": float((batter or {}).get("age") or context.get("batter_age") or 28.0),
        "b_rest_days": float(max(0, min(rest, 14))),
        "b_last_slot": float((batter or {}).get("last_slot") or 6.0),
        "b_sprint_speed": float(sprint.get("sprint_speed") or 27.0),
        "b_bolts_rate": float(sprint.get("bolts_rate") or 0.0),
        "b_home_to_first": float(sprint.get("home_to_first") or 4.45),
        "p_triple_pa_30": _triples_rate(p30),
        "p_triple_pa_90": _triples_rate(p90),
        "p_triple_pa_season": _triples_rate(ps),
        "p_double_pa_30": _rate(p30, "double", "pa"),
        "p_of_bip_pa_30": _rate(p30, "of_bip", "pa"),
        "p_line_bip_30": _rate(p30, "line_drive", "bip"),
        "p_hard_bip_30": _rate(p30, "hard_hit", "ev_n"),
        "p_ev_30": _mean(p30, "ev_sum", "ev_n", 88.0),
        "p_xslg_30": _mean(p30, "xslg_sum", "xmetric_n", 0.410),
        "p_pa_30": float(p30.get("pa") or 0.0),
        "t_triple_pa_30": _triples_rate(t30),
        "t_triple_pa_90": _triples_rate(t90),
        "t_triple_pa_season": _triples_rate(ts),
        "t_double_pa_30": _rate(t30, "double", "pa"),
        "t_of_bip_pa_30": _rate(t30, "of_bip", "pa"),
        "t_hard_bip_30": _rate(t30, "hard_hit", "ev_n"),
        "park_triple_factor": float(park.get("triple_factor") or 100.0),
        "park_left_center": float(park.get("left_center") or 375.0),
        "park_center": float(park.get("center") or 400.0),
        "park_right_center": float(park.get("right_center") or 375.0),
        "park_elevation": weather["elevation"],
        "temperature_f": weather["temperature_f"],
        "humidity_pct": weather["humidity_pct"],
        "pressure_hpa": weather["pressure_hpa"],
        "precipitation_mm": weather["precipitation_mm"],
        "wind_speed_mph": weather["wind_speed_mph"],
        "wind_out_mph": weather["wind_out_mph"],
        "roof_closed": weather["roof_closed"],
        "is_home": float(bool(context.get("is_home"))),
        "batter_left": batter_left,
        "pitcher_left": pitcher_left,
        "same_hand": 0.0 if batter_stand == "S" else float(batter_left == pitcher_left),
        "day_game": float(game_hour < 17),
        "month_sin": math.sin(month_angle),
        "month_cos": math.cos(month_angle),
    }


def vectorize(features: dict[str, float]) -> list[float]:
    return [float(features.get(name) or 0.0) for name in FEATURE_NAMES]


def _tree_value(tree: dict[str, Any], row: list[float]) -> float:
    node = 0
    left = tree["children_left"]
    while int(left[node]) != -1:
        feature = int(tree["feature"][node])
        node = int(left[node]) if row[feature] <= float(tree["threshold"][node]) else int(tree["children_right"][node])
    return float(tree["value"][node])


def _interpolate(x: float, xs: list[float], ys: list[float]) -> float:
    if not xs:
        return x
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    low, high = 0, len(xs) - 1
    while high - low > 1:
        middle = (low + high) // 2
        if xs[middle] <= x:
            low = middle
        else:
            high = middle
    span = xs[high] - xs[low]
    weight = (x - xs[low]) / span if span else 0.0
    return ys[low] + weight * (ys[high] - ys[low])


def predict_model_probability(artifact: dict[str, Any], features: dict[str, float]) -> float:
    model = artifact.get("model") or artifact
    row = vectorize(features)
    raw = float(model.get("init_raw") or 0.0)
    learning_rate = float(model.get("learning_rate") or 1.0)
    for tree in model.get("trees") or []:
        raw += learning_rate * _tree_value(tree, row)
    raw = max(-35.0, min(35.0, raw))
    return max(0.0001, min(0.25, 1.0 / (1.0 + math.exp(-raw))))


def predict_probability(artifact: dict[str, Any], features: dict[str, float]) -> float:
    model = artifact.get("model") or artifact
    probability = predict_model_probability(artifact, features)
    calibration = model.get("calibration") or {}
    if calibration.get("x") and calibration.get("y"):
        probability = _interpolate(
            probability,
            [float(value) for value in calibration["x"]],
            [float(value) for value in calibration["y"]],
        )
    return max(0.0001, min(0.25, probability))


def fair_american(probability: float) -> int:
    probability = max(0.0001, min(0.9999, probability))
    if probability >= 0.5:
        return round(-100.0 * probability / (1.0 - probability))
    return round(100.0 * (1.0 - probability) / probability)


def write_state_parts(path: Path, state: dict[str, Any], part_bytes: int = 64 * 1024) -> None:
    """Store the rolling state as deterministic, Git-friendly compressed chunks."""
    raw = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    path.mkdir(parents=True, exist_ok=True)
    part_names: list[str] = []
    for index, offset in enumerate(range(0, len(compressed), part_bytes)):
        name = f"part-{index:03d}.bin"
        (path / name).write_bytes(compressed[offset : offset + part_bytes])
        part_names.append(name)
    for stale in path.glob("part-*.bin"):
        if stale.name not in part_names:
            stale.unlink()
    manifest = {
        "schema_version": 1,
        "codec": "gzip+json",
        "parts": part_names,
        "compressed_bytes": len(compressed),
        "uncompressed_bytes": len(raw),
        "sha256": hashlib.sha256(compressed).hexdigest(),
    }
    (path / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def read_state_parts(path: Path) -> dict[str, Any]:
    """Load a chunked state directory, with a legacy plain-JSON fallback."""
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
    compressed = b"".join((path / name).read_bytes() for name in manifest["parts"])
    if hashlib.sha256(compressed).hexdigest() != manifest["sha256"]:
        raise ValueError("Triples model state checksum mismatch")
    return json.loads(gzip.decompress(compressed).decode("utf-8"))
