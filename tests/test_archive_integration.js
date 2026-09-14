const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./archive-fixtures');
const { createArchiveStore } = require('../lib/archive-store');
const { migrateBatch } = require('../lib/archive-migration');
const { encodeRedisValue, decodeRedisValue } = require('../lib/redis-value-codec');

async function active(f, redis = f.redis) {
  await f.archive.writeControl('migration-mirror', { completedAt: '2026-09-13T00:00:00Z' });
  return createArchiveStore({ ...f, redis, mode: 'active', warn: () => {} });
}

test('full Redis cannot block active archive writes, capture leases or later cold reads', async () => {
  const f = fixture();
  const store = await active(f, async () => { throw new Error('ERR DB capacity quota exceeded'); });
  const key = 'mlbhr:checkpoint:2026-09-14:0817';
  const wire = encodeRedisValue(key, JSON.stringify({ schemaVersion: 5, rows: Array(200).fill({ name: 'original' }) }));
  assert.equal(await store.command(['SET', key, wire, 'EX', 34560000]), 'OK');
  assert.equal(decodeRedisValue(await store.command(['GET', key])), decodeRedisValue(wire));
  assert.equal(await store.command(['GET', 'mlbhr:checkpoint:2026-09-14:1117']), null);
  assert.equal(await store.command(['SET', 'mlbhr:attempt:2026-09-14:1117', 'owner', 'NX', 'EX', 600]), 'OK');
});

test('a failed archive write leaves the original Redis record and TTL untouched', async () => {
  const f = fixture();
  const key = 'mlbhr:raw:2026-09-13:0817';
  f.data.set(key, 'original');
  f.archive.write = async () => { throw new Error('R2 unavailable'); };
  const store = await active(f);
  await assert.rejects(store.command(['SET', key, 'new value', 'EX', 1]), /R2 unavailable/);
  assert.equal(f.data.get(key), 'original');
  assert.equal(f.calls.length, 0);
});

test('archive pointer defeats a stale Redis copy after a concurrent cache write', async () => {
  const f = fixture();
  const store = await active(f);
  const key = 'mlbhr:triples-model:latest';
  await f.archive.write(key, 'newer');
  f.data.set(key, 'older');
  assert.equal(await store.command(['GET', key]), 'newer');
});

test('old Discovery records are readable without repopulating Redis', async () => {
  const f = fixture();
  const store = await active(f);
  for (const prefix of ['mlbhr:checkpoint', 'mlbstrikeouts:checkpoint', 'mlbtb2:checkpoint', 'mlbtriples:checkpoint']) {
    const key = `${prefix}:2026-08-01:0817`;
    await f.archive.write(key, 'saved historical record');
    assert.equal(await store.command(['GET', key]), 'saved historical record');
  }
  assert.equal(f.calls.filter(call => call[0] === 'SET').length, 0);
});

test('mirror NX imports the existing frozen pick instead of replacing it', async () => {
  const f = fixture();
  const key = 'mlbtb2:frozen-selections:2026-09-13:0817';
  f.data.set(key, 'existing pick');
  const store = createArchiveStore({ ...f, mode: 'mirror' });
  assert.equal(await store.command(['SET', key, 'different pick', 'NX', 'EX', 34560000]), null);
  assert.equal(await f.archive.read(key), 'existing pick');
});

test('active retention cannot be enabled before verified migration completes', async () => {
  const f = fixture();
  const store = createArchiveStore({ ...f, mode: 'active' });
  await assert.rejects(store.command(['SET', 'mlbhr:latest', '{}', 'EX', 10]), /completed, verified/);
  await assert.rejects(migrateBatch({ ...f, mode: 'active' }), /Finish the verified mirror/);
  assert.equal(f.calls.length, 0);
});

test('migration resumes across batches, preserves exact versions and expires only after verification', async () => {
  let clock = Date.parse('2026-09-14T12:00:00Z');
  const f = fixture(() => clock);
  const key = 'mlbhr:raw:2026-08-01:0817';
  f.data.set(key, 'original capture');
  f.data.set('mlbhr:config:sportsgameodds-api-key', 'must never leave Redis');
  let result = await migrateBatch({ ...f, mode: 'mirror', maxRecords: 2 });
  assert.equal(result.status, 'awaiting_writer_drain');
  clock += 600001;
  do { result = await migrateBatch({ ...f, mode: 'mirror', maxRecords: 2 }); } while (!result.completedAt);
  assert.equal(await f.archive.read(key), 'original capture');
  assert.ok(f.calls.every(call => !['EVAL', 'DEL', 'EXPIRE'].includes(call[0])));
  assert.ok([...f.transport.objects.values()].every(row => !row.body.includes('must never leave Redis')));
  result = await migrateBatch({ ...f, mode: 'active', maxRecords: 64 });
  assert.equal(result.status, 'complete');
  assert.equal(f.data.get(key), 'original capture', 'migration never deletes the source');
  const expiry = f.calls.find(call => call[0] === 'EVAL' && call[3] === key);
  assert.equal(expiry[4], 'original capture');
  assert.equal(expiry[5], 60);
});

test('failed migration keeps its cursor and never applies retention to an unverified record', async () => {
  const f = fixture();
  const key = 'mlbhr:raw:2026-08-01:0817';
  f.data.set(key, 'original');
  await f.archive.writeControl('migration-mirror', { startedAt: '2026-09-13T00:00:00Z', pending: [key], cursor: '0', scanDone: true, verifiedRecords: 0, verifiedBytes: 0 });
  f.archive.write = async () => { throw new Error('verification failed'); };
  await assert.rejects(migrateBatch({ ...f, mode: 'mirror' }), /verification failed/);
  const state = await f.archive.readControl('migration-mirror');
  assert.equal(state.status, 'blocked');
  assert.deepEqual(state.pending, [key]);
  assert.ok(f.calls.every(call => call[0] === 'GET'));
});
