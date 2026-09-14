const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function runApp(hash) {
  const calls = [];
  const root = { innerHTML: "" };
  const context = {
    location: { hash },
    document: {
      querySelector: (selector) => selector === "#app" ? root : null,
      querySelectorAll: () => [],
    },
    fetch: async (url) => {
      calls.push(String(url));
      const data = String(url).includes("discovery")
        ? { status: "ready", reports: {}, recent_captures: [] }
        : { checkpoints_et: [], aggregate: { top10: {}, top20: {} }, latest: null, snapshots: [] };
      return { ok: true, status: 200, json: async () => data };
    },
    addEventListener() {},
    CustomEvent: class {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("app.js", "utf8"), context);
  return { calls, root };
}

test("Top 100 route does not download unrelated tracker or Discovery data", () => {
  const app = runApp("#scores");
  assert.deepEqual(app.calls, []);
  assert.match(app.root.innerHTML, /Top 100/);
});

test("each non-Top-100 route starts only its own data", () => {
  assert.deepEqual(runApp("#method").calls, []);
  assert.deepEqual(runApp("#today").calls, ["/data/index.json"]);
  assert.deepEqual(runApp("#discovery").calls, ["/data/discovery.json"]);
  assert.deepEqual(
    runApp("#data").calls.sort(),
    ["/data/discovery.json", "/data/index.json"],
  );
});

test("live Top 100 form returns before the odds request begins", async () => {
  const calls = [];
  let releaseOdds;
  const form = {
    slate_date: "2026-09-14",
    generated_at: "2026-09-14T08:05:01Z",
    players: [{ player: "Fast Hitter", mlbam_id: 1 }],
  };
  const odds = {
    date: "2026-09-14",
    checkpoint: "0817",
    source: "mlb-hr-edge-database",
    rows: [],
  };
  const window = {
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("/api/top100-current")) {
        return new Response(JSON.stringify(form), { status: 200 });
      }
      return new Promise((resolve) => {
        releaseOdds = () => resolve(new Response(JSON.stringify(odds), { status: 200 }));
      });
    },
  };
  const context = {
    window,
    location: {
      href: "https://hr-form-board-actions.vercel.app/#scores",
      origin: "https://hr-form-board-actions.vercel.app",
    },
    Date,
    Intl,
    URL,
    URLSearchParams,
    Response,
    console,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("central-data-source.js", "utf8"), context);

  const response = await window.fetch("/api/top100-current");
  const received = await response.json();
  assert.equal(received.players[0].player, "Fast Hitter");
  assert.deepEqual(calls, ["/api/top100-current?date=2026-09-14"]);
  assert.equal(releaseOdds, undefined);

  const hydration = window.hydrateTop100Odds(received);
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^\/api\/central-odds\?date=2026-09-14/);
  releaseOdds();
  const hydrated = await hydration;
  assert.equal(hydrated.slate_date, "2026-09-14");
  assert.equal(hydrated.odds.date, "2026-09-14");
});

test("Top 100 endpoint enables short edge caching only after data exists", () => {
  const source = fs.readFileSync("api/central-odds.js", "utf8");
  assert.match(source, /s-maxage=120, stale-while-revalidate=600/);
  const notReady = source.indexOf('status: "not_ready"');
  const noStore = source.lastIndexOf('"no-store"', notReady);
  assert.ok(noStore > -1 && noStore < notReady);
});
