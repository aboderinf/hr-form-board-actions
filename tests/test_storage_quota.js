const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const runtime = require('../lib/checkpoint-runtime');
const { readStrikeoutsCheckpoint } = require('../lib/strikeouts-runtime');
const { readTotalBasesCheckpoint } = require('../lib/total-bases-runtime');
const { parseInfo } = require('../lib/storage-health');

const date = '2026-09-10';
const cp = '0817';
const completedAt = '2026-09-10T12:17:03.000Z';
const raw = { data: [{ eventID: 'game-1', status: { startsAt: '2026-09-10T23:00:00Z' }, odds: {
  hr: { statID: 'battingHomeRuns', statEntityID: 'TEST_BATTER_1_MLB', periodID: 'game', betTypeID: 'yn', sideID: 'yes', byBookmaker: { fanduel: { available: true, odds: 500 } } },
  triples: { statID: 'battingTriples', statEntityID: 'TEST_BATTER_1_MLB', periodID: 'game', betTypeID: 'yn', sideID: 'yes', byBookmaker: { fanduel: { available: true, odds: 1500 } } },
  tb: { statID: 'battingTotalBases', statEntityID: 'TEST_BATTER_1_MLB', periodID: 'game', betTypeID: 'ou', sideID: 'over', bookOverUnder: 1.5, byBookmaker: { fanduel: { available: true, odds: 110 } } },
  ks: { statID: 'pitchingStrikeouts', statEntityID: 'TEST_PITCHER_1_MLB', periodID: 'game', betTypeID: 'ou', sideID: 'over', bookOverUnder: 5.5, byBookmaker: { fanduel: { available: true, odds: 110 } } },
} }] };

async function withRedis(t, { corrupt = false, missing = false } = {}, run) {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  t.after(() => {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  });
  const hash = runtime.normalizeProviderPayload(raw, date, cp, completedAt, completedAt).providerResponseSha256;
  const archive = { completedAt, requestedAt: completedAt, responseEncoding: 'gzip+base64', responseSha256: corrupt ? '0'.repeat(64) : hash,
    responseGzipBase64: zlib.gzipSync(JSON.stringify(raw)).toString('base64') };
  const commands = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://redis.example.test', 'never call the paid odds provider');
    const command = JSON.parse(options.body); commands.push(command);
    if (command[0] === 'SET') return Response.json({ error: 'ERR DB capacity quota exceeded' });
    assert.equal(command[0], 'GET');
    const value = command[1] === `mlbhr:raw:${date}:${cp}` && !missing ? JSON.stringify(archive)
      : command[1] === runtime.archiveKey(date, cp) && !missing ? JSON.stringify({ schemaVersion: 0 }) : null;
    return Response.json({ result: value });
  });
  t.mock.method(console, 'warn', () => {});
  await run({ hash, commands });
}

for (const [market, reader] of [
  ['HR', runtime.readCheckpoint], ['strikeouts', readStrikeoutsCheckpoint],
  ['2+ bases', readTotalBasesCheckpoint], ['triples', runtime.readTriplesCheckpoint],
]) {
  test(`${market} serves verified archived odds when derived cache writes hit quota`, async (t) => {
    await withRedis(t, {}, async ({ hash, commands }) => {
      const result = await reader(date, cp);
      assert.equal(result.providerResponseSha256, hash);
      assert.equal(result.rows.length, 1);
      assert.ok(commands.some((command) => command[0] === 'SET'));
    });
  });
}

test('corrupt raw archives still fail closed before any cache write', async (t) => {
  await withRedis(t, { corrupt: true }, async ({ commands }) => {
    await assert.rejects(readStrikeoutsCheckpoint(date, cp), /SHA does not match/);
    assert.ok(commands.every((command) => command[0] !== 'SET'));
  });
});

test('missing archive remains unavailable instead of inventing odds', async (t) => {
  await withRedis(t, { missing: true }, async () => assert.equal(await readStrikeoutsCheckpoint(date, cp), null));
});

test('storage INFO parsing keeps Redis counters and ignores section labels', () => {
  assert.deepEqual(parseInfo('# Memory\r\nused_memory:269261051\r\n# Keyspace\r\ndb0:keys=123,expires=120\r\n'), {
    used_memory: '269261051', db0: 'keys=123,expires=120',
  });
});
