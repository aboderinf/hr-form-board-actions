#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.discovery import best_price, build_reports, collapse_best_player_games, profit_units
from src.edge_source import fetch_latest_edge_odds
from src.model import ET, normalize_name
from src.sources import HttpClient, game_log
from src.storage import write_json

CHECKPOINTS = ("08:17", "11:17", "17:17", "20:17")
RULE_FORWARD_START = date(2026, 8, 31)
EARLY_GAME_CUTOFF_MINUTES = 17 * 60 + 17


def load(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def infer_checkpoint(now_et: datetime) -> str:
    candidates: list[tuple[datetime, str]] = []
    for label in CHECKPOINTS:
        hour, minute = map(int, label.split(":"))
        scheduled = datetime.combine(now_et.date(), time(hour, minute), ET)
        delta = now_et - scheduled
        if timedelta(0) <= delta <= timedelta(minutes=90):
            candidates.append((scheduled, label.replace(":", "")))
    if candidates:
        return max(candidates)[1]
    return f"manual-{now_et.strftime('%H%M')}"


def american_text(value: int | None) -> str | None:
    if value is None:
        return None
    return f"+{value}" if value > 0 else str(value)


def _game_start_et(row: dict[str, Any]) -> datetime | None:
    raw = row.get("game_start_at")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).astimezone(ET)
    except ValueError:
        return None


def _book_quote(row: dict[str, Any], book_id: str) -> dict[str, Any] | None:
    return next(
        (
            quote
            for quote in (row.get("all_prices") or [])
            if str(quote.get("book_id") or "").lower() == book_id.lower()
        ),
        None,
    )


def _is_early_rule_pick(row: dict[str, Any]) -> bool:
    if row.get("checkpoint") != "0817":
        return False
    if date.fromisoformat(row["slate_date"]) < RULE_FORWARD_START:
        return False
    if row.get("game_started_at_checkpoint") is True:
        return False
    form_score = float(row.get("score") or 0.0)
    if not (0.1 <= form_score < 0.2):
        return False
    start = _game_start_et(row)
    if start is None or start.hour * 60 + start.minute >= EARLY_GAME_CUTOFF_MINUTES:
        return False
    selected = best_price(row.get("all_prices") or [])
    draftkings = _book_quote(row, "draftkings")
    if not selected or not draftkings:
        return False
    selected_odds = int(selected.get("odds"))
    dk_odds = int(draftkings.get("odds"))
    if dk_odds != selected_odds:
        return False
    return selected_odds < 400 or 500 <= selected_odds < 600


def _is_late_rule_pick(row: dict[str, Any]) -> bool:
    if row.get("checkpoint") != "1717":
        return False
    if date.fromisoformat(row["slate_date"]) < RULE_FORWARD_START:
        return False
    if row.get("game_started_at_checkpoint") is True:
        return False
    form_score = float(row.get("score") or 0.0)
    if not (0.1 <= form_score < 0.2):
        return False
    start = _game_start_et(row)
    if start is None or start.hour * 60 + start.minute < EARLY_GAME_CUTOFF_MINUTES:
        return False
    price = row.get("best_odds")
    return price is not None and 600 <= int(price) < 800


def _rule_entry(row: dict[str, Any], rule_id: str, rule_name: str) -> dict[str, Any]:
    if rule_id == "early-hr":
        quote = _book_quote(row, "draftkings") or {}
        bet_odds = quote.get("odds")
        book = "DraftKings"
    else:
        bet_odds = row.get("best_odds")
        book = row.get("best_book")
    start = _game_start_et(row)
    result = row.get("result") or "PENDING"
    return {
        "rule_id": rule_id,
        "rule_name": rule_name,
        "slate_date": row.get("slate_date"),
        "checkpoint": row.get("checkpoint"),
        "player": row.get("player"),
        "mlbam_id": row.get("mlbam_id"),
        "team": row.get("team"),
        "matchup": row.get("matchup"),
        "rank": row.get("rank"),
        "score": row.get("score"),
        "odds": bet_odds,
        "book": book,
        "game_start_at": row.get("game_start_at"),
        "game_time_et": start.strftime("%-I:%M %p ET") if start else None,
        "result": result,
        "home_runs": row.get("home_runs"),
        "profit_units": profit_units(bet_odds, result),
        "captured_at": row.get("captured_at"),
    }


def _rule_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    settled = [row for row in entries if row.get("result") in {"WIN", "LOSS"}]
    wins = sum(row.get("result") == "WIN" for row in settled)
    losses = sum(row.get("result") == "LOSS" for row in settled)
    net_units = sum(float(row.get("profit_units") or 0.0) for row in settled)
    return {
        "selections": len(entries),
        "bets": len(settled),
        "wins": wins,
        "losses": losses,
        "voids": sum(row.get("result") == "VOID" for row in entries),
        "pending": sum(row.get("result") == "PENDING" for row in entries),
        "hit_rate": wins / len(settled) if settled else None,
        "net_units": net_units,
        "roi": net_units / len(settled) if settled else None,
        "slates": len({row.get("slate_date") for row in entries if row.get("slate_date")}),
    }


