const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeTotalBasesProviderPayload } = require('../lib/total-bases-runtime');

test('projects only pregame 2+ total-bases prices from existing events payload', () => {
  const raw = {
    data: [
      {
        eventID: 'evt-1',
        status: { startsAt: '2026-08-24T23:10:00.000Z' },
        teams: {
          away: { names: { short: 'Away' } },
          home: { names: { short: 'Home' } },
        },
        odds: {
          tbOver: {
            oddID: 'tb-over',
            statID: 'batting_totalBases',
            statEntityID: 'jose_ramirez_608070_MLB',
            periodID: 'game',
            betTypeID: 'ou',
            sideID: 'over',
            fairOverUnder: 1.5,
            byBookmaker: {
              fanduel: {
                available: true,
                odds: 115,
                bookOverUnder: 1.5,
                lastUpdatedAt: '2026-08-24T21:17:04.000Z',
              },
              draftkings: {
                available: true,
                odds: 120,
                bookOverUnder: 1.5,
                lastUpdatedAt: '2026-08-24T23:11:00.000Z',
              },
              betmgm: {
                available: true,
                odds: 160,
                bookOverUnder: 2.5,
                lastUpdatedAt: '2026-08-24T21:17:03.000Z',
              },
            },
          },
          tbUnder: {
            oddID: 'tb-under',
            statID: 'batting_totalBases',
            statEntityID: 'jose_ramirez_608070_MLB',
            periodID: 'game',
            betTypeID: 'ou',
            sideID: 'under',
            fairOverUnder: 1.5,
            byBookmaker: {
              fanduel: {
                available: true,
                odds: -140,
                bookOverUnder: 1.5,
                lastUpdatedAt: '2026-08-24T21:17:04.000Z',
              },
            },
          },
          hr: {
            oddID: 'hr',
            statID: 'batting_homeRuns',
            statEntityID: 'jose_ramirez_608070_MLB',
            periodID: 'game',
            betTypeID: 'yn',
            sideID: 'yes',
            byBookmaker: { fanduel: { available: true, odds: 400 } },
          },
        },
      },
    ],
  };

  const payload = normalizeTotalBasesProviderPayload(
    raw,
    '2026-08-24',
    '1717',
    '2026-08-24T21:17:00.000Z',
    '2026-08-24T21:17:05.000Z',
  );

  assert.equal(payload.market, 'batter-total-bases-ou-1.5');
  assert.equal(payload.targetLine, 1.5);
  assert.equal(payload.source, 'archived-sportsgameodds-events');
  assert.equal(payload.delivery, 'existing-archive-readonly');
  assert.equal(payload.providerRequests, 0);
  assert.equal(payload.quotaObjectsAdded, 0);
  assert.equal(payload.rowCount, 1);
  assert.equal(payload.quoteCount, 2);
  assert.equal(payload.allAvailableQuoteCount, 4);
  assert.equal(payload.excludedWrongLineQuoteCount, 1);
  assert.equal(payload.excludedLiveOrPostStartQuoteCount, 1);
  assert.equal(payload.rows[0].batterName, 'Jose Ramirez');
  assert.equal(payload.rows[0].batterId, 608070);
  assert.equal(payload.rows[0].odds.fanduel.over.americanOdds, 115);
  assert.equal(payload.rows[0].odds.fanduel.under.americanOdds, -140);
  assert.equal(payload.rows[0].odds.draftkings, undefined);
  assert.equal(payload.rows[0].odds.betmgm, undefined);
});

test('total bases public routes have no provider credential or direct provider request', () => {
  for (const file of ['total-bases-odds.js', 'total-bases-form.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'api', file), 'utf8');
    assert.doesNotMatch(source, /SPORTSGAMEODDS_API_KEY/);
    assert.doesNotMatch(source, /api\.sportsgameodds\.com/);
  }
  const oddsSource = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'total-bases-odds.js'),
    'utf8',
  );
  assert.match(oddsSource, /readTotalBasesCheckpoint/);
});
