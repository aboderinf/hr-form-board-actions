#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.discovery import odds_band, profit_units
from src.sources import HttpClient, game_log
from src.storage import write_json

ET = ZoneInfo("America/New_York")
CHECKPOINTS = ("0817", "1117", "1717", "2017")
BOOKS = ("FanDuel", "DraftKings", "BetMGM")
RANK_CAPS = (3, 5, 10, 15, 20, 25)
LAGS = (1, 2, 3, 4, 5)
MODES = ("hr_at_lag", "most_recent_hr_exactly_lag")


def load(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def normalized_checkpoint(value: Any) -> str | None:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit()).zfill(4)
    return digits if digits in CHECKPOINTS else None


def checkpoint_dt(slate: date, checkpoint: str) -> datetime:
    hour, minute = int(checkpoint[:2]), int(checkpoint[2:])
    return datetime.combine(slate, time(hour, minute), ET)


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def game_started(row: dict[str, Any]) -> bool:
    if row.get("game_started_at_checkpoint") is True:
        return True
    cp = normalized_checkpoint(row.get("checkpoint"))
    if not cp or not row.get("slate_date"):
        return False
    start = parse_dt(row.get("game_start_at"))
    if not start:
        return False
    slate = date.fromisoformat(str(row["slate_date"]))
    return start.astimezone(timezone.utc) <= checkpoint_dt(slate, cp).astimezone(timezone.utc)


def fetch_logs(player_ids: list[int], season: int) -> dict[int, list[dict[str, Any]]]:
    client = HttpClient()
    logs: dict[int, list[dict[str, Any]]] = {}

    def fetch(player_id: int) -> tuple[int, list[dict[str, Any]]]:
        return player_id, game_log(client, player_id, season)

    with ThreadPoolExecutor(max_workers=24) as pool:
        futures = {pool.submit(fetch, player_id): player_id for player_id in player_ids}
        for future in as_completed(futures):
            player_id = futures[future]
            try:
                _, rows = future.result()
                logs[player_id] = rows
            except Exception as exc:
                print(f"game log failed for {player_id}: {exc}", file=sys.stderr)
                logs[player_id] = []
    return logs


def prior_pa_games(games: Iterable[dict[str, Any]], slate: date) -> list[dict[str, Any]]:
    prior = [
        game for game in games
        if game.get("date")
        and date.fromisoformat(str(game["date"])) < slate
        and int(game.get("plateAppearances") or 0) > 0
    ]
    prior.sort(key=lambda game: (str(game.get("date") or ""), int(game.get("gamePk") or 0)))
    return prior


def prior_five(games: Iterable[dict[str, Any]], slate: date) -> list[dict[str, Any]]:
    prior = prior_pa_games(games, slate)
    recent = list(reversed(prior[-5:]))
    output = []
    for lag in LAGS:
        game = recent[lag - 1] if lag <= len(recent) else None
        output.append({
            "lag": lag,
            "date": game.get("date") if game else None,
            "game_pk": game.get("gamePk") if game else None,
            "home_runs": int(game.get("homeRuns") or 0) if game else 0,
            "hr_game": bool(game and int(game.get("homeRuns") or 0) > 0),
            "plate_appearances": int(game.get("plateAppearances") or 0) if game else 0,
        })
    return output


def settle(
    games: Iterable[dict[str, Any]],
    slate: date,
    today: date,
    game_pk: int | str | None = None,
) -> tuple[str, int | None]:
    rows = [
        game for game in games
        if str(game.get("date") or "") == slate.isoformat()
        and int(game.get("plateAppearances") or 0) > 0
    ]
    if game_pk is not None:
        exact = [
            game for game in rows
            if int(game.get("gamePk") or 0) == int(game_pk)
        ]
        if exact:
            rows = exact
    if rows:
        home_runs = sum(int(game.get("homeRuns") or 0) for game in rows)
        return ("WIN" if home_runs > 0 else "LOSS", home_runs)
    if slate < today:
        return ("VOID", 0)
    return ("PENDING", None)


