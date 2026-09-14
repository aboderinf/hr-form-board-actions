const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./archive-fixtures');
const objects = require('../lib/object-archive');

test('capture archives raw bytes before projections and retry reuses them after every Redis write fails', async (t) => {
  const f = fixture();
  await f.archive.writeControl('migration-mirror', { completedAt: '2026-09-13T00:00:00Z' });
  const previous = { ...process.env };
  Object.assign(process.env, { ARCHIVE_MODE: 'active', SPORTSGAMEODDS_API_KEY: 'test-only',
    UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only' });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  t.mock.method(objects, 'getArchive', () => f.archive);
  t.mock.method(console, 'warn', () => {});
  delete require.cache[require.resolve('../lib/checkpoint-runtime')];
  const runtime = require('../lib/checkpoint-runtime');
  let providerCalls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://api.sportsgameodds.com/v2/events?')) {
      providerCalls += 1;
      return Response.json({ data: [] });
    }
    assert.equal(url, 'https://redis.example.test');
    const command = JSON.parse(options.body);
    return command[0] === 'GET' ? Response.json({ result: null }) : Response.json({ error: 'ERR DB capacity quota exceeded' });
  });
  const input = { slateDate: '2026-09-14', checkpoint: '0817', now: new Date('2026-09-14T12:17:00Z') };
  const first = await runtime.captureCheckpoint(input);
  assert.equal(first.outcome, 'captured');
  const heads = f.transport.writes.filter(key => key.endsWith('/head.json'));
  assert.equal(heads[0], `${f.archive.root('mlbhr:raw:2026-09-14:0817')}/head.json`);
  const second = await runtime.captureCheckpoint(input);
  assert.equal(second.outcome, 'reused');
  assert.equal(second.providerRequests, 0);
  assert.equal(providerCalls, 1);
  assert.equal(second.payload.providerResponseSha256, first.payload.providerResponseSha256);
});

test('gateway authentication is checked before any archive action runs', async () => {
  const handler = require('../api/capture-checkpoint');
  let status;
  let payload;
  await handler({ method: 'POST', query: { action: 'archive-record' }, headers: {}, body: { command: ['GET', 'mlbhr:config:sportsgameodds-api-key'] } }, {
    setHeader() {}, status(value) { status = value; return this; }, json(value) { payload = value; return this; },
  });
  assert.equal(status, 489);
  assert.equal(payload.message, 'Unauthorized');
});
