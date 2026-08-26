#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.train_triples_model import (  # noqa: E402
    extract_page_data,
    game_context,
    inflate_csv,
    month_ranges,
    normalized_name,
    park_factors,
    schedule_index,
    sprint_speeds,
    statcast_path,
    update_day_state,
)
from src.total_bases_model import (  # noqa: E402
    FEATURE_NAMES,
    build_feature_row,
    form_probability,
    predict_model_probability,
    predict_probability,
    target_two_plus,
    vectorize,
)
from src.triples_model import group_statcast_games, write_state_parts  # noqa: E402


def park_factor_bundle(cache: Path, season: int) -> dict[int, dict[str, float]]:
    # The Savant park-factor page used by the triples model exposes the full row,
    # including 1B/2B/HR indices. Calling park_factors ensures the cached page exists.
    triples = park_factors(cache, season)
    payload = (cache / "park" / f"{season}.html").read_bytes()
    output: dict[int, dict[str, float]] = {}
    for row in extract_page_data(payload):
        venue = row.get("venue_id")
        if not venue:
            continue
        venue_id = int(venue)
        output[venue_id] = {
            "hit_factor": float(row.get("index_1b") or row.get("index_hit") or 100.0),
            "double_factor": float(row.get("index_2b") or 100.0),
            "hr_factor": float(row.get("index_hr") or 100.0),
            "triple_factor": float(row.get("index_3b") or triples.get(venue_id) or 100.0),
        }
    return output


def metrics(y: np.ndarray, probability: np.ndarray, dates: list[str], ranking: np.ndarray | None = None) -> dict[str, Any]:
    if len(y) == 0:
        return {"rows": 0}
    clipped = np.clip(probability, 1e-6, 1 - 1e-6)
    rank = ranking if ranking is not None else probability
    by_date: dict[str, list[int]] = defaultdict(list)
    for index, day in enumerate(dates):
        by_date[day].append(index)
    top5: list[int] = []
    top10: list[int] = []
    for indexes in by_date.values():
        ordered = sorted(indexes, key=lambda index: float(rank[index]), reverse=True)
        top5.extend(ordered[:5])
        top10.extend(ordered[:10])
    return {
        "rows": int(len(y)),
        "positives": int(y.sum()),
        "prevalence": float(y.mean()),
        "average_probability": float(clipped.mean()),
        "calibration_gap": float(clipped.mean() - y.mean()),
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
        random_state=20260826,
    )
    model.fit(x, y)
    return model


def export_model(model: HistGradientBoostingClassifier, calibration: IsotonicRegression) -> dict[str, Any]:
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
        # HistGradientBoosting predictor node values already contain shrinkage.
        "learning_rate": 1.0,
        "trees": trees,
        "calibration": {
            "method": "isotonic",
            "x": [float(value) for value in calibration.X_thresholds_],
            "y": [float(value) for value in calibration.y_thresholds_],
        },
    }


