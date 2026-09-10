const { redisCommand, redisConfig } = require('./checkpoint-runtime');
const { randomUUID } = require('node:crypto');
const { isCompressibleKey, isCompressedPrefix } = require('./redis-value-codec');

function parseInfo(raw) {
  return Object.fromEntries(String(raw || '').split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes(':'))
    .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]));
}

async function storageSummary({ probeWrites = false } = {}) {
  const info = parseInfo(await redisCommand(['INFO']));
  const limit = Number(process.env.REDIS_CAPACITY_BYTES || 268435456);
  const summary = {
    // Upstash INFO used_memory measures its RAM cache, not stored data size.
    usedBytes: null,
    memoryBytes: Number(info.used_memory) || null,
    limitBytes: limit,
    capacityAvailable: null,
    keyCount: Number(info.db0?.match(/keys=(\d+)/)?.[1]) || null,
  };
  if (probeWrites) {
    const key = `mlbhr:health-write:${randomUUID()}`;
    try {
      summary.capacityAvailable = (await redisCommand(['SET', key, 'ok', 'EX', 30])) === 'OK';
      await redisCommand(['DEL', key]);
    } catch (error) {
      const message = String(error.message || error);
      if (!/capacity quota exceeded/i.test(message)) throw error;
      summary.capacityAvailable = false;
      summary.usedBytes = Number(message.match(/Usage:\s*(\d+)/i)?.[1]) || null;
      summary.limitBytes = Number(message.match(/Threshold:\s*(\d+)/i)?.[1]) || limit;
    }
  }
  return summary;
}

function storageGroup(key) {
  if (key.startsWith('mlbhr:triples-model:state:')) return 'triples-model-state';
  if (key.startsWith('mlbhr:triples-model:')) return 'triples-model-outputs';
  if (key.startsWith('mlbhr:raw:')) return 'provider-raw-archives';
  if (key.startsWith('mlbhr:config:')) return 'configuration';
  const pieces = key.split(':');
  return pieces.slice(0, 2).join(':');
}

// Bounded, read-only inventory. No values or credentials are returned.
async function storageAudit() {
  const summary = await storageSummary();
  const keys = new Set();
  let cursor = '0';
  let pages = 0;
  do {
    const page = await redisCommand(['SCAN', cursor, 'COUNT', 500]);
    cursor = String(page[0]);
    for (const key of page[1]) keys.add(String(key));
    pages += 1;
  } while (cursor !== '0' && pages < 40 && keys.size < 10000);
  const { url, token } = redisConfig();
  const groups = new Map();
  const versions = new Map();
  const candidates = [];
  const allKeys = [...keys];
  for (let start = 0; start < allKeys.length; start += 100) {
    const batch = allKeys.slice(start, start + 100);
    const commands = batch.flatMap((key) => [['STRLEN', key], ['GETRANGE', key, 0, 1023]]);
    const response = await fetch(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!response.ok) throw new Error(`Storage inventory HTTP ${response.status}`);
    const lengths = await response.json();
    if (!Array.isArray(lengths)) throw new Error('Invalid storage inventory response');
    batch.forEach((key, index) => {
      const group = storageGroup(key);
      const row = groups.get(group) || { group, keys: 0, stringBytes: 0 };
      const bytes = Number(lengths[index * 2]?.result) || 0;
      const prefix = lengths[index * 2 + 1]?.result || '';
      if (bytes >= 4096 && isCompressibleKey(key) && !isCompressedPrefix(prefix)) {
        candidates.push({ key, stringBytes: bytes });
      }
      row.keys += 1; row.stringBytes += bytes; groups.set(group, row);
      const match = key.match(/^mlbhr:triples-model:state:(\d{4}-\d{2}-\d{2}-[a-f0-9]{16}):part-\d{3}\.bin$/);
      if (match) {
        const state = versions.get(match[1]) || { version: match[1], parts: 0, stringBytes: 0 };
        state.parts += 1; state.stringBytes += bytes; versions.set(match[1], state);
      }
    });
  }
  const pointerRaw = await redisCommand(['GET', 'mlbhr:triples-model:state:latest']);
  const pointer = pointerRaw ? JSON.parse(pointerRaw) : null;
  return {
    ...summary, scannedKeys: keys.size, complete: cursor === '0',
    storedStringBytes: [...groups.values()].reduce((sum, row) => sum + row.stringBytes, 0),
    // Plain JSON projections have substantially more recoverable space than
    // provider payloads that are already gzipped.
    largestRecords: candidates.sort((a, b) => Number(a.key.startsWith('mlbhr:raw:')) - Number(b.key.startsWith('mlbhr:raw:')) || b.stringBytes - a.stringBytes),
    groups: [...groups.values()].sort((a, b) => b.stringBytes - a.stringBytes),
    activeTriplesStateVersion: pointer?.version || null,
    triplesStateVersions: [...versions.values()].sort((a, b) => b.version.localeCompare(a.version)),
  };
}

module.exports = { parseInfo, storageSummary, storageAudit };
