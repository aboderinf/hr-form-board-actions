const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const codec = require('../lib/redis-value-codec');
const runtime = require('../lib/checkpoint-runtime');
const { maintainStorage } = require('../lib/storage-maintenance');
const { releaseArchivedDuplicates } = require('../lib/storage-maintenance');
const { readColdArchive, archivedKeys } = require('../lib/storage-archive');
const { readTotalBasesCheckpoint } = require('../lib/total-bases-runtime');

const original = JSON.stringify({ captured_at: '2026-08-20T12:17:03.000Z',
  source: { provider_call_id: 'original-call', provider_response_sha256: 'original-hash' },
  rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Player ${i}`, market: 'home-runs', odds: 500, book: 'fanduel' })) });

for (const key of ['mlbhr:checkpoint:2026-08-20:0817', 'mlbhr:discovery:2026-08-20:0817',
  'mlbhr:top100:2026-08-20', 'mlbhr:latest', 'mlbstrikeouts:checkpoint:2026-08-20:0817',
  'mlbtb2:checkpoint:2026-08-20:0817', 'mlbtriples:checkpoint:2026-08-20:0817']) {
  test(`${key} compression restores every original byte`, () => {
    const packed = codec.encodeRedisValue(key, original);
    assert.ok(Buffer.byteLength(packed) < Buffer.byteLength(original) / 2);
    assert.equal(codec.decodeRedisValue(packed), original);
    assert.equal(codec.encodeRedisValue(key, packed), packed);
    assert.equal(codec.decodeRedisValue(original), original);
  });
}

test('credentials, model state, frozen selections and ledgers retain their format', () => {
  for (const key of ['mlbhr:config:secret', 'mlbhr:triples-model:state:version:part-001.bin',
    'mlbtb2:frozen-selections:2026-08-20:0817', 'mlbhr:ledger:2026-08-20']) {
    assert.equal(codec.isCompressibleKey(key), false);
    assert.equal(codec.encodeRedisValue(key, original), original);
  }
});

test('raw archive compression preserves provider bytes, metadata and SHA', () => {
  const raw = JSON.stringify({ data: Array.from({ length: 3000 }, (_, i) => ({
    eventID: `event-${i}`, odds: { homeRuns: { book: 'fanduel', odds: i % 31 + 200, statEntityID: `PLAYER_${i}_MLB` } },
  })) });
  const archive = { requestedAt: '2026-08-20T12:17:00.000Z', completedAt: '2026-08-20T12:17:03.000Z',
    responseSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    responseEncoding: 'gzip+base64', responseGzipBase64: zlib.gzipSync(raw).toString('base64') };
  const packed = codec.encodeRedisValue('mlbhr:raw:2026-08-20:0817', JSON.stringify(archive));
  const result = JSON.parse(packed);
  assert.equal(result.responseEncoding, 'br+base64');
  assert.equal(result.requestedAt, archive.requestedAt);
  assert.equal(result.completedAt, archive.completedAt);
  const restored = zlib.brotliDecompressSync(Buffer.from(result.responseBrotliBase64, 'base64'));
  assert.equal(restored.toString('utf8'), raw);
  assert.equal(crypto.createHash('sha256').update(restored).digest('hex'), archive.responseSha256);
});

function fakeRedis(t, { reject = false, race = false } = {}) {
  const key = 'mlbhr:discovery:2026-08-20:0817';
  const records = new Map([[key, original]]);
  const expiry = new Map([[key, 1789916223000]]);
  const commands = [];
  for (const [name, value] of Object.entries({ UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test-token' })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.startsWith('https://redis.test'));
    const command = JSON.parse(options.body);
    function execute(cmd) {
      commands.push(cmd);
      const [op, name] = cmd;
      if (op === 'INFO') return { result: 'used_memory:102033\r\ndb0:keys=1,expires=1' };
      if (op === 'SCAN') return { result: ['0', [key]] };
      if (op === 'STRLEN') return { result: Buffer.byteLength(records.get(name) || '') };
      if (op === 'GETRANGE') return { result: (records.get(name) || '').slice(Number(cmd[2]), Number(cmd[3]) + 1) };
      if (op === 'GET') return { result: records.get(name) || null };
      if (op === 'SET') { records.set(name, cmd[2]); return { result: 'OK' }; }
      if (op === 'EVAL') {
        assert.match(cmd[1], /KEEPTTL/);
        assert.doesNotMatch(cmd[1], /DEL/);
        if (race) records.set(key, 'newer concurrent value');
        if (records.get(cmd[3]) !== cmd[4]) return { result: 0 };
        if (reject) return { error: 'ERR DB capacity quota exceeded' };
        records.set(cmd[3], cmd[5]); return { result: 1 };
      }
      throw new Error(`Unexpected command: ${op}`);
    }
    return Response.json(url.endsWith('/pipeline') ? command.map(execute) : execute(command));
  });
  return { key, records, expiry, commands };
}

test('in-place maintenance preserves Discovery content, keys and original expiry', async (t) => {
  const { key, records, expiry, commands } = fakeRedis(t);
  const result = await maintainStorage({ maxRecords: 1 });
  assert.equal(result.recordsCompacted, 1);
  assert.equal(codec.decodeRedisValue(records.get(key)), original);
  assert.equal(expiry.get(key), 1789916223000);
  assert.ok(commands.every((cmd) => cmd[0] !== 'DEL'));
  assert.equal(await runtime.redisCommand(['GET', key]), original);
});

test('quota rejection never removes or changes an archive', async (t) => {
  const { key, records, commands } = fakeRedis(t, { reject: true });
  const result = await maintainStorage({ maxRecords: 1 });
  assert.equal(result.status, 'capacity_blocked');
  assert.equal(records.get(key), original);
  assert.ok(commands.every((cmd) => cmd[0] !== 'DEL'));
});

test('healthy storage does not repeat a full inventory on scheduler retries', async (t) => {
  const { commands } = fakeRedis(t);
  await maintainStorage({ maxRecords: 1 });
  const scans = commands.filter((cmd) => cmd[0] === 'SCAN').length;
  assert.equal((await maintainStorage()).status, 'recently_compacted');
  assert.equal(commands.filter((cmd) => cmd[0] === 'SCAN').length, scans);
});

test('concurrent updates are preserved by compare-and-set', async (t) => {
  const { key, records } = fakeRedis(t, { race: true });
  const result = await maintainStorage({ maxRecords: 1 });
  assert.equal(result.recordsCompacted, 0);
  assert.equal(records.get(key), 'newer concurrent value');
});

test('permanent backups serve identical historical odds through the existing reader', async (t) => {
  fakeRedis(t);
  for (const key of archivedKeys()) {
    const [, , date, checkpoint] = key.split(':');
    const expected = readColdArchive(key);
    assert.equal(await runtime.redisCommand(['GET', key]), expected);
    assert.equal(await runtime.redisCommand(['GET', key], { raw: true }), null);
    assert.equal(JSON.stringify(await readTotalBasesCheckpoint(date, checkpoint)), expected);
  }
});

test('rescue releases only exact, durably backed-up duplicates and preserves a racing update', async (t) => {
  fakeRedis(t);
  const keys = archivedKeys();
  const records = new Map(keys.map((key) => [key, readColdArchive(key)]));
  t.mock.method(global, 'fetch', async (url, options) => {
    const cmd = JSON.parse(options.body);
    if (cmd[0] === 'GET') return Response.json({ result: records.get(cmd[1]) || null });
    assert.equal(cmd[0], 'EVAL');
    assert.match(cmd[1], /GET.*KEYS\[1\].*ARGV\[1\]/);
    assert.match(cmd[1], /DEL/);
    const key = cmd[3];
    assert.equal(cmd[4], readColdArchive(key));
    if (key === keys[0]) records.set(key, 'new concurrent checkpoint');
    if (records.get(key) !== cmd[4]) return Response.json({ result: 0 });
    records.delete(key);
    return Response.json({ result: 1 });
  });
  const result = await releaseArchivedDuplicates();
  assert.equal(result.recordsArchived, keys.length - 1);
  assert.equal(records.get(keys[0]), 'new concurrent checkpoint');
  for (const key of keys.slice(1)) {
    assert.equal(records.has(key), false);
    assert.ok(JSON.parse(readColdArchive(key)).rows.length > 0);
    assert.equal(await runtime.redisCommand(['GET', key]), readColdArchive(key));
  }
});

test('over-quota rescue rechecks immutable duplicates and every removed value stays readable', async (t) => {
  fakeRedis(t);
  const keys = archivedKeys();
  const records = new Map(keys.map((key) => [key, readColdArchive(key)]));
  t.mock.method(global, 'fetch', async (url, options) => {
    const cmd = JSON.parse(options.body);
    if (cmd[0] === 'GET') return Response.json({ result: records.get(cmd[1]) || null });
    if (cmd[0] === 'EVAL') {
      if (cmd[3] === keys[0]) records.set(keys[0], 'changed since verification');
      return Response.json({ error: 'ERR DB capacity quota exceeded' });
    }
    assert.equal(cmd[0], 'DEL');
    assert.ok(keys.includes(cmd[1]));
    assert.equal(records.get(cmd[1]), readColdArchive(cmd[1]));
    return Response.json({ result: Number(records.delete(cmd[1])) });
  });
  const result = await releaseArchivedDuplicates();
  assert.equal(result.recordsArchived, keys.length - 1);
  assert.equal(records.get(keys[0]), 'changed since verification');
  for (const key of keys.slice(1)) assert.equal(await runtime.redisCommand(['GET', key]), readColdArchive(key));
});
