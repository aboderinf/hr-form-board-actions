const test = require("node:test");
const assert = require("node:assert/strict");

let ranges;
test.before(async () => {
  ranges = await import("../discovery-ranges.mjs");
});

test("today slice uses the same form, odds, book and game-time boundaries as Discovery", () => {
  const players = [
    {
      rank: 2,
      player: "Exact Match",
      score: 0.35,
      best_odds: 550,
      best_book: "draftkings",
      game_start_at: "2026-09-18T23:05:00Z",
    },
    {
      rank: 1,
      player: "Wrong Book",
      score: 0.36,
      best_odds: 550,
      best_book: "FanDuel",
      game_start_at: "2026-09-18T23:10:00Z",
    },
    {
      rank: 3,
      player: "Wrong Form",
      score: 0.25,
      best_odds: 550,
      best_book: "DraftKings",
      game_start_at: "2026-09-18T23:15:00Z",
    },
    {
      rank: 4,
      player: "Wrong Time",
      score: 0.35,
      best_odds: 550,
      best_book: "DraftKings",
      game_start_at: "2026-09-18T21:15:00Z",
    },
    {
      rank: 5,
      player: "No Price",
      score: 0.35,
      best_odds: null,
      best_book: "DraftKings",
      game_start_at: "2026-09-18T23:30:00Z",
    },
  ];

  const matches = ranges.discoveryTodayMatches(players, {
    form: "300-399",
    odds: "500-599",
    book: "DraftKings",
    gameTime: "1900-2059",
    now: "2026-09-18T14:00:00Z",
    liveOnly: true,
  });

  assert.deepEqual(matches.map((player) => player.player), ["Exact Match"]);
  assert.equal(ranges.normalizeDiscoveryBook("draftkings"), "DraftKings");
  assert.equal(ranges.normalizeDiscoveryBook("betmgm"), "BetMGM");
});

test("today slice excludes started games from live previews and started checkpoint rows", () => {
  const players = [
    {
      rank: 1,
      player: "Already Started Live",
      score: 0.45,
      best_odds: 600,
      best_book: "fanduel",
      game_start_at: "2026-09-18T16:00:00Z",
    },
    {
      rank: 2,
      player: "Started At Checkpoint",
      score: 0.45,
      best_odds: 600,
      best_book: "FanDuel",
      game_start_at: "2026-09-18T23:00:00Z",
      game_started_at_checkpoint: true,
    },
    {
      rank: 3,
      player: "Pregame",
      score: 0.45,
      best_odds: 600,
      best_book: "FanDuel",
      game_start_at: "2026-09-18T23:00:00Z",
    },
  ];

  const live = ranges.discoveryTodayMatches(players, {
    now: "2026-09-18T18:00:00Z",
    liveOnly: true,
  });
  assert.deepEqual(live.map((player) => player.player), ["Pregame"]);

  const checkpoint = ranges.discoveryTodayMatches(players, { liveOnly: false });
  assert.deepEqual(checkpoint.map((player) => player.player), ["Already Started Live", "Pregame"]);
});
