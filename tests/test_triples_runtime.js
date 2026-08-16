const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { normalizeTriplesProviderPayload } = require("../lib/checkpoint-runtime");

test("projects pregame triples prices from an existing events payload", () => {
  const raw = {
    data: [
      {
        eventID: "evt-1",
        status: { startsAt: "2026-08-15T23:10:00.000Z" },
        teams: {
          away: { names: { short: "Away" } },
          home: { names: { short: "Home" } },
        },
        odds: {
          triple: {
            oddID: "odd-triple",
            statID: "battingTriples",
            statEntityID: "eloy_de_la_cruz_1_MLB",
            periodID: "game",
            betTypeID: "yn",
            sideID: "yes",
            byBookmaker: {
              fanduel: {
                available: true,
                odds: 850,
                lastUpdatedAt: "2026-08-15T21:17:04.000Z",
              },
              draftkings: {
                available: true,
                odds: 900,
                lastUpdatedAt: "2026-08-15T23:11:00.000Z",
              },
              betmgm: { available: false, odds: 800 },
            },
          },
          homeRun: {
            oddID: "odd-hr",
            statID: "battingHomeRuns",
            statEntityID: "eloy_de_la_cruz_1_MLB",
            periodID: "game",
            betTypeID: "yn",
            sideID: "yes",
            byBookmaker: { fanduel: { available: true, odds: 400 } },
          },
        },
      },
    ],
  };

  const payload = normalizeTriplesProviderPayload(
    raw,
    "2026-08-15",
    "1717",
    "2026-08-15T21:17:00.000Z",
    "2026-08-15T21:17:05.000Z",
  );

  assert.equal(payload.market, "batter-triples-yes");
  assert.equal(payload.source, "archived-sportsgameodds-events");
  assert.equal(payload.delivery, "existing-archive-readonly");
  assert.equal(payload.providerRequests, 0);
  assert.equal(payload.quotaObjectsAdded, 0);
  assert.equal(payload.eventCount, 1);
  assert.equal(payload.rowCount, 1);
  assert.equal(payload.quoteCount, 1);
  assert.equal(payload.allAvailableQuoteCount, 2);
  assert.equal(payload.excludedLiveOrPostStartQuoteCount, 1);
  assert.equal(payload.rows[0].batterName, "Eloy De La Cruz");
  assert.equal(payload.rows[0].odds.fanduel.americanOdds, 850);
  assert.equal(payload.rows[0].odds.draftkings, undefined);
});

test("public route has no provider credential or provider request path", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "api", "triples-odds.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /SPORTSGAMEODDS_API_KEY/);
  assert.doesNotMatch(source, /api\.sportsgameodds\.com/);
  assert.match(source, /readTriplesCheckpoint/);
});
