from __future__ import annotations

import math
from datetime import date
from typing import Any

from src.triples_model import _bucket_at, _mean, _rate, weather_features


FEATURE_NAMES = (
    "b_single_pa_30", "b_single_pa_90",
    "b_double_pa_30", "b_double_pa_90",
    "b_triple_pa_30", "b_triple_pa_90",
    "b_hr_pa_30", "b_hr_pa_90",
    "b_hit_pa_30", "b_hit_pa_90", "b_hit_pa_season", "b_hit_pa_previous",
    "b_xbh_pa_30", "b_xbh_pa_90",
    "b_tb_pa_7", "b_tb_pa_30", "b_tb_pa_90", "b_tb_pa_season", "b_tb_pa_previous",
    "b_hard_bip_30", "b_hard_bip_90",
    "b_ev_30", "b_ev_90", "b_launch_angle_30",
    "b_xba_30", "b_xba_90", "b_xslg_30", "b_xslg_90",
    "b_line_bip_30", "b_fly_bip_30", "b_ground_bip_30",
    "b_pa_game_7", "b_pa_game_30",
    "b_strikeout_pa_30", "b_walk_pa_30",
    "b_rest_days", "b_last_slot", "b_age",
    "p_hit_pa_30", "p_hit_pa_90", "p_hit_pa_season",
    "p_double_pa_30", "p_hr_pa_30",
    "p_tb_pa_30", "p_tb_pa_90", "p_tb_pa_season",
    "p_hard_bip_30", "p_ev_30", "p_xba_30", "p_xslg_30", "p_pa_30",
    "t_hit_pa_30", "t_hit_pa_90", "t_tb_pa_30", "t_tb_pa_90", "t_hard_bip_30",
    "park_hit_factor", "park_double_factor", "park_hr_factor",
    "park_left_center", "park_center", "park_right_center", "park_elevation",
    "temperature_f", "humidity_pct", "pressure_hpa", "precipitation_mm",
    "wind_speed_mph", "wind_out_mph", "roof_closed",
    "is_home", "batter_left", "pitcher_left", "same_hand", "day_game",
    "month_sin", "month_cos",
)


def _sum(totals: dict[str, float], *keys: str) -> float:
    return sum(float(totals.get(key) or 0.0) for key in keys)


def _event_rate(totals: dict[str, float], keys: tuple[str, ...], prior: float, prior_weight: float = 40.0) -> float:
    numerator = _sum(totals, *keys) + prior * prior_weight
    denominator = float(totals.get("pa") or 0.0) + prior_weight
    return numerator / denominator if denominator > 0 else prior


def _tb_rate(totals: dict[str, float], prior: float = 0.33, prior_weight: float = 50.0) -> float:
    tb = (
        float(totals.get("single") or 0.0)
        + 2.0 * float(totals.get("double") or 0.0)
        + 3.0 * float(totals.get("triple") or 0.0)
        + 4.0 * float(totals.get("home_run") or 0.0)
    )
    pa = float(totals.get("pa") or 0.0)
    return (tb + prior * prior_weight) / (pa + prior_weight) if pa + prior_weight > 0 else prior


def game_total_bases(metrics: dict[str, float]) -> int:
    return int(round(
        float(metrics.get("single") or 0.0)
        + 2.0 * float(metrics.get("double") or 0.0)
        + 3.0 * float(metrics.get("triple") or 0.0)
        + 4.0 * float(metrics.get("home_run") or 0.0)
    ))


def target_two_plus(metrics: dict[str, float]) -> int:
    return int(game_total_bases(metrics) >= 2)


def form_probability(history: list[int], league_rate: float = 0.34) -> float:
    if not history:
        return league_rate
    wins = sum(history)
    season = (wins + league_rate * 12.0) / (len(history) + 12.0)

    def shrunk(window: int, weight: float) -> float:
        rows = history[-window:]
        return (sum(rows) + season * weight) / (len(rows) + weight)

    return 0.50 * shrunk(5, 4.0) + 0.30 * shrunk(10, 5.0) + 0.20 * shrunk(15, 6.0)


