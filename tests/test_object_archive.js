const test = require('node:test');
const assert = require('node:assert/strict');
const { digest, isRecordKey, cacheSeconds } = require('../lib/object-archive');
const { fixture } = require('./archive-fixtures');
const key = 'mlbhr:raw:2026-09-13:0817';

test('archives exact bytes, retains older versions and rejects corruption', async () => {
  const { archive, transport } = fixture();
  const original = JSON.stringify({ data: ['José', 'original provider payload'] });
  await archive.write(key, original);
  await archive.write(key, 'new version');
  assert.equal(await archive.readVersion(key, digest(original)), original);
  assert.equal(await archive.read(key), 'new version');
  const blob = `${archive.root(key)}/versions/${digest('new version')}.json.gz`;
  await transport.put(blob, Buffer.from('corrupt'));
  await assert.rejects(archive.read(key));
});

test('publishes no pointer when permanent read-back verification fails', async () => {
  const { archive, transport } = fixture();
  const get = transport.get.bind(transport);
  transport.get = async (name) => name.includes('/versions/') ? null : get(name);
  await assert.rejects(archive.write(key, 'capture'), /version is missing/);
  assert.equal(await archive.head(key), null);
});

test('concurrent NX writes preserve exactly one frozen selection', async () => {
  const { archive } = fixture();
  const pick = 'mlbtb2:frozen-selections:2026-09-13:0817';
  const results = await Promise.all(['A', 'B'].map(value => archive.write(pick, value, { onlyIfAbsent: true })));
  assert.equal(results.filter(row => row.written).length, 1);
  assert.ok(['A', 'B'].includes(await archive.read(pick)));
});

test('expired leases can be replaced, and the previous owner cannot release the replacement', async () => {
  let now = 0;
  const { archive } = fixture(() => now);
  const lease = 'mlbhr:attempt:2026-09-13:0817';
  assert.equal(await archive.acquireLease(lease, 'one', 10), true);
  assert.equal(await archive.acquireLease(lease, 'two', 10), false);
  now = 10001;
  assert.equal(await archive.acquireLease(lease, 'two', 10), true);
  assert.equal(await archive.releaseLease(lease, 'one'), false);
  assert.equal(await archive.readLease(lease), 'two');
});

test('concurrent lease claims have one winner', async () => {
  const { archive } = fixture();
  const claims = await Promise.all(['A', 'B', 'C'].map(owner => archive.acquireLease('archive-maintenance', owner, 300)));
  assert.equal(claims.filter(Boolean).length, 1);
});

test('credentials, disposable caches and arbitrary keys cannot enter the archive', () => {
  for (const key of ['mlbhr:config:sportsgameodds-api-key', 'mlbstrikeouts:discovery:cache', 'anything', '../../secret']) {
    assert.equal(isRecordKey(key), false);
  }
  for (const key of ['mlbhr:triples-model:state:2026-09-13-0123456789abcdef:part-000.bin', 'mlbstrikeouts:checkpoint:2026-09-13:1117', 'mlbhr:top100:latest']) {
    assert.equal(isRecordKey(key), true);
  }
});

test('historical records cannot gain new 14-day cache lifetimes from Discovery reads', () => {
  assert.equal(cacheSeconds('mlbhr:raw:2026-08-01:0817', '{}', Date.parse('2026-09-14')), 0);
  assert.equal(cacheSeconds('mlbhr:triples-model:latest', '{"slate_date":"2026-08-01"}', Date.parse('2026-09-14')), 0);
  assert.ok(cacheSeconds(key, '{}', Date.parse('2026-09-14')) < 14 * 86400);
});