def unique_checkpoint_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[tuple[str, str, int], dict[str, Any]] = {}
    for source in rows:
        if source.get("best_odds") is None:
            continue
        cp = normalized_checkpoint(source.get("checkpoint"))
        if not cp:
            continue
        row = dict(source)
        row["checkpoint"] = cp
        if game_started(row):
            continue
        key = (str(row.get("slate_date") or ""), cp, int(row.get("mlbam_id") or 0))
        current = selected.get(key)
        if current is None or str(row.get("captured_at") or "") > str(current.get("captured_at") or ""):
            selected[key] = row
    return sorted(selected.values(), key=lambda row: (row["slate_date"], row["checkpoint"], int(row.get("rank") or 999), str(row.get("player") or "")))


def price_for_book(row: dict[str, Any], book: str) -> int | None:
    quotes = [
        int(item["odds"]) for item in (row.get("all_prices") or [])
        if item.get("book") == book and isinstance(item.get("odds"), int) and int(item["odds"]) != 0
    ]
    return max(quotes) if quotes else None


def american_implied(odds: int) -> float:
    return 100.0 / (odds + 100.0) if odds > 0 else abs(odds) / (abs(odds) + 100.0)


def stats(rows: Iterable[dict[str, Any]], odds_key: str = "odds") -> dict[str, Any]:
    rows = list(rows)
    settled = [row for row in rows if row.get("result") in {"WIN", "LOSS"} and isinstance(row.get(odds_key), int)]
    wins = sum(row["result"] == "WIN" for row in settled)
    losses = sum(row["result"] == "LOSS" for row in settled)
    net = sum(float(profit_units(int(row[odds_key]), str(row["result"])) or 0.0) for row in settled)
    slates = len({str(row.get("slate_date")) for row in settled})
    hit_rate = wins / len(settled) if settled else None
    break_even = mean(american_implied(int(row[odds_key])) for row in settled) if settled else None
    return {
        "bets": len(settled),
        "slates": slates,
        "wins": wins,
        "losses": losses,
        "hit_rate": hit_rate,
        "market_break_even_hit_rate": break_even,
        "hit_rate_edge": (hit_rate - break_even) if hit_rate is not None and break_even is not None else None,
        "net_units": net,
        "roi": net / len(settled) if settled else None,
        "average_odds": mean(int(row[odds_key]) for row in settled) if settled else None,
    }


def group_stats(rows: Iterable[dict[str, Any]], key_fn, order: Iterable[str] | None = None, odds_key: str = "odds") -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[str(key_fn(row))].append(row)
    labels = list(order) if order else sorted(buckets)
    return [{"label": label, **stats(buckets[label], odds_key=odds_key)} for label in labels if label in buckets]


def qualifies(row: dict[str, Any], mode: str, lag: int, rank_cap: int) -> bool:
    if int(row.get("rank") or 999) > rank_cap:
        return False
    recent = row.get("prior_five") or []
    if len(recent) < lag:
        return False
    if mode == "hr_at_lag":
        return bool(recent[lag - 1].get("hr_game"))
    if mode == "most_recent_hr_exactly_lag":
        return bool(recent[lag - 1].get("hr_game")) and not any(bool(item.get("hr_game")) for item in recent[: lag - 1])
    return False


def rule_report(rows: list[dict[str, Any]], mode: str, rank_cap: int, lag: int) -> dict[str, Any]:
    qualified = [row for row in rows if qualifies(row, mode, lag, rank_cap)]
    best_price = [dict(row, odds=int(row["best_odds"]), book=str(row.get("best_book") or "unknown")) for row in qualified if isinstance(row.get("best_odds"), int)]

    book_specific: dict[str, Any] = {}
    for book in BOOKS:
        book_rows = []
        for row in qualified:
            quote = price_for_book(row, book)
            if quote is not None:
                book_rows.append(dict(row, book_odds=quote))
        book_specific[book] = {
            "overall": stats(book_rows, odds_key="book_odds"),
            "by_checkpoint": group_stats(book_rows, lambda row: row["checkpoint"], CHECKPOINTS, odds_key="book_odds"),
            "by_odds": group_stats(book_rows, lambda row: odds_band(int(row["book_odds"])), odds_key="book_odds"),
        }

    intersections = group_stats(
        best_price,
        lambda row: f"{row['checkpoint']} · {odds_band(int(row['odds']))} · {row['book']}",
    )

    return {
        "mode": mode,
        "rank_cap": rank_cap,
        "hr_lag": lag,
        "rule": f"rank <= {rank_cap}; {mode}; lag={lag}",
        "overall": stats(best_price),
        "by_checkpoint": group_stats(best_price, lambda row: row["checkpoint"], CHECKPOINTS),
        "by_odds": group_stats(best_price, lambda row: odds_band(int(row["odds"]))),
        "by_best_book": group_stats(best_price, lambda row: row["book"], BOOKS),
        "checkpoint_x_odds_x_best_book": intersections,
        "book_specific_quotes": book_specific,
    }