def build_rule_tracking(annotated: list[dict[str, Any]]) -> dict[str, Any]:
    early = [_rule_entry(row, "early-hr", "Early HR") for row in annotated if _is_early_rule_pick(row)]
    late = [_rule_entry(row, "late-hr", "Late HR") for row in annotated if _is_late_rule_pick(row)]
    for rows in (early, late):
        rows.sort(key=lambda row: (str(row.get("slate_date") or ""), str(row.get("player") or "")), reverse=True)
    return {
        "started_forward_tracking": RULE_FORWARD_START.isoformat(),
        "rules": {
            "early-hr": {
                "rule_id": "early-hr",
                "name": "Early HR",
                "checkpoint": "08:17",
                "definition": "Score 0.1000–0.1999; early game before 5:17 PM ET; DraftKings tied for best price; best odds <+400 or +500–+599; 1u flat.",
                "summary": _rule_summary(early),
                "entries": early,
            },
            "late-hr": {
                "rule_id": "late-hr",
                "name": "Late HR",
                "checkpoint": "17:17",
                "definition": "Score 0.1000–0.1999; game at/after 5:17 PM ET; best available price +600–+799; 1u flat.",
                "summary": _rule_summary(late),
                "entries": late,
            },
        },
    }


def create_capture(top100: dict[str, Any], edge: dict[str, Any] | None, now: datetime, checkpoint: str) -> dict[str, Any]:
    slate_date = str(top100.get("slate_date") or now.astimezone(ET).date().isoformat())
    edge_same_slate = bool(edge and edge.get("source_date") == slate_date)
    by_id: dict[int, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    if edge_same_slate:
        for row in edge.get("players") or []:
            if row.get("batter_id"):
                by_id[int(row["batter_id"])] = row
            by_name[normalize_name(str(row.get("name") or ""))] = row

    entries: list[dict[str, Any]] = []
    priced = 0
    for player in top100.get("players") or []:
        player_id = int(player["mlbam_id"])
        market = by_id.get(player_id) or by_name.get(normalize_name(str(player.get("player") or "")))
        prices = [dict(price) for price in (market.get("prices") if market else []) or []]
        selected = best_price(prices)
        if selected:
            priced += 1
        entries.append({
            "slate_date": slate_date,
            "checkpoint": checkpoint,
            "captured_at": now.isoformat(),
            "captured_at_et": now.astimezone(ET).isoformat(),
            "rank": int(player.get("rank") or 999),
            "player": player.get("player"),
            "mlbam_id": player_id,
            "team": player.get("team"),
            "team_id": player.get("team_id"),
            "score": float(player.get("score") or 0.0),
            "hr_games_l5": int(player.get("hr_games_l5") or 0),
            "hr_games_l7": int(player.get("hr_games_l7") or 0),
            "hr_games_l15": int(player.get("hr_games_l15") or 0),
            "home_runs_l15": int(player.get("home_runs_l15") or 0),
            "games_available": int(player.get("games_available") or 0),
            "sample_status": player.get("sample_status"),
            "game_pk": market.get("game_pk") if market else None,
            "game_start_at": market.get("game_start_at") if market else None,
            "matchup": market.get("matchup") if market else None,
            "all_prices": prices,
            "best_book": selected.get("book") if selected else None,
            "best_odds": selected.get("odds") if selected else None,
            "best_odds_text": american_text(selected.get("odds") if selected else None),
            "best_price_captured_at": selected.get("captured_at") if selected else None,
            "source_event_id": selected.get("source_event_id") if selected else None,
            "source_odd_id": selected.get("source_odd_id") if selected else None,
        })

    return {
        "schema_version": 1,
        "kind": "top_100_odds_capture",
        "slate_date": slate_date,
        "checkpoint": checkpoint,
        "captured_at": now.isoformat(),
        "captured_at_et": now.astimezone(ET).isoformat(),
        "top100_generated_at": top100.get("generated_at"),
        "top100_rows": len(entries),
        "priced_rows": priced,
        "odds_coverage": priced / len(entries) if entries else None,
        "source": {
            "name": "MLB HR Edge",
            "status": edge.get("status") if edge else "unavailable",
            "slate_date": edge.get("source_date") if edge else None,
            "same_slate": edge_same_slate,
            "generated_at": edge.get("generated_at") if edge else None,
            "row_count": edge.get("row_count") if edge else 0,
            "books": edge.get("books") if edge else [],
        },
        "entries": entries,
    }


def annotate_results(entries: list[dict[str, Any]], client: HttpClient, today: date) -> list[dict[str, Any]]:
    player_ids = sorted({int(row["mlbam_id"]) for row in entries if date.fromisoformat(row["slate_date"]) <= today})
    logs: dict[int, list[dict]] = {}

    def fetch(player_id: int) -> tuple[int, list[dict]]:
        return player_id, game_log(client, player_id, today.year)

    with ThreadPoolExecutor(max_workers=24) as executor:
        futures = {executor.submit(fetch, player_id): player_id for player_id in player_ids}
        for future in as_completed(futures):
            player_id = futures[future]
            try:
                _, rows = future.result()
                logs[player_id] = rows
            except Exception:
                logs[player_id] = []

    annotated = []
    for source in entries:
        row = dict(source)
        slate = date.fromisoformat(row["slate_date"])
        result = "PENDING"
        home_runs = None
        if slate <= today:
            candidates = [game for game in logs.get(int(row["mlbam_id"]), []) if game.get("date") == row["slate_date"] and int(game.get("plateAppearances") or 0) > 0]
            if row.get("game_pk"):
                exact = [game for game in candidates if int(game.get("gamePk") or 0) == int(row["game_pk"])]
                if exact:
                    candidates = exact
            if candidates:
                home_runs = sum(int(game.get("homeRuns") or 0) for game in candidates)
                result = "WIN" if home_runs > 0 else "LOSS"
            elif slate < today:
                result = "VOID"
                home_runs = 0
        row["result"] = result
        row["home_runs"] = home_runs
        row["profit_units"] = profit_units(row.get("best_odds"), result)
        annotated.append(row)
    return annotated


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive Top 100 odds and build discovery reports")
    parser.add_argument("--checkpoint", help="Checkpoint label such as 0817 or 1717")
    parser.add_argument("--no-capture", action="store_true", help="Rebuild reports without creating a new capture")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    now_et = now.astimezone(ET)
    today = now_et.date()
    checkpoint = args.checkpoint or infer_checkpoint(now_et)
    archive_dir = ROOT / "data" / "discovery" / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    diagnostics: list[str] = []

    top100 = load(ROOT / "data" / "top100.json", {})
    if not top100.get("players"):
        diagnostics.append("Top 100 leaderboard is unavailable; no new capture created")
    elif not args.no_capture:
        edge = None
        try:
            edge = fetch_latest_edge_odds(HttpClient())
        except Exception as exc:
            diagnostics.append(f"MLB HR Edge odds unavailable: {exc}")
        capture = create_capture(top100, edge, now, checkpoint)
        capture_path = archive_dir / f"{capture['slate_date']}_{checkpoint}.json"
        if not capture_path.exists():
            write_json(capture_path, capture)
        else:
            diagnostics.append(f"Capture already exists: {capture_path.name}")

    captures = [load(path, {}) for path in sorted(archive_dir.glob("*.json"))]
    raw_entries = [entry for capture in captures for entry in (capture.get("entries") or [])]
    annotated = annotate_results(raw_entries, HttpClient(), today) if raw_entries else []
    reports = build_reports(annotated, today)
    unique = collapse_best_player_games(annotated)
    rule_tracking = build_rule_tracking(annotated)

    recent_captures = []
    for capture in reversed(captures[-20:]):
        recent_captures.append({
            "slate_date": capture.get("slate_date"),
            "checkpoint": capture.get("checkpoint"),
            "captured_at_et": capture.get("captured_at_et"),
            "top100_rows": capture.get("top100_rows"),
            "priced_rows": capture.get("priced_rows"),
            "odds_coverage": capture.get("odds_coverage"),
            "source_status": (capture.get("source") or {}).get("status"),
            "source_generated_at": (capture.get("source") or {}).get("generated_at"),
        })

    recent_results = sorted(unique, key=lambda row: (row.get("slate_date", ""), row.get("rank", 999)), reverse=True)[:100]
    output = {
        "schema_version": 2,
        "kind": "top_100_profit_discovery",
        "generated_at": now.isoformat(),
        "generated_at_et": now_et.isoformat(),
        "status": "ready" if captures else "collecting",
        "methodology": {
            "capture": "All Top 100 form-score rows are archived at each discovery checkpoint, including rows without an available price.",
            "odds_source": "Persisted FanDuel, DraftKings, and BetMGM prices from MLB HR Edge only; this workflow never calls SportsGameOdds directly.",
            "analysis_unit": "Best archived price per player per slate. Multiple intraday captures remain in the raw archive but count once in ROI reports.",
            "staking": "One flat unit per priced player-game. Wins earn the archived American-odds profit; losses lose one unit; no appearances are void.",
            "warning": "Results are exploratory and sample sizes must be considered before treating any segment as a repeatable edge.",
        },
        "archive_started": captures[0].get("captured_at_et") if captures else None,
        "capture_count": len(captures),
        "raw_top100_rows": len(raw_entries),
        "raw_priced_rows": sum(row.get("best_odds") is not None for row in raw_entries),
        "unique_priced_player_games": len(unique),
        "reports": reports,
        "rule_tracking": rule_tracking,
        "recent_captures": recent_captures,
        "recent_results": recent_results,
        "diagnostics": diagnostics,
    }
    write_json(ROOT / "data" / "discovery.json", output)
    print(
        "Discovery built: "
        f"captures={len(captures)} raw={len(raw_entries)} unique_priced={len(unique)} "
        f"early={len(rule_tracking['rules']['early-hr']['entries'])} "
        f"late={len(rule_tracking['rules']['late-hr']['entries'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