def build_examples(cache: Path, work: Path, start: date, end: date):
    seasons = list(range(start.year, end.year + 1))
    schedules, venues, season_bounds = schedule_index(cache, seasons)
    parks = {year: park_factor_bundle(cache, year) for year in range(start.year - 1, end.year)}
    sprints = {year: sprint_speeds(cache, year) for year in range(start.year - 1, end.year)}
    state: dict[str, Any] = {"schema_version": 2, "as_of": None, "batters": {}, "pitchers": {}, "teams": {}}
    form_history: dict[str, list[int]] = defaultdict(list)
    league_form_wins = 0
    league_form_n = 0
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
        print(f"Loading Total Bases Statcast PAs {left} to {right}", flush=True)
        compressed = statcast_path(cache, left, right)
        csv_path = inflate_csv(compressed, work)
        grouped = group_statcast_games(csv_path)
        for day_text in sorted(grouped):
            on_date = date.fromisoformat(day_text)
            day_games = grouped[day_text]
            pending_form: list[tuple[str, int]] = []
            for game in day_games:
                meta = schedules.get(int(game["game_pk"])) or {}
                park_year = on_date.year - 1
                park_for_year = parks.get(park_year) or {}
                sprint = sprints.get(park_year) or {}
                venue_id = int(meta.get("venue_id") or 0)
                factors = park_for_year.get(venue_id) or {}
                for side in game.get("sides") or []:
                    pitcher_id = str(side.get("starter_pitcher") or "")
                    pitcher_state = state["pitchers"].get(pitcher_id)
                    opponent_state = state["teams"].get(str(side.get("opponent") or ""))
                    for batter in side.get("starters") or []:
                        batter_id = str(batter["batter"])
                        context = game_context(game, meta, venues, {}, sprint, batter, side)
                        context["park"] = {
                            **(context.get("park") or {}),
                            **factors,
                        }
                        features = build_feature_row(
                            state["batters"].get(batter_id), pitcher_state, opponent_state, context, on_date
                        )
                        target = target_two_plus(batter["metrics"])
                        league_rate = (league_form_wins + 34.0) / (league_form_n + 100.0)
                        form_raw = form_probability(form_history[batter_id], league_rate)
                        rows.append(vectorize(features))
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
                                "form_probability_raw": float(form_raw),
                            }
                        )
                        pending_form.append((batter_id, target))
            # Day-level update prevents first-game outcomes from leaking into same-day doubleheaders.
            update_day_state(state, day_games, on_date)
            state["as_of"] = day_text
            for batter_id, target in pending_form:
                form_history[batter_id].append(target)
                league_form_wins += target
                league_form_n += 1
        try:
            csv_path.unlink()
        except OSError:
            pass

    state["source"] = "Baseball Savant Statcast PA-ending pitches; game-level TB>=2 target; pregame rolling state"
    state["model_feature_schema"] = 2
    state["static"] = {
        "parks": {str(year): {str(key): value for key, value in values.items()} for year, values in parks.items()},
        "sprints": {str(year): {str(key): value for key, value in values.items()} for year, values in sprints.items()},
        "venues": {str(key): value for key, value in venues.items()},
    }
    return np.asarray(rows, dtype=np.float32), np.asarray(targets, dtype=np.int8), metadata, state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2023-03-20")
    parser.add_argument("--end", default=(date.today() - timedelta(days=1)).isoformat())
    parser.add_argument("--holdout-start", default="2026-08-17")
    parser.add_argument("--cache-dir", type=Path, default=Path("/tmp/mlb-total-bases-v2-cache"))
    parser.add_argument("--work-dir", type=Path, default=Path("/tmp/mlb-total-bases-v2-work"))
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data" / "total-bases-model-v2")
    args = parser.parse_args()
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    holdout_start = date.fromisoformat(args.holdout_start)
    args.work_dir.mkdir(parents=True, exist_ok=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    x, y, meta, state = build_examples(args.cache_dir, args.work_dir, start, end)
    years = np.asarray([int(row["year"]) for row in meta])
    dates = np.asarray([str(row["date"]) for row in meta])
    form_raw = np.asarray([float(row["form_probability_raw"]) for row in meta], dtype=float)

    candidates = [
        {"learning_rate": 0.05, "max_iter": 180, "max_leaf_nodes": 15, "min_samples_leaf": 120, "l2_regularization": 3.0},
        {"learning_rate": 0.04, "max_iter": 230, "max_leaf_nodes": 15, "min_samples_leaf": 180, "l2_regularization": 5.0},
        {"learning_rate": 0.035, "max_iter": 260, "max_leaf_nodes": 23, "min_samples_leaf": 220, "l2_regularization": 7.0},
    ]
    train = years == 2023
    validation = years == 2024
    test = years == 2025
    if min(int(train.sum()), int(validation.sum()), int(test.sum())) < 1000:
        raise RuntimeError("Insufficient 2023-2025 rows for v2 temporal split")

    trials = []
    best: tuple[float, dict[str, Any]] | None = None
    for params in candidates:
        print(f"Fitting Total Bases v2 candidate {params}", flush=True)
        model = fit_model(x[train], y[train], params)
        raw = model.predict_proba(x[validation])[:, 1]
        result = metrics(y[validation], raw, dates[validation].tolist())
        score = -float(result["log_loss"]) - float(result["brier"]) + 0.15 * float(result["average_precision"])
        trials.append({"params": params, "validation": result, "selection_score": score})
        if best is None or score > best[0]:
            best = (score, params)
    assert best is not None
    selected = best[1]

    base = fit_model(x[train], y[train], selected)
    calibration_2024 = IsotonicRegression(out_of_bounds="clip", y_min=0.02, y_max=0.80)
    calibration_2024.fit(base.predict_proba(x[validation])[:, 1], y[validation])
    test_rank = base.predict_proba(x[test])[:, 1]
    test_p = calibration_2024.predict(test_rank)
    holdout_2025 = metrics(y[test], test_p, dates[test].tolist(), test_rank)

    final_train = (years >= 2023) & (years <= 2025)
    final = fit_model(x[final_train], y[final_train], selected)
    calibration_mask = (dates >= "2026-03-01") & (dates < args.holdout_start)
    holdout_mask = (dates >= args.holdout_start) & (dates <= end.isoformat())
    if int(calibration_mask.sum()) < 1000 or int(holdout_mask.sum()) < 200:
        raise RuntimeError("Insufficient 2026 calibration/holdout rows")

    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.02, y_max=0.80)
    calibrator.fit(final.predict_proba(x[calibration_mask])[:, 1], y[calibration_mask])
    form_calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.02, y_max=0.80)
    form_calibrator.fit(form_raw[calibration_mask], y[calibration_mask])

    artifact = {
        "schema_version": 2,
        "kind": "mlb_batter_two_plus_total_bases_statcast_model",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_window": {"start": "2023-01-01", "end": "2025-12-31"},
        "calibration_window": {"start": "2026-03-01", "end": (holdout_start - timedelta(days=1)).isoformat()},
        "feature_names": list(FEATURE_NAMES),
        "selected_params": selected,
        "model": export_model(final, calibrator),
    }

    exported = np.asarray(
        [predict_probability(artifact, dict(zip(FEATURE_NAMES, row, strict=True))) for row in x], dtype=float
    )
    exported_rank = np.asarray(
        [predict_model_probability(artifact, dict(zip(FEATURE_NAMES, row, strict=True))) for row in x], dtype=float
    )
    sklearn_p = calibrator.predict(final.predict_proba(x)[:, 1])
    max_difference = float(np.max(np.abs(exported - sklearn_p)))
    if max_difference > 1e-8:
        raise RuntimeError(f"Exported Total Bases v2 inference mismatch: {max_difference}")

    form_calibrated = form_calibrator.predict(form_raw)
    holdout_v2 = metrics(y[holdout_mask], exported[holdout_mask], dates[holdout_mask].tolist(), exported_rank[holdout_mask])
    holdout_form = metrics(y[holdout_mask], form_calibrated[holdout_mask], dates[holdout_mask].tolist(), form_raw[holdout_mask])
    improvement_vs_form = {
        "brier": float(holdout_form["brier"] - holdout_v2["brier"]),
        "log_loss": float(holdout_form["log_loss"] - holdout_v2["log_loss"]),
        "average_precision": float(holdout_v2["average_precision"] - holdout_form["average_precision"]),
        "roc_auc": float(holdout_v2["roc_auc"] - holdout_form["roc_auc"]),
    }

    august_mask = (dates >= "2026-08-02") & (dates <= end.isoformat())
    prediction_rows = []
    for index in np.flatnonzero(august_mask):
        row = meta[int(index)]
        prediction_rows.append(
            {
                "date": row["date"],
                "game_pk": row["game_pk"],
                "batter_id": row["batter_id"],
                "player": row["player"],
                "player_key": row["player_key"],
                "matchup": row["matchup"],
                "target": int(row["target"]),
                "probability": float(exported[index]),
                "ranking_probability": float(exported_rank[index]),
                "form_probability": float(form_calibrated[index]),
            }
        )

    performance = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_status": "research_ready",
        "observations": int(len(y)),
        "two_plus_total_bases": int(y.sum()),
        "candidate_trials": trials,
        "out_of_time_2025": holdout_2025,
        "holdout": {
            "start": args.holdout_start,
            "end": end.isoformat(),
            "v2": holdout_v2,
            "form": holdout_form,
            "improvement_vs_form": improvement_vs_form,
        },
        "export_max_probability_difference": max_difference,
        "sources": [
            "MLB Baseball Savant Statcast PA-level CSV",
            "MLB Stats API schedules, probable pitchers, venues, and recorded weather",
            "Baseball Savant Statcast park-factor leaderboard",
            "Pregame rolling batter, pitcher, and opponent state",
        ],
        "leakage_policy": "Every Statcast and context feature is calculated from dates before the target slate. Same-day doubleheader outcomes are not fed into one another. Sportsbook odds are excluded from model fitting, calibration, and hyperparameter selection.",
        "promotion_policy": "V2 must beat both v1 and the calibrated form baseline on untouched holdout Brier and log loss, then a betting threshold chosen only on pre-holdout archived prices must remain profitable on holdout prices with adequate sample.",
    }

    # Keep live state bounded; old inactive entities are unnecessary for request-time scoring.
    prune_before = (end - timedelta(days=450)).isoformat()
    for entity_type in ("batters", "pitchers"):
        state[entity_type] = {
            key: value for key, value in state[entity_type].items()
            if str(value.get("last_date") or "") >= prune_before
        }
    state["as_of"] = end.isoformat()

    (args.output_dir / "model.json").write_text(json.dumps(artifact, separators=(",", ":")) + "\n", encoding="utf-8")
    (args.output_dir / "performance.json").write_text(json.dumps(performance, indent=2) + "\n", encoding="utf-8")
    (args.output_dir / "august-predictions.json").write_text(json.dumps(prediction_rows, separators=(",", ":")) + "\n", encoding="utf-8")
    write_state_parts(args.output_dir / "state-parts", state)
    print(json.dumps({"selected": selected, "holdout": performance["holdout"], "rows": len(y)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
