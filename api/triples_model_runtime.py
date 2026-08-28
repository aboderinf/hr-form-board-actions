from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from src.triples_model_runtime import build_and_publish, current_et_date, read_model_board


def _first(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key) or []
    return str(values[0]).strip() if values else ""


def _summary(result: dict) -> dict:
    board = result.get("board") if isinstance(result.get("board"), dict) else {}
    return {
        "status": result.get("status"),
        "slate_date": board.get("slate_date"),
        "generated_at": board.get("generated_at"),
        "state_as_of": board.get("state_as_of"),
        "player_count": board.get("player_count"),
        "delivery": board.get("delivery"),
        "state_source": result.get("state_source"),
        "sports_game_odds_objects_added": board.get("sports_game_odds_objects_added"),
    }


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict | None, *, source: str | None = None) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        if source:
            self.send_header("X-Triples-Model-Source", source)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def _refresh(self) -> None:
        query = self._query()
        slate_date = _first(query, "date") or current_et_date()
        try:
            result = build_and_publish(slate_date)
            status = 202 if result.get("status") == "build_in_progress" else 200
            self._send(status, _summary(result), source="qstash-vercel-redis")
        except ValueError as error:
            self._send(400, {"status": "error", "message": str(error)})
        except Exception as error:
            self._send(
                503,
                {"status": "infrastructure_error", "slate_date": slate_date, "message": str(error)},
            )

    def _read(self) -> None:
        query = self._query()
        slate_date = _first(query, "date") or current_et_date()
        try:
            board, source = read_model_board(slate_date)
            if board is None:
                self._send(404, {"status": "not_ready", "slate_date": slate_date})
                return
            self._send(200, board, source=source)
        except ValueError as error:
            self._send(400, {"status": "error", "message": str(error)})
        except Exception as error:
            self._send(
                503,
                {"status": "infrastructure_error", "slate_date": slate_date, "message": str(error)},
            )

    def do_GET(self) -> None:
        if _first(self._query(), "action") == "refresh":
            self._refresh()
        else:
            self._read()

    def do_POST(self) -> None:
        self._refresh()

    def do_HEAD(self) -> None:
        self._read()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.end_headers()
