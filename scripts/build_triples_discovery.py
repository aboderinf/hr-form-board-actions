#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.discovery import profit_units
from src.model import ET
from src.sources import HttpClient, MLB, game_log, season_hitter_pool
from src.storage import write_json
from src.triples import calculate_triples_form_open_pool, rank_triples_scores
from src.triples_discovery import build_reports, collapse_best, complete_slate_partition
from src.triples_model_discovery import (
    build_daily_archive as build_model_daily_archive,
    build_output as build_model_discovery_output,
    parse_timestamp,
    usable_model_board,
)
from src.triples_settlement import (
    best_archived_quote,
    map_event_game,
    player_indexes,
    resolve_player_id,
    settle_player_game,
    team_code_index,
)


ARCHIVE_START = date(2026, 8, 7)
MODEL_ARCHIVE_START = date(2026, 8, 16)
CHECKPOINTS = ("0817", "1117", "1717")
FORM_BOARD = "https://hr-form-board-actions.vercel.app"


def get_json(url: str, allow_missing: bool = False) -> dict[str, Any] | None:
    error: Exception | None = None
    for attempt in range(3):
        try:
            response = requests.get(
                url,
                timeout=45,
                headers={"User-Agent": "MLBTriplesDiscovery/1.0"},
            )
            if allow_missing and response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()
        except Exception as exc:
            error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed {url}: {error}")


def capture_path(archive_dir: Path, slate: date, checkpoint: str) -> Path:
    return archive_dir / f"{slate.isoformat()}_{checkpoint}.json"


def load_or_fetch_capture(
    archive_dir: Path, slate: date, checkpoint: str
) -> dict[str, Any] | None:
    path = capture_path(archive_dir, slate, checkpoint)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    payload = get_json(
        f"{FORM_BOARD}/api/triples-odds?date={slate.isoformat()}&checkpoint={checkpoint}",
        allow_missing=True,
    )
    if payload is None or payload.get("status") != "ready":
        return None
    write_json(path, payload)
    return payload


def model_archive_path(archive_dir: Path, slate: date) -> Path:
    return archive_dir / f"{slate.isoformat()}.json"


