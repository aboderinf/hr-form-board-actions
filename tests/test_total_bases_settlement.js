const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GAME_LOG_FIELDS,
  GAME_LOG_HYDRATE,
  extractBatterGameLogs,
  settledBatterGame,
  starterStatus,
  totalBases,
} = require('../lib/total-bases-settlement');
const { _test: discovery } = require('../lib/total-bases-discovery-handler');

function hitting(date, gamePk, {
  plateAppearances = 4,
  totalBases: bases = 0,
  positionsPlayed = [{ code: '10', abbreviation: 'DH' }],
} = {}) {
  return {
    date,
    game: { gamePk },
    stat: { plateAppearances, totalBases: bases },
    positionsPlayed,
  };
}

function fielding(date, gamePk, gamesStarted) {
  return { date, game: { gamePk }, stat: { gamesStarted } };
}

test('MLB hydration requests hitting and fielding starter evidence in one compact payload', () => {
  assert.equal(GAME_LOG_HYDRATE(2026), 'stats(group=[hitting,fielding],type=[gameLog],season=2026)');
  for (const field of ['totalBases', 'plateAppearances', 'gamesStarted', 'positionsPlayed', 'gamePk']) {
    assert.ok(GAME_LOG_FIELDS.split(',').includes(field), `missing MLB field ${field}`);
  }

  const logs = extractBatterGameLogs({
    stats: [
      { group: { displayName: 'fielding' }, splits: [fielding('2026-09-04', 823418, 0)] },
      { group: { displayName: 'hitting' }, splits: [hitting('2026-09-04', 823418)] },
    ],
  });
  assert.equal(logs.hitting.length, 1);
  assert.equal(logs.fielding.length, 1);
});

test('Michael Harris II Sep 4 appearance is void because he did not start', () => {
  const gameLogs = {
    hitting: [hitting('2026-09-04', 823418, {
      plateAppearances: 2,
      totalBases: 0,
      positionsPlayed: [
        { code: '11', abbreviation: 'PH' },
        { code: '8', abbreviation: 'CF' },
      ],
    })],
    fielding: [fielding('2026-09-04', 823418, 0)],
  };

  assert.deepEqual(settledBatterGame(gameLogs, '2026-09-04'), {
    status: 'void',
    reason: 'did_not_start',
    appearances: 1,
    started: false,
    totalBases: 0,
    plateAppearances: 2,
    gamePk: 823418,
  });
});

test('non-starter remains void even when the plate appearance would have won', () => {
  const gameLogs = {
    hitting: [hitting('2026-09-05', 900001, { totalBases: 4 })],
    fielding: [fielding('2026-09-05', 900001, 0)],
  };
  const result = settledBatterGame(gameLogs, '2026-09-05');
  assert.equal(result.status, 'void');
  assert.equal(result.reason, 'did_not_start');
  assert.equal(result.totalBases, 4);
});

test('pure pinch hitters are void when MLB has no fielding row', () => {
  const pinchHit = hitting('2026-09-05', 900002, {
    plateAppearances: 1,
    totalBases: 2,
    positionsPlayed: [{ code: '11', abbreviation: 'PH' }],
  });
  const gameLogs = { hitting: [pinchHit], fielding: [] };
  assert.equal(starterStatus(gameLogs, '2026-09-05', 900002, pinchHit), false);
  assert.equal(settledBatterGame(gameLogs, '2026-09-05').reason, 'did_not_start');
});

test('only verified starters with a plate appearance are graded', () => {
  const starter = {
    hitting: [hitting('2026-09-05', 900003, { totalBases: 2 })],
    fielding: [fielding('2026-09-05', 900003, 1)],
  };
  const graded = settledBatterGame(starter, '2026-09-05');
  assert.equal(graded.status, 'graded');
  assert.equal(graded.started, true);
  assert.equal(graded.totalBases, 2);

  const noAppearance = settledBatterGame({ hitting: [], fielding: [] }, '2026-09-05');
  assert.equal(noAppearance.status, 'void');
  assert.equal(noAppearance.reason, 'no_plate_appearance');

  const missingStarterEvidence = settledBatterGame({
    hitting: [hitting('2026-09-05', 900004, {
      positionsPlayed: [{ code: '10', abbreviation: 'DH' }],
    })],
    fielding: [],
  }, '2026-09-05');
  assert.equal(missingStarterEvidence.status, 'unverified');
  assert.equal(missingStarterEvidence.reason, 'starter_status_unavailable');
});

test('same-day doubleheaders remain ungraded when the archived prop cannot identify the game', () => {
  const gameLogs = {
    hitting: [
      hitting('2026-09-05', 900005, { totalBases: 0 }),
      hitting('2026-09-05', 900006, { totalBases: 3 }),
    ],
    fielding: [
      fielding('2026-09-05', 900005, 1),
      fielding('2026-09-05', 900006, 1),
    ],
  };
  const result = settledBatterGame(gameLogs, '2026-09-05');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'multiple_same_date_appearances');
  assert.equal(result.appearances, 2);
});

test('Discovery form history includes starts and excludes pinch-hit appearances', () => {
  const gameLogs = {
    hitting: [
      hitting('2026-09-01', 900010, { totalBases: 2 }),
      hitting('2026-09-02', 900011, {
        totalBases: 4,
        positionsPlayed: [{ code: '11', abbreviation: 'PH' }],
      }),
      hitting('2026-09-03', 900012, { totalBases: 1 }),
      hitting('2026-09-04', 900013, { totalBases: 3 }),
    ],
    fielding: [
      fielding('2026-09-01', 900010, 1),
      fielding('2026-09-03', 900012, 0),
      fielding('2026-09-04', 900013, 1),
    ],
  };

  assert.deepEqual(discovery.startsBefore(gameLogs, '2026-09-04').map((row) => row.date), ['2026-09-01']);
});

test('total bases falls back to hit components when MLB omits totalBases', () => {
  assert.equal(totalBases({ hits: 4, doubles: 1, triples: 1, homeRuns: 1 }), 10);
});
