#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.sources import HttpClient, game_log

ET = ZoneInfo("America/New_York")
CHECKPOINT = "1117"
RULE_ID = "rank3-most-recent-hr-lag2-1117"
DATA_DIR = ROOT / "data" / "recent-hr-rule"
LEDGER_PATH = DATA_DIR / "ledger.json"
LATEST_PATH = DATA_DIR / "latest.json"


def load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def american_profit(odds: int, result: str) -> float:
    if result == "WIN":
        return odds / 100.0 if odds > 0 else 100.0 / abs(odds)
    if result == "LOSS":
        return -1.0
    return 0.0


def prior_pa_games(games, slate: date):
    prior = [g for g in games if g.get("date") and date.fromisoformat(str(g["date"])) < slate and int(g.get("plateAppearances") or 0) > 0]
    prior.sort(key=lambda g: (str(g.get("date") or ""), int(g.get("gamePk") or 0)))
    return list(reversed(prior))


def qualifies(games, slate: date):
    prior = prior_pa_games(games, slate)
    if len(prior) < 2:
        return False, None
    last_game_hr = int(prior[0].get("homeRuns") or 0) > 0
    two_back_hr = int(prior[1].get("homeRuns") or 0) > 0
    detail = {
        "last_game": {"date": prior[0].get("date"), "game_pk": prior[0].get("gamePk"), "home_runs": int(prior[0].get("homeRuns") or 0)},
        "two_games_back": {"date": prior[1].get("date"), "game_pk": prior[1].get("gamePk"), "home_runs": int(prior[1].get("homeRuns") or 0)},
    }
    return two_back_hr and not last_game_hr, detail


def settle(games, slate: date, game_pk=None):
    rows = [g for g in games if str(g.get("date") or "") == slate.isoformat() and int(g.get("plateAppearances") or 0) > 0]
    if game_pk is not None:
        exact = [g for g in rows if int(g.get("gamePk") or 0) == int(game_pk)]
        if exact:
            rows = exact
    if not rows:
        return None
    hrs = sum(int(g.get("homeRuns") or 0) for g in rows)
    return {"result": "WIN" if hrs > 0 else "LOSS", "home_runs": hrs}


def best_price(entry):
    prices = []
    for p in entry.get("all_prices") or []:
        odds = p.get("odds")
        if isinstance(odds, int) and odds != 0:
            prices.append((odds, str(p.get("book") or "Unknown")))
    if prices:
        return max(prices, key=lambda x: x[0])
    odds = entry.get("best_odds")
    if isinstance(odds, int):
        return odds, str(entry.get("best_book") or "Unknown")
    return None, None


def main():
    now_et = datetime.now(ET)
    today = now_et.date()
    client = HttpClient()
    ledger = load(LEDGER_PATH, {"schema_version": 1, "rule_id": RULE_ID, "rule": {"checkpoint": CHECKPOINT, "rank_cap": 3, "definition": "most recent HR exactly two PA-games ago; no HR last game; best available price; flat 1u"}, "started_forward_tracking": today.isoformat(), "entries": []})

    # Grade all prior unsettled picks first.
    logs_cache = {}
    for item in ledger.get("entries", []):
        if item.get("result") in {"WIN", "LOSS", "VOID"}:
            continue
        slate = date.fromisoformat(item["slate_date"])
        pid = int(item["mlbam_id"])
        games = logs_cache.setdefault(pid, game_log(client, pid, slate.year))
        outcome = settle(games, slate, item.get("game_pk"))
        if outcome:
            item.update(outcome)
            item["profit_units"] = round(american_profit(int(item["odds"]), item["result"]), 4)
            item["graded_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    archive = ROOT / "data" / "discovery" / "archive" / f"{today.isoformat()}_{CHECKPOINT}.json"
    capture = load(archive, None)
    latest = {"schema_version": 1, "rule_id": RULE_ID, "slate_date": today.isoformat(), "checkpoint": CHECKPOINT, "status": "checkpoint_pending", "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "picks": []}

    if capture:
        latest["status"] = "ready"
        latest["captured_at"] = capture.get("captured_at")
        seen = {(e["slate_date"], int(e["mlbam_id"])) for e in ledger.get("entries", [])}
        picks = []
        for entry in sorted(capture.get("entries") or [], key=lambda e: int(e.get("rank") or 999)):
            if int(entry.get("rank") or 999) > 3:
                continue
            if entry.get("game_started_at_checkpoint") is True:
                continue
            odds, book = best_price(entry)
            if odds is None:
                continue
            pid = int(entry.get("mlbam_id") or 0)
            if not pid:
                continue
            games = logs_cache.setdefault(pid, game_log(client, pid, today.year))
            ok, recent = qualifies(games, today)
            if not ok:
                continue
            pick = {
                "slate_date": today.isoformat(), "checkpoint": CHECKPOINT, "rank": int(entry.get("rank") or 999),
                "player": entry.get("player"), "mlbam_id": pid, "team": entry.get("team"), "score": entry.get("score"),
                "game_pk": entry.get("game_pk"), "game_start_at": entry.get("game_start_at"), "odds": int(odds), "book": book,
                "all_prices": entry.get("all_prices") or [], "recent_games": recent, "result": "PENDING", "profit_units": 0.0,
                "selected_at": capture.get("captured_at") or latest["generated_at"]
            }
            picks.append(pick)
            if (today.isoformat(), pid) not in seen:
                ledger.setdefault("entries", []).append(dict(pick))
                seen.add((today.isoformat(), pid))
        latest["picks"] = picks

    settled = [e for e in ledger.get("entries", []) if e.get("result") in {"WIN", "LOSS"}]
    wins = sum(e.get("result") == "WIN" for e in settled)
    net = round(sum(float(e.get("profit_units") or 0) for e in settled), 4)
    ledger["summary"] = {
        "bets": len(settled), "wins": wins, "losses": len(settled) - wins,
        "hit_rate": (wins / len(settled)) if settled else None,
        "net_units": net, "roi": (net / len(settled)) if settled else None,
        "pending": sum(e.get("result") == "PENDING" for e in ledger.get("entries", [])),
        "slates": len({e["slate_date"] for e in settled}),
    }
    ledger["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    write(LEDGER_PATH, ledger)
    write(LATEST_PATH, latest)
    print(json.dumps({"latest_status": latest["status"], "today_picks": len(latest["picks"]), "ledger": ledger["summary"]}, indent=2))


if __name__ == "__main__":
    main()
