const { ObjectArchive } = require('../lib/object-archive');
class MemoryTransport {
  constructor() { this.objects = new Map(); this.serial = 0; this.writes = []; }
  async get(key) {
    const row = this.objects.get(key);
    return row ? { body: Buffer.from(row.body), etag: row.etag } : null;
  }
  async put(key, body, { absent, etag } = {}) {
    const current = this.objects.get(key);
    if ((absent && current) || (etag && current?.etag !== etag)) throw Object.assign(new Error('Precondition failed'), { status: 412 });
    this.objects.set(key, { body: Buffer.from(body), etag: String(++this.serial) });
    this.writes.push(key);
  }
}
function fixture(now = () => Date.parse('2026-09-14T12:00:00Z')) {
  const transport = new MemoryTransport();
  const archive = new ObjectArchive(transport, { now });
  const data = new Map();
  const calls = [];
  const redis = async (command) => {
    calls.push(command);
    const [op, key, value] = command;
    if (op === 'GET') return data.get(key) ?? null;
    if (op === 'SET') {
      if (command.includes('NX') && data.has(key)) return null;
      data.set(key, value); return 'OK';
    }
    if (op === 'SCAN') return ['0', [...data.keys()]];
    if (op === 'EVAL') return data.get(command[3]) === command[4] ? 1 : 0;
    throw new Error(`Unexpected Redis operation ${op}`);
  };
  return { archive, transport, redis, data, calls, now };
}
module.exports = { MemoryTransport, fixture };