def candidate_rows(reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates = []
    for report in reports:
        base = {"mode": report["mode"], "rank_cap": report["rank_cap"], "hr_lag": report["hr_lag"]}
        for row in report["by_checkpoint"]:
            candidates.append({**base, "dimension": "checkpoint", "segment": row["label"], **{k: v for k, v in row.items() if k != "label"}})
        for row in report["by_odds"]:
            candidates.append({**base, "dimension": "odds", "segment": row["label"], **{k: v for k, v in row.items() if k != "label"}})
        for row in report["by_best_book"]:
            candidates.append({**base, "dimension": "best_book", "segment": row["label"], **{k: v for k, v in row.items() if k != "label"}})
        for row in report["checkpoint_x_odds_x_best_book"]:
            candidates.append({**base, "dimension": "checkpoint_x_odds_x_best_book", "segment": row["label"], **{k: v for k, v in row.items() if k != "label"}})
    candidates = [row for row in candidates if int(row.get("bets") or 0) >= 8 and int(row.get("slates") or 0) >= 5]
    candidates.sort(key=lambda row: (-float(row.get("net_units") or -9999), -float(row.get("roi") or -9999), -int(row.get("bets") or 0)))
    return candidates


def render_html(summary: dict[str, Any]) -> str:
    payload = json.dumps(summary, separators=(",", ":"))
    return f'''<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recent HR Rank Discovery</title>
<style>body{{font-family:system-ui,sans-serif;max-width:1400px;margin:0 auto;padding:24px;background:#0b0d10;color:#eef1f4}}.card{{background:#151922;border:1px solid #2a3240;border-radius:14px;padding:18px;margin:14px 0}}table{{width:100%;border-collapse:collapse;font-size:13px}}th,td{{padding:8px;border-bottom:1px solid #2a3240;text-align:left}}select{{padding:8px;margin-right:8px}}.pos{{color:#61d095}}.neg{{color:#ff7a7a}}.muted{{color:#9aa6b2}}h1,h2{{margin:.2em 0}}@media(max-width:700px){{body{{padding:12px}}table{{font-size:11px}}}}</style></head>
<body><h1>Recent HR × High Form Rank Discovery</h1><p class="muted">Standalone research view. Reads the HR Form archive; does not modify or deploy the HR Form site.</p>
<div class="card"><b>Definition A:</b> HR at lag N means game N back contained a HR; buckets may overlap. <b>Definition B:</b> most recent HR exactly lag N means no HR in more recent games.</div>
<div class="card"><label>Mode <select id="mode"></select></label><label>Rank cap <select id="rank"></select></label><label>Lag <select id="lag"></select></label></div>
<div id="out"></div>
<script>const D={payload};const fmt=x=>x==null?'—':(100*x).toFixed(1)+'%';const odds=x=>x==null?'—':(x>0?'+':'')+Math.round(x);const u=x=>x==null?'—':(x>=0?'+':'')+x.toFixed(2)+'u';const mode=document.querySelector('#mode'),rank=document.querySelector('#rank'),lag=document.querySelector('#lag');for(const v of [...new Set(D.reports.map(r=>r.mode))])mode.add(new Option(v,v));for(const v of [...new Set(D.reports.map(r=>r.rank_cap))])rank.add(new Option(v,v));for(const v of [...new Set(D.reports.map(r=>r.hr_lag))])lag.add(new Option(v,v));function table(title,rows){{return `<div class=card><h2>${{title}}</h2><table><thead><tr><th>Segment</th><th>Bets</th><th>W-L</th><th>Hit</th><th>Avg odds</th><th>Net</th><th>ROI</th><th>Slates</th></tr></thead><tbody>${{rows.map(r=>`<tr><td>${{r.label}}</td><td>${{r.bets}}</td><td>${{r.wins}}-${{r.losses}}</td><td>${{fmt(r.hit_rate)}}</td><td>${{odds(r.average_odds)}}</td><td class=${{r.net_units>=0?'pos':'neg'}}>${{u(r.net_units)}}</td><td class=${{r.roi>=0?'pos':'neg'}}>${{fmt(r.roi)}}</td><td>${{r.slates}}</td></tr>`).join('')}}</tbody></table></div>`}}function render(){{const r=D.reports.find(x=>x.mode===mode.value&&String(x.rank_cap)===rank.value&&String(x.hr_lag)===lag.value);if(!r)return;document.querySelector('#out').innerHTML=`<div class=card><h2>${{r.rule}}</h2><p>Bets ${{r.overall.bets}} · ${{r.overall.wins}}-${{r.overall.losses}} · Net <span class=${{r.overall.net_units>=0?'pos':'neg'}}>${{u(r.overall.net_units)}}</span> · ROI <span class=${{r.overall.roi>=0?'pos':'neg'}}>${{fmt(r.overall.roi)}}</span></p></div>`+table('By checkpoint',r.by_checkpoint)+table('By odds band',r.by_odds)+table('By best-price bookmaker',r.by_best_book)+table('Checkpoint × odds × best-price bookmaker',r.checkpoint_x_odds_x_best_book);}}[mode,rank,lag].forEach(x=>x.onchange=render);mode.value='most_recent_hr_exactly_lag';rank.value='10';lag.value='1';render();</script></body></html>'''


def main() -> int:
    archive_dir = ROOT / "data" / "discovery" / "archive"
    captures = [load(path, {}) for path in sorted(archive_dir.glob("*.json"))]
    raw_rows = [entry for capture in captures for entry in (capture.get("entries") or [])]
    rows = unique_checkpoint_rows(raw_rows)
    today = datetime.now(ET).date()
    player_ids = sorted({int(row["mlbam_id"]) for row in rows if row.get("mlbam_id")})
    logs = fetch_logs(player_ids, today.year)

    enriched = []
    for source in rows:
        row = dict(source)
        slate = date.fromisoformat(str(row["slate_date"]))
        player_games = logs.get(int(row["mlbam_id"]), [])
        row["prior_five"] = prior_five(player_games, slate)
        row["result"], row["home_runs"] = settle(
            player_games,
            slate,
            today,
            row.get("game_pk"),
        )
        row["best_price_profit_units"] = profit_units(row.get("best_odds"), row["result"])
        enriched.append(row)

    reports = [rule_report(enriched, mode, rank_cap, lag) for mode in MODES for rank_cap in RANK_CAPS for lag in LAGS]
    candidates = candidate_rows(reports)
    summary_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_repo": "aboderinf/hr-form-board-actions",
        "source_policy": "read-only historical discovery archive + official MLB game logs",
        "archive_capture_count": len(captures),
        "raw_archive_rows": len(raw_rows),
        "eligible_checkpoint_rows": len(rows),
        "settled_checkpoint_rows": sum(row.get("result") in {"WIN", "LOSS"} for row in enriched),
        "slate_start": min((row["slate_date"] for row in enriched), default=None),
        "slate_end": max((row["slate_date"] for row in enriched), default=None),
        "definitions": {
            "hr_at_lag": "The Nth prior PA-game contained >=1 HR; a player can qualify at multiple lags.",
            "most_recent_hr_exactly_lag": "The Nth prior PA-game contained >=1 HR and all more recent prior PA-games contained 0 HR.",
            "rank_caps": list(RANK_CAPS),
            "checkpoints": list(CHECKPOINTS),
            "best_price": "Highest archived available price across FanDuel, DraftKings, BetMGM at that checkpoint.",
            "book_specific": "Counterfactual ROI using that book's own archived quote for the same qualified selection.",
            "staking": "1 flat unit per bet; win profit at archived American odds; loss -1u.",
        },
        "reports": reports,
        "candidate_segments_min_8_bets_5_slates": candidates[:200],
        "warning": "Exploratory multiple-comparison search. Treat high-ROI small cells as hypotheses, not validated rules; confirm on forward/out-of-sample checkpoints before promotion.",
    }

    out_dir = ROOT / "standalone" / "recent-hr-discovery"
    write_json(out_dir / "summary.json", summary_payload)
    (out_dir / "index.html").write_text(render_html(summary_payload), encoding="utf-8")
    print(f"built recent-HR discovery: captures={len(captures)} rows={len(rows)} settled={summary_payload['settled_checkpoint_rows']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
