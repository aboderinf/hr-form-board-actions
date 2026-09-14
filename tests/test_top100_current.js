const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness() {
  let now = Date.parse("2026-09-14T13:00:00Z");
  const calls = [];
  const events = [];
  const listeners = {};
  const timers = [];
  let reply = async () => ({ status: 200, data: { slate_date: "2026-09-14", players: [] } });
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const window = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const result = await reply(String(url), init);
      return new Response(JSON.stringify(result.data), { status: result.status ?? 200 });
    },
    dispatchEvent: (event) => events.push(event),
    currentTop100Date: () => new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Clock()),
  };
  const document = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    createElement: () => ({}), head: { appendChild() {} },
    querySelector: () => null, querySelectorAll: () => [], visibilityState: "visible",
  };
  const context = vm.createContext({
    window, document, Date: Clock, Intl, URL, URLSearchParams, Response,
    location: { href: "https://hr-form-board-actions.vercel.app/#scores",
      origin: "https://hr-form-board-actions.vercel.app", hash: "#scores" },
    fetch: (...args) => window.fetch(...args),
    console: { error() {}, warn() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    setTimeout() {}, setInterval: (fn) => timers.push(fn),
    MutationObserver: class { observe() {} },
  });
  return {
    window, calls, events, listeners, timers,
    date: (value) => { now = Date.parse(value); },
    reply: (fn) => { reply = fn; },
    bridge: () => vm.runInContext(fs.readFileSync("central-data-source.js", "utf8"), context),
    scores: () => vm.runInContext(
      fs.readFileSync("scores-enhancements.js", "utf8").replace(/^import .*;\n/, "")
      + "\n;({ scoreTableState, loadScoreData, loadCheckpointData });", context),
  };
}

test("legacy static Top 100 requests read today's API and join same-date odds", async () => {
  const h = harness();
  h.reply(async (url) => url.startsWith("/api/top100-current")
    ? { data: { slate_date: "2026-09-14", players: [{ player: "Test Hitter", mlbam_id: 1 }] } }
    : { data: { date: "2026-09-14", source: "mlb-hr-edge-database", checkpoint: "0817",
      rows: [{ batterId: 1, gameStartAt: "2026-09-14T23:00:00Z",
        odds: { draftkings: { americanOdds: 600 } } }] } });
  h.bridge();
  const response = await h.window.fetch("/data/top100.json");
  const data = await response.json();
  assert.equal(h.calls[0].url, "/api/top100-current?date=2026-09-14");
  assert.equal(data.slate_date, "2026-09-14");
  assert.equal(data.players[0].best_odds, 600);
  assert.equal(data.odds.date, data.slate_date);
});

test("yesterday's form response cannot be displayed as current", async () => {
  const h = harness();
  h.reply(async () => ({ data: { slate_date: "2026-09-13", players: [{ player: "Stale" }] } }));
  h.bridge();
  const response = await h.window.fetch("/api/top100-current");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).players.length, 0);
});

test("yesterday's odds cannot attach to today's form", async () => {
  const h = harness();
  h.reply(async (url) => url.startsWith("/api/top100-current")
    ? { data: { slate_date: "2026-09-14", players: [{ player: "Test", mlbam_id: 1 }] } }
    : { data: { date: "2026-09-13", source: "mlb-hr-edge-database",
      rows: [{ batterId: 1, odds: { draftkings: { americanOdds: 600 } } }] } });
  h.bridge();
  const data = await (await h.window.fetch("/api/top100-current")).json();
  assert.equal(data.slate_date, "2026-09-14");
  assert.equal(data.players[0].best_odds, undefined);
});

test("odds failures retry and successful odds expire after one minute", async () => {
  const h = harness();
  let attempts = 0;
  h.reply(async () => ++attempts === 1 ? { status: 503, data: {} }
    : { data: { date: "2026-09-14", source: "mlb-hr-edge-database", rows: [] } });
  h.bridge();
  await assert.rejects(h.window.getCentralOddsDatabase("2026-09-14"));
  await h.window.getCentralOddsDatabase("2026-09-14");
  await h.window.getCentralOddsDatabase("2026-09-14");
  assert.equal(attempts, 2);
  h.date("2026-09-14T13:01:01Z");
  await h.window.getCentralOddsDatabase("2026-09-14");
  assert.equal(attempts, 3);
});

test("midnight ET clears yesterday even when today's feed is pending, then retries", async () => {
  const h = harness();
  h.date("2026-09-14T03:59:59Z");
  h.reply(async () => ({ data: { slate_date: "2026-09-13", players: [{ player: "Yesterday" }] } }));
  const s = h.scores();
  await s.loadScoreData();
  s.scoreTableState.checkpointData.set("2026-09-13_0817", {});
  h.date("2026-09-14T04:00:01Z");
  h.reply(async () => ({ status: 404, data: {} }));
  await s.loadScoreData();
  assert.equal(s.scoreTableState.data.slate_date, "2026-09-14");
  assert.equal(s.scoreTableState.data.players.length, 0);
  assert.equal(s.scoreTableState.checkpointData.size, 0);
  assert.equal(s.scoreTableState.loading, null);
  h.date("2026-09-14T04:01:02Z");
  h.reply(async () => ({ data: { slate_date: "2026-09-14", players: [{ player: "Today" }] } }));
  await s.loadScoreData();
  assert.equal(s.scoreTableState.data.players[0].player, "Today");
  assert.equal(typeof h.listeners.focus, "function");
  assert.equal(typeof h.listeners.visibilitychange, "function");
  assert.equal(h.timers.length, 1);
});

test("a response started yesterday cannot overwrite a newer slate", async () => {
  const h = harness();
  h.date("2026-09-14T03:59:59Z");
  let finishOld;
  h.reply(() => new Promise((resolve) => { finishOld = resolve; }));
  const s = h.scores();
  const oldRequest = s.loadScoreData();
  h.date("2026-09-14T04:00:01Z");
  h.reply(async () => ({ data: { slate_date: "2026-09-14", players: [{ player: "Today" }] } }));
  await s.loadScoreData();
  finishOld({ data: { slate_date: "2026-09-13", players: [{ player: "Yesterday" }] } });
  await oldRequest;
  assert.equal(s.scoreTableState.currentData.slate_date, "2026-09-14");
  assert.equal(s.scoreTableState.currentData.players[0].player, "Today");
});

test("a pending checkpoint is retried instead of being cached for the entire tab", async () => {
  const h = harness();
  const s = h.scores();
  let ready = false;
  h.reply(async (url) => url.startsWith("/api/top100-current")
    ? { data: { slate_date: "2026-09-14", players: [] } }
    : ready ? { data: { slate_date: "2026-09-14", checkpoint: "0817", entries: [{ mlbam_id: 1 }] } }
      : { status: 404, data: {} });
  assert.equal((await s.loadCheckpointData("0817")).checkpoint_pending, true);
  ready = true;
  const checkpoint = await s.loadCheckpointData("0817");
  assert.equal(checkpoint.players.length, 1);
  assert.equal(checkpoint.slate_date, "2026-09-14");
});