def build_feature_row(
    batter: dict[str, Any] | None,
    pitcher: dict[str, Any] | None,
    opponent: dict[str, Any] | None,
    context: dict[str, Any],
    on_date: date,
) -> dict[str, float]:
    b7, b30, b90 = (_bucket_at(batter, window, on_date) for window in (7, 30, 90))
    bs = _bucket_at(batter, "season", on_date)
    bp = _bucket_at(batter, "previous", on_date)
    p30, p90 = _bucket_at(pitcher, 30, on_date), _bucket_at(pitcher, 90, on_date)
    ps = _bucket_at(pitcher, "season", on_date)
    t30, t90 = _bucket_at(opponent, 30, on_date), _bucket_at(opponent, 90, on_date)
    park = context.get("park") or {}
    weather = weather_features(context)
    last_raw = batter.get("last_date") if batter else None
    rest = (on_date - date.fromisoformat(str(last_raw))).days if last_raw else 7
    pitcher_left = float(str((pitcher or {}).get("throws") or context.get("pitcher_throws") or "").upper() == "L")
    batter_stand = str((batter or {}).get("stand") or context.get("batter_stand") or "").upper()
    batter_left = 1.0 - pitcher_left if batter_stand == "S" else float(batter_stand == "L")
    game_hour = int(context.get("local_hour") or 19)
    month_angle = 2.0 * math.pi * (on_date.month - 1) / 12.0

    hit_keys = ("single", "double", "triple", "home_run")
    xbh_keys = ("double", "triple", "home_run")

    return {
        "b_single_pa_30": _rate(b30, "single", "pa", prior=0.145, prior_weight=40),
        "b_single_pa_90": _rate(b90, "single", "pa", prior=0.145, prior_weight=55),
        "b_double_pa_30": _rate(b30, "double", "pa", prior=0.045, prior_weight=40),
        "b_double_pa_90": _rate(b90, "double", "pa", prior=0.045, prior_weight=55),
        "b_triple_pa_30": _rate(b30, "triple", "pa", prior=0.004, prior_weight=50),
        "b_triple_pa_90": _rate(b90, "triple", "pa", prior=0.004, prior_weight=65),
        "b_hr_pa_30": _rate(b30, "home_run", "pa", prior=0.030, prior_weight=40),
        "b_hr_pa_90": _rate(b90, "home_run", "pa", prior=0.030, prior_weight=55),
        "b_hit_pa_30": _event_rate(b30, hit_keys, 0.224, 45),
        "b_hit_pa_90": _event_rate(b90, hit_keys, 0.224, 60),
        "b_hit_pa_season": _event_rate(bs, hit_keys, 0.224, 70),
        "b_hit_pa_previous": _event_rate(bp, hit_keys, 0.224, 90),
        "b_xbh_pa_30": _event_rate(b30, xbh_keys, 0.079, 45),
        "b_xbh_pa_90": _event_rate(b90, xbh_keys, 0.079, 60),
        "b_tb_pa_7": _tb_rate(b7, 0.33, 35),
        "b_tb_pa_30": _tb_rate(b30, 0.33, 50),
        "b_tb_pa_90": _tb_rate(b90, 0.33, 70),
        "b_tb_pa_season": _tb_rate(bs, 0.33, 90),
        "b_tb_pa_previous": _tb_rate(bp, 0.33, 110),
        "b_hard_bip_30": _rate(b30, "hard_hit", "ev_n", prior=0.39, prior_weight=35),
        "b_hard_bip_90": _rate(b90, "hard_hit", "ev_n", prior=0.39, prior_weight=50),
        "b_ev_30": _mean(b30, "ev_sum", "ev_n", 88.5),
        "b_ev_90": _mean(b90, "ev_sum", "ev_n", 88.5),
        "b_launch_angle_30": _mean(b30, "la_sum", "la_n", 12.0),
        "b_xba_30": _mean(b30, "xba_sum", "xmetric_n", 0.245),
        "b_xba_90": _mean(b90, "xba_sum", "xmetric_n", 0.245),
        "b_xslg_30": _mean(b30, "xslg_sum", "xmetric_n", 0.410),
        "b_xslg_90": _mean(b90, "xslg_sum", "xmetric_n", 0.410),
        "b_line_bip_30": _rate(b30, "line_drive", "bip", prior=0.20, prior_weight=35),
        "b_fly_bip_30": _rate(b30, "fly_ball", "bip", prior=0.24, prior_weight=35),
        "b_ground_bip_30": _rate(b30, "ground_ball", "bip", prior=0.43, prior_weight=35),
        "b_pa_game_7": _rate(b7, "pa", "games", prior=4.0, prior_weight=3),
        "b_pa_game_30": _rate(b30, "pa", "games", prior=4.0, prior_weight=5),
        "b_strikeout_pa_30": _rate(b30, "strikeout", "pa", prior=0.225, prior_weight=40),
        "b_walk_pa_30": _rate(b30, "walk", "pa", prior=0.085, prior_weight=40),
        "b_rest_days": float(max(0, min(rest, 14))),
        "b_last_slot": float((batter or {}).get("last_slot") or 6.0),
        "b_age": float((batter or {}).get("age") or context.get("batter_age") or 28.0),
        "p_hit_pa_30": _event_rate(p30, hit_keys, 0.224, 60),
        "p_hit_pa_90": _event_rate(p90, hit_keys, 0.224, 90),
        "p_hit_pa_season": _event_rate(ps, hit_keys, 0.224, 110),
        "p_double_pa_30": _rate(p30, "double", "pa", prior=0.045, prior_weight=60),
        "p_hr_pa_30": _rate(p30, "home_run", "pa", prior=0.030, prior_weight=60),
        "p_tb_pa_30": _tb_rate(p30, 0.33, 70),
        "p_tb_pa_90": _tb_rate(p90, 0.33, 100),
        "p_tb_pa_season": _tb_rate(ps, 0.33, 120),
        "p_hard_bip_30": _rate(p30, "hard_hit", "ev_n", prior=0.39, prior_weight=55),
        "p_ev_30": _mean(p30, "ev_sum", "ev_n", 88.5),
        "p_xba_30": _mean(p30, "xba_sum", "xmetric_n", 0.245),
        "p_xslg_30": _mean(p30, "xslg_sum", "xmetric_n", 0.410),
        "p_pa_30": float(p30.get("pa") or 0.0),
        "t_hit_pa_30": _event_rate(t30, hit_keys, 0.224, 100),
        "t_hit_pa_90": _event_rate(t90, hit_keys, 0.224, 140),
        "t_tb_pa_30": _tb_rate(t30, 0.33, 110),
        "t_tb_pa_90": _tb_rate(t90, 0.33, 150),
        "t_hard_bip_30": _rate(t30, "hard_hit", "ev_n", prior=0.39, prior_weight=100),
        "park_hit_factor": float(park.get("hit_factor") or 100.0),
        "park_double_factor": float(park.get("double_factor") or 100.0),
        "park_hr_factor": float(park.get("hr_factor") or 100.0),
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
    while int(tree["children_left"][node]) != -1:
        feature = int(tree["feature"][node])
        node = int(tree["children_left"][node]) if row[feature] <= float(tree["threshold"][node]) else int(tree["children_right"][node])
    return float(tree["value"][node])


def _interpolate(value: float, xs: list[float], ys: list[float]) -> float:
    if not xs:
        return value
    if value <= xs[0]:
        return ys[0]
    if value >= xs[-1]:
        return ys[-1]
    low, high = 0, len(xs) - 1
    while high - low > 1:
        middle = (low + high) // 2
        if xs[middle] <= value:
            low = middle
        else:
            high = middle
    span = xs[high] - xs[low]
    weight = (value - xs[low]) / span if span else 0.0
    return ys[low] + weight * (ys[high] - ys[low])


def predict_model_probability(artifact: dict[str, Any], features: dict[str, float]) -> float:
    model = artifact.get("model") or artifact
    row = vectorize(features)
    raw = float(model.get("init_raw") or 0.0)
    for tree in model.get("trees") or []:
        raw += float(model.get("learning_rate") or 1.0) * _tree_value(tree, row)
    raw = max(-35.0, min(35.0, raw))
    return max(0.001, min(0.999, 1.0 / (1.0 + math.exp(-raw))))


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
    return max(0.001, min(0.999, probability))