def read_model_archives(archive_dir: Path, today: date) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for path in sorted(archive_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            slate = str(payload.get("slate_date") or "")
            if (
                payload.get("kind") == "triples_model_pick_slate"
                and slate
                and date.fromisoformat(slate) <= today
            ):
                output[slate] = payload
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return output


def git_model_board_candidates(
    wanted_dates: set[str], diagnostics: list[str]
) -> dict[str, list[tuple[dict[str, Any], str]]]:
    output: dict[str, list[tuple[dict[str, Any], str]]] = defaultdict(list)
    if not wanted_dates:
        return output
    try:
        history = subprocess.run(
            ["git", "log", "--format=%H", "--all", "--", "data/triples-model.json"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout.splitlines()
    except (OSError, subprocess.SubprocessError) as exc:
        diagnostics.append(f"Model board Git history unavailable: {exc}")
        return output

    for sha in history:
        try:
            raw = subprocess.run(
                ["git", "show", f"{sha}:data/triples-model.json"],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            ).stdout
            payload = json.loads(raw)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            continue
        slate = str(payload.get("slate_date") or "")
        if slate in wanted_dates and usable_model_board(payload, slate):
            output[slate].append((payload, f"git:{sha[:12]}"))
    return output


def runtime_model_boards(
    wanted_dates: set[str], diagnostics: list[str]
) -> dict[str, tuple[dict[str, Any], str]]:
    output: dict[str, tuple[dict[str, Any], str]] = {}

    def fetch(slate: str) -> tuple[str, dict[str, Any] | None, str | None]:
        try:
            payload = get_json(
                f"{FORM_BOARD}/api/triples-model-current?date={slate}",
                allow_missing=True,
            )
        except Exception as exc:
            return slate, None, str(exc)
        if payload is not None and usable_model_board(payload, slate):
            return slate, payload, None
        return slate, None, None

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(fetch, slate) for slate in sorted(wanted_dates)]
        for future in as_completed(futures):
            slate, payload, error = future.result()
            if error:
                diagnostics.append(f"Runtime model board failed for {slate}: {error}")
            elif payload is not None:
                output[slate] = (payload, "runtime-archive")
    return output


def choose_model_boards(
    wanted_dates: set[str], diagnostics: list[str]
) -> dict[str, tuple[dict[str, Any], str]]:
    candidates = git_model_board_candidates(wanted_dates, diagnostics)
    for slate, candidate in runtime_model_boards(wanted_dates, diagnostics).items():
        candidates[slate].append(candidate)
    selected: dict[str, tuple[dict[str, Any], str]] = {}
    for slate, options in candidates.items():
        valid = [item for item in options if parse_timestamp(item[0].get("generated_at"))]
        if valid:
            selected[slate] = min(
                valid,
                key=lambda item: parse_timestamp(item[0].get("generated_at"))
                or datetime.max.replace(tzinfo=timezone.utc),
            )
    return selected


def build_model_pick_discovery(
    entries: list[dict[str, Any]],
    today: date,
    archive_dir: Path,
    output_path: Path,
    diagnostics: list[str],
) -> dict[str, Any]:
    complete_entries, complete_dates, incomplete_dates = complete_slate_partition(entries)
    candidate_dates = {
        slate for slate in complete_dates if date.fromisoformat(slate) >= MODEL_ARCHIVE_START
    }
    archives = read_model_archives(archive_dir, today)
    missing_archives = candidate_dates - set(archives)
    boards = choose_model_boards(missing_archives, diagnostics)
    entries_by_slate: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in complete_entries:
        entries_by_slate[str(row["slate_date"])].append(row)

    missing_model_dates: list[str] = []
    for slate in sorted(missing_archives):
        board_and_source = boards.get(slate)
        if board_and_source is None:
            missing_model_dates.append(slate)
            continue
        board, source = board_and_source
        daily = build_model_daily_archive(
            board,
            entries_by_slate.get(slate, []),
            source=source,
        )
        write_json(model_archive_path(archive_dir, date.fromisoformat(slate)), daily)
        archives[slate] = daily

    selected_archives = [archives[slate] for slate in sorted(candidate_dates & set(archives))]
    output = build_model_discovery_output(
        selected_archives,
        today,
        candidate_dates=candidate_dates,
        incomplete_dates=[
            slate for slate in incomplete_dates if date.fromisoformat(slate) >= MODEL_ARCHIVE_START
        ],
        missing_model_dates=missing_model_dates,
        diagnostics=diagnostics,
    )
    write_json(output_path, output)
    return output


def fetch_teams(client: HttpClient, season: int) -> list[dict[str, Any]]:
    payload = client.json(f"{MLB}/teams?sportId=1&season={season}")
    return list(payload.get("teams") or [])


def fetch_schedule_games(client: HttpClient, slate: date) -> list[dict[str, Any]]:
    payload = client.json(
        f"{MLB}/schedule?sportId=1&date={slate.isoformat()}&hydrate=status,teams"
    )
    output: list[dict[str, Any]] = []
    for date_row in payload.get("dates", []):
        for game in date_row.get("games", []):
            teams = game.get("teams") or {}
            away = (teams.get("away") or {}).get("team") or {}
            home = (teams.get("home") or {}).get("team") or {}
            status = game.get("status") or {}
            output.append(
                {
                    "game_pk": game.get("gamePk"),
                    "game_date": game.get("gameDate"),
                    "away_team_id": away.get("id"),
                    "away_team": away.get("name"),
                    "home_team_id": home.get("id"),
                    "home_team": home.get("name"),
                    "abstract_state": status.get("abstractGameState"),
                    "detailed_state": status.get("detailedState"),
                }
            )
    return output


def fetch_logs(
    client: HttpClient, pool: list[dict[str, Any]], season: int
) -> tuple[dict[int, list[dict[str, Any]]], list[str]]:
    logs: dict[int, list[dict[str, Any]]] = {}
    diagnostics: list[str] = []

    def fetch(player: dict[str, Any]) -> tuple[int, list[dict[str, Any]]]:
        player_id = int(player["mlbam_id"])
        return player_id, game_log(client, player_id, season)

    with ThreadPoolExecutor(max_workers=24) as executor:
        futures = {executor.submit(fetch, player): player for player in pool}
        for future in as_completed(futures):
            player = futures[future]
            try:
                player_id, games = future.result()
                logs[player_id] = games
            except Exception as exc:
                diagnostics.append(f"Game log failed for {player.get('player')}: {exc}")
    return logs, diagnostics


def form_by_slate(
    slate_dates: list[date],
    pool: list[dict[str, Any]],
    logs: dict[int, list[dict[str, Any]]],
) -> dict[str, dict[int, dict[str, Any]]]:
    output: dict[str, dict[int, dict[str, Any]]] = {}
    for slate in slate_dates:
        scored: list[dict[str, Any]] = []
        for player in pool:
            player_id = int(player["mlbam_id"])
            form = calculate_triples_form_open_pool(logs.get(player_id, []), slate)
            if form:
                scored.append(
                    {
                        "mlbam_id": player_id,
                        "player": player["player"],
                        **form,
                    }
                )
        ranked = rank_triples_scores(scored)
        output[slate.isoformat()] = {
            int(row["mlbam_id"]): {**row, "rank": rank}
            for rank, row in enumerate(ranked, 1)
        }
    return output


def annotate_entries(
    captures: list[dict[str, Any]],
    pool: list[dict[str, Any]],
    logs: dict[int, list[dict[str, Any]]],
    schedules: dict[str, list[dict[str, Any]]],
    codes: dict[str, int],
    forms: dict[str, dict[int, dict[str, Any]]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_id = {int(player["mlbam_id"]): player for player in pool}
    exact, initial_last = player_indexes(pool)
    entries: list[dict[str, Any]] = []
    raw_rows = quoted_rows = mapped_games = resolved_players = 0
    unresolved = Counter()
    unmapped = Counter()

    for capture in captures:
        slate_date = str(capture.get("date"))
        checkpoint = str(capture.get("checkpoint"))
        slate_games = schedules.get(slate_date, [])
        for provider_row in capture.get("rows") or []:
            raw_rows += 1
            quote = best_archived_quote(provider_row.get("odds"))
            if not quote:
                continue
            quoted_rows += 1
            game = map_event_game(provider_row, slate_games, codes)
            if not game:
                unmapped[str(provider_row.get("matchup") or "unknown")] += 1
                continue
            mapped_games += 1
            game_pk = int(game.get("game_pk") or 0)
            player_id = resolve_player_id(
                provider_row.get("batterName"),
                game_pk,
                exact,
                initial_last,
                logs,
            )
            if not player_id:
                unresolved[str(provider_row.get("batterName") or "unknown")] += 1
                continue
            resolved_players += 1
            player = by_id[player_id]
            form = forms.get(slate_date, {}).get(player_id) or {}
            result, triples, plate_appearances = settle_player_game(
                logs.get(player_id, []),
                game_pk,
                game.get("abstract_state"),
                game.get("detailed_state"),
            )
            odds = int(quote["odds"])
            entries.append(
                {
                    "slate_date": slate_date,
                    "checkpoint": checkpoint,
                    "captured_at": capture.get("asOf") or capture.get("generatedAt"),
                    "source_event_id": provider_row.get("sourceEventId"),
                    "game_pk": game_pk,
                    "game_start_at": game.get("game_date"),
                    "matchup": provider_row.get("matchup"),
                    "game_status": game.get("detailed_state"),
                    "player": player.get("player"),
                    "mlbam_id": player_id,
                    "team": player.get("team"),
                    "rank": form.get("rank"),
                    "score": form.get("score"),
                    "triple_games_l5": form.get("triple_games_l5"),
                    "triple_games_l7": form.get("triple_games_l7"),
                    "triple_games_l15": form.get("triple_games_l15"),
                    "best_book": quote["book"],
                    "best_odds": odds,
                    "available_books": sorted((provider_row.get("odds") or {}).keys()),
                    "result": result,
                    "triples": triples,
                    "plate_appearances": plate_appearances,
                    "profit_units": profit_units(odds, result),
                }
            )

    quality = {
        "raw_archive_rows": raw_rows,
        "rows_with_a_price": quoted_rows,
        "rows_mapped_to_official_game": mapped_games,
        "rows_resolved_to_mlb_player": resolved_players,
        "rows_in_analysis": len(entries),
        "unresolved_identity_rows": sum(unresolved.values()),
        "unmapped_game_rows": sum(unmapped.values()),
        "most_common_unresolved_names": [
            {"name": name, "rows": count} for name, count in unresolved.most_common(20)
        ],
        "most_common_unmapped_matchups": [
            {"matchup": matchup, "rows": count} for matchup, count in unmapped.most_common(20)
        ],
    }
    return entries, quality


def public_result(row: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "slate_date",
        "checkpoint",
        "game_pk",
        "matchup",
        "player",
        "mlbam_id",
        "rank",
        "score",
        "best_book",
        "best_odds",
        "result",
        "triples",
        "plate_appearances",
        "profit_units",
    )
    return {key: row.get(key) for key in keys}


def build_output(
    captures: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    quality: dict[str, Any],
    today: date,
    diagnostics: list[str],
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    archive_dates = sorted({str(capture.get("date")) for capture in captures})
    complete_entries, fully_settled_dates, incomplete_dates = complete_slate_partition(entries)
    best_rows = collapse_best(complete_entries)
    settled_hit_points = sorted(
        (row for row in best_rows if row.get("result") == "WIN"),
        key=lambda row: (
            row["slate_date"],
            float(row.get("score") or -1.0),
            int(row.get("best_odds") or 0),
            row.get("player") or "",
        ),
    )
    recent_settled = sorted(
        (row for row in best_rows if row.get("result") in {"WIN", "LOSS"}),
        key=lambda row: (row["slate_date"], row.get("player") or ""),
        reverse=True,
    )[:50]
    return {
        "schema_version": 1,
        "kind": "triples_historical_profit_discovery",
        "status": "ready" if entries else "no_resolved_rows",
        "generated_at": now.isoformat(),
        "generated_at_et": now.astimezone(ET).isoformat(),
        "as_of_slate": today.isoformat(),
        "settled_through": fully_settled_dates[-1] if fully_settled_dates else None,
        "archive": {
            "start": archive_dates[0] if archive_dates else None,
            "end": archive_dates[-1] if archive_dates else None,
            "checkpoint_files": len(captures),
            "checkpoints_et": ["08:17", "11:17", "17:17"],
            "source": "Existing archived SportsGameOdds /events responses",
            "provider_requests_added": 0,
            "provider_objects_added": 0,
        },
        "methodology": {
            "market": "Player to hit a triple — Yes",
            "stake": "1 unit per bet; American-odds profit on wins and -1 unit on losses",
            "outcomes": "Official MLB game logs matched to the exact gamePk; no plate appearance is void",
            "archive_best_benchmark": "Best archived price across 08:17, 11:17, and 17:17, once per player/slate. This is a hindsight price benchmark, not a fixed-time strategy.",
            "checkpoint_strategy": "Each fixed checkpoint is reported separately so 08:17, 11:17, and 17:17 can be judged as executable timing rules.",
            "completed_slate_policy": "Profit reports include a slate only after every resolved priced row on that date has a final result; partial slates are excluded wholesale.",
            "form_score": "0.50*(triple games L5/5) + 0.30*(triple games L7/7) + 0.20*(triple games L15/15), using only games before the slate",
            "edge_gate": "At least 40 settled bets, 3 wins, 5 slates, and positive net units",
            "warning": "Observed historical segments are provisional and multiple comparisons can produce false positives. They are not guarantees or fair-value estimates.",
        },
        "data_quality": {
            **quality,
            "settled_rows": sum(row.get("result") in {"WIN", "LOSS"} for row in entries),
            "void_rows": sum(row.get("result") == "VOID" for row in entries),
            "pending_rows": sum(row.get("result") == "PENDING" for row in entries),
            "rows_in_completed_slates": len(complete_entries),
            "completed_slates": len(fully_settled_dates),
            "excluded_incomplete_slates": incomplete_dates,
            "game_log_failures": sum(item.startswith("Game log failed") for item in diagnostics),
        },
        "reports": build_reports(entries, today),
        "settled_hit_points": [public_result(row) for row in settled_hit_points],
        "recent_settled_bets": [public_result(row) for row in recent_settled],
        "diagnostics": diagnostics[:100],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--today", help="As-of ET date YYYY-MM-DD")
    parser.add_argument(
        "--archive-dir",
        type=Path,
        default=ROOT / "data" / "triples-discovery" / "archive",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "triples-discovery.json",
    )
    parser.add_argument(
        "--model-archive-dir",
        type=Path,
        default=ROOT / "data" / "triples-model-discovery" / "archive",
    )
    parser.add_argument(
        "--model-output",
        type=Path,
        default=ROOT / "data" / "triples-model-discovery.json",
    )
    args = parser.parse_args()

    today = date.fromisoformat(args.today) if args.today else datetime.now(ET).date()
    captures: list[dict[str, Any]] = []
    cursor = ARCHIVE_START
    while cursor <= today:
        for checkpoint in CHECKPOINTS:
            payload = load_or_fetch_capture(args.archive_dir, cursor, checkpoint)
            if payload:
                captures.append(payload)
        cursor += timedelta(days=1)

    if not captures:
        output = build_output([], [], {}, today, ["No archived checkpoints were available."])
        write_json(args.output, output)
        return 0

    client = HttpClient()
    pool = season_hitter_pool(client, today.year)
    logs, diagnostics = fetch_logs(client, pool, today.year)
    slate_dates = sorted({date.fromisoformat(str(capture["date"])) for capture in captures})
    teams = fetch_teams(client, today.year)
    codes = team_code_index(teams)
    schedules = {
        slate.isoformat(): fetch_schedule_games(client, slate) for slate in slate_dates
    }
    forms = form_by_slate(slate_dates, pool, logs)
    entries, quality = annotate_entries(captures, pool, logs, schedules, codes, forms)
    output = build_output(captures, entries, quality, today, diagnostics)
    write_json(args.output, output)
    model_output = build_model_pick_discovery(
        entries,
        today,
        args.model_archive_dir,
        args.model_output,
        diagnostics,
    )
    print(
        f"Triples discovery built: captures={len(captures)} rows={len(entries)} "
        f"settled={output['data_quality']['settled_rows']} "
        f"pending={output['data_quality']['pending_rows']} "
        f"model_slates={model_output['data_quality']['archived_model_slates']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
