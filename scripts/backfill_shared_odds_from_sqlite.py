#!/usr/bin/env python3
"""Reconstruct one sanitized shared-odds checkpoint from the source SQLite archive."""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3


def parse_time(value: object) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def normalize(value: object) -> str:
    text = str(value or "").lower().replace("’", "'")
    text = re.sub(r"\b(jr|sr|ii|iii|iv)\.?\b", "", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def normalize_checkpoint(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) == 3:
        digits = f"0{digits}"
    if len(digits) != 4:
        raise ValueError(f"Invalid checkpoint {value!r}")
    return digits


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--expected-hash")
    parser.add_argument("--output-dir", type=Path, default=Path("data/shared-odds"))
    args = parser.parse_args()

    checkpoint = normalize_checkpoint(args.checkpoint)
    connection = sqlite3.connect(args.database)
    connection.row_factory = sqlite3.Row
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")

        call = connection.execute(
            """
            SELECT * FROM api_calls
            WHERE game_date = ? AND checkpoint_label = ?
            ORDER BY completed_at DESC LIMIT 1
            """,
            (args.date, checkpoint),
        ).fetchone()
        if call is None:
            raise SystemExit(f"Archived {args.date} {checkpoint} call was not found")
        if args.expected_hash and call["response_sha256"] != args.expected_hash:
            raise SystemExit("Provider response hash does not match the requested call")

        full_payload = json.loads(call["full_payload_json"])
        predictions_by_name: dict[str, list[dict]] = defaultdict(list)
        for prediction in full_payload.get("predictions") or []:
            predictions_by_name[normalize(prediction.get("batterName"))].append(prediction)

        quotes = connection.execute(
            """
            SELECT player_name, player_key, bookmaker, american_odds, captured_at,
                   source_event_id, source_odd_id, game_start_at, home_team, away_team
            FROM market_quotes WHERE call_id = ? ORDER BY captured_at DESC
            """,
            (call["call_id"],),
        ).fetchall()

        latest: dict[tuple[str, str, str], sqlite3.Row] = {}
        excluded = 0
        for quote in quotes:
            captured = parse_time(quote["captured_at"])
            starts = parse_time(quote["game_start_at"])
            if not captured or not starts or captured >= starts:
                excluded += 1
                continue
            key = (quote["player_key"], quote["source_event_id"], quote["bookmaker"])
            latest.setdefault(key, quote)

        groups: dict[tuple[str, str], dict] = {}
        for (player_key, event_id, bookmaker), quote in latest.items():
            group = groups.setdefault(
                (player_key, event_id),
                {
                    "playerKey": player_key,
                    "sourceEventId": event_id,
                    "playerName": quote["player_name"],
                    "gameStartAt": quote["game_start_at"],
                    "homeTeam": quote["home_team"],
                    "awayTeam": quote["away_team"],
                    "odds": {},
                },
            )
            group["odds"][bookmaker] = {
                "americanOdds": quote["american_odds"],
                "capturedAt": quote["captured_at"],
                "source": "sportsgameodds-archive",
                "sourceEventId": event_id,
                "sourceOddId": quote["source_odd_id"],
                "callId": call["call_id"],
            }

        rows: list[dict] = []
        for group in groups.values():
            predictions = predictions_by_name.get(normalize(group["playerName"]), [])
            prediction = predictions[0] if predictions else None
            matchup = " @ ".join(
                value for value in [group["awayTeam"], group["homeTeam"]] if value
            ) or None
            rows.append(
                {
                    "predictionId": (
                        f"{call['game_date']}:{prediction.get('batterId')}"
                        if prediction and prediction.get("batterId")
                        else None
                    ),
                    "gameDate": call["game_date"],
                    "gamePk": prediction.get("gamePk") if prediction else None,
                    "gameStartAt": group["gameStartAt"]
                    or (prediction.get("gameStartAt") if prediction else None),
                    "batterId": prediction.get("batterId") if prediction else None,
                    "batterName": prediction.get("batterName")
                    if prediction
                    else group["playerName"],
                    "batterTeam": prediction.get("batterTeam") if prediction else None,
                    "matchup": prediction.get("matchup") if prediction else matchup,
                    "lineupPosition": prediction.get("lineupPosition")
                    if prediction
                    else None,
                    "lineupConfirmed": bool(
                        prediction and prediction.get("lineupConfirmed")
                    ),
                    "playerKey": group["playerKey"],
                    "sourceEventId": group["sourceEventId"],
                    "odds": group["odds"],
                }
            )
        rows.sort(key=lambda row: str(row.get("batterName") or ""))

        selected = [quote for row in rows for quote in row["odds"].values()]
        generated_at = max(
            (str(quote["capturedAt"]) for quote in selected),
            default=call["completed_at"],
        )
        feed = {
            "schemaVersion": 2,
            "date": call["game_date"],
            "checkpoint": call["checkpoint_label"],
            "asOf": call["completed_at"],
            "generatedAt": generated_at,
            "latestIngestAt": call["completed_at"],
            "status": "ready" if rows else "pending",
            "source": "mlb-hr-edge-database",
            "delivery": "source-artifact-recovery-backfill",
            "books": ["fanduel", "draftkings", "betmgm"],
            "rowCount": len(rows),
            "quoteCount": len(selected),
            "allAvailableQuoteCount": len(quotes),
            "excludedLiveOrPostStartQuoteCount": excluded,
            "archivedCallCount": 1,
            "providerCallId": call["call_id"],
            "providerResponseSha256": call["response_sha256"],
            "rows": rows,
        }

        args.output_dir.mkdir(parents=True, exist_ok=True)
        archive_dir = args.output_dir / "archive"
        archive_dir.mkdir(parents=True, exist_ok=True)
        text = json.dumps(feed, indent=2) + "\n"
        archive_path = archive_dir / f"{args.date}_{checkpoint}.json"
        archive_path.write_text(text, encoding="utf-8")
        (args.output_dir / "latest.json").write_text(text, encoding="utf-8")
        print(
            json.dumps(
                {
                    "status": "success",
                    "archive": str(archive_path),
                    "rowCount": feed["rowCount"],
                    "quoteCount": feed["quoteCount"],
                    "allAvailableQuoteCount": feed["allAvailableQuoteCount"],
                    "excludedLiveOrPostStartQuoteCount": feed[
                        "excludedLiveOrPostStartQuoteCount"
                    ],
                    "providerCallId": feed["providerCallId"],
                    "providerResponseSha256": feed["providerResponseSha256"],
                },
                indent=2,
            )
        )
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
