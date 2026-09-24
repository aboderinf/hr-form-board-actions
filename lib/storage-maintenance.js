const { redisCommand } = require('./checkpoint-runtime');
const { storageAudit } = require('./storage-health');
const { encodeRedisValue } = require('./redis-value-codec');
const { readColdArchive, archivedKeys } = require('./storage-archive');

// A rejected SET or a concurrent update leaves the original record intact.
// Never DEL before SET: Redis Lua errors do not roll back prior commands.
const REPLACE_IF_UNCHANGED = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1`;

const RELEASE_VERIFIED_DUPLICATE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;

async function releaseArchivedDuplicates() {
  let recordsArchived = 0;
  let bytesArchived = 0;
  for (const key of archivedKeys()) {
    const original = readColdArchive(key); // Verify the deployed backup SHA first.
    const current = await redisCommand(['GET', key], { raw: true });
    if (current !== original) continue;
    let released;
    try {
      released = await redisCommand(['EVAL', RELEASE_VERIFIED_DUPLICATE, 1, key, original]);
    } catch (error) {
      if (!/capacity quota exceeded/i.test(String(error.message || error))) throw error;
      // Upstash blocks EVAL itself at capacity, including scripts containing
      // only DEL. These four manifest entries are immutable historical market
      // checkpoints, with verified permanent copies and no user edit path.
      // Recheck before using its supported space-releasing command. Never
      // extend this exception to mutable state, live captures or ledgers.
      if (await redisCommand(['GET', key], { raw: true }) !== original) continue;
      released = await redisCommand(['DEL', key]);
    }
    if (Number(released) === 1) {
      recordsArchived += 1;
      bytesArchived += Buffer.byteLength(original);
    }
  }
  return { recordsArchived, bytesArchived };
}


async function pruneStaleTriplesState({ keepVersions = 3 } = {}) {
  const pointerRaw = await redisCommand(['GET', 'mlbhr:triples-model:state:latest']);
  let active = null;
  try { active = pointerRaw ? JSON.parse(pointerRaw)?.version || null : null; } catch {}

  const versionKeys = new Map();
  let cursor = '0';
  let pages = 0;
  do {
    const page = await redisCommand([
      'SCAN', cursor,
      'MATCH', 'mlbhr:triples-model:state:*:part-*.bin',
      'COUNT', 1000,
    ]);
    cursor = String(page[0]);
    for (const key of page[1] || []) {
      const match = String(key).match(/^mlbhr:triples-model:state:(\d{4}-\d{2}-\d{2}-[a-f0-9]{16}):part-\d{3}\.bin$/);
      if (!match) continue;
      const rows = versionKeys.get(match[1]) || [];
      rows.push(String(key));
      versionKeys.set(match[1], rows);
    }
    pages += 1;
  } while (cursor !== '0' && pages < 10);

  const ordered = [...versionKeys.keys()].sort((a, b) => b.localeCompare(a));
  const keep = new Set(ordered.slice(0, Math.max(1, keepVersions)));
  if (active) keep.add(active);

  const staleKeys = [];
  const staleVersions = [];
  for (const [version, keys] of versionKeys.entries()) {
    if (keep.has(version)) continue;
    staleVersions.push(version);
    staleKeys.push(...keys);
  }

  let keysDeleted = 0;
  for (let start = 0; start < staleKeys.length; start += 200) {
    const batch = staleKeys.slice(start, start + 200);
    if (!batch.length) continue;
    keysDeleted += Number(await redisCommand(['DEL', ...batch]) || 0);
  }

  return {
    versionsPruned: staleVersions.length,
    keysDeleted,
    bytesFreed: null,
    keptVersions: [...keep],
    activeVersion: active,
  };
}

async function compactRecords({ maxRecords = 8, force = false } = {}) {
  const previousRaw = await redisCommand(['GET', 'mlbhr:storage:maintenance']);
  const previous = previousRaw ? JSON.parse(previousRaw) : null;
  const healthyTarget = Number(process.env.REDIS_CAPACITY_BYTES || 268435456) * 0.75;
  if (!force && previous && previous.storedStringBytesAfter < healthyTarget
      && Date.now() - Date.parse(previous.checkedAt) < 86400000) {
    // New captures already use compression. Once there is ample headroom,
    // a daily inventory avoids spending commands on every scheduler retry.
    return { ...previous, status: 'recently_compacted' };
  }
  const statePrune = await pruneStaleTriplesState({ keepVersions: 3 });
  if (statePrune.keysDeleted > 0) {
    const capacity = await require('./storage-health').storageSummary({ probeWrites: true });
    const result = {
      status: 'compacted',
      recordsCompacted: 0,
      bytesSaved: 0,
      recordsArchived: 0,
      bytesArchived: 0,
      rejectedWrites: 0,
      triplesStatePrune: statePrune,
      capacity,
      preservedAllRecords: true,
      checkedAt: new Date().toISOString(),
    };
    try {
      await redisCommand(['SET', 'mlbhr:storage:maintenance', JSON.stringify(result), 'EX', 604800]);
    } catch {}
    return result;
  }
  const audit = await storageAudit();
  let recordsCompacted = 0;
  let bytesSaved = 0;
  let rejectedWrites = 0;
  let examined = 0;
  let recordsArchived = 0;
  let bytesArchived = 0;
  let rescueAttempted = false;
  for (const { key } of audit.largestRecords) {
    if (recordsCompacted >= maxRecords || examined >= 32) break;
    examined += 1;
    const original = await redisCommand(['GET', key], { raw: true });
    if (typeof original !== 'string') continue;
    const compressed = encodeRedisValue(key, original);
    if (compressed === original) continue;
    try {
      const replaced = await redisCommand(['EVAL', REPLACE_IF_UNCHANGED, 1, key, original, compressed]);
      if (Number(replaced) === 1) {
        recordsCompacted += 1;
        bytesSaved += Buffer.byteLength(original) - Buffer.byteLength(compressed);
      }
    } catch (error) {
      if (!/capacity quota exceeded/i.test(String(error.message || error))) throw error;
      rejectedWrites += 1;
      // Upstash also rejects shrinking SETs while over quota. Only release
      // exact duplicates of SHA-verified, deployed permanent archive records.
      if (!rescueAttempted) {
        rescueAttempted = true;
        const rescued = await releaseArchivedDuplicates();
        recordsArchived += rescued.recordsArchived;
        bytesArchived += rescued.bytesArchived;
        if (rescued.recordsArchived) continue;
      }
      break;
    }
  }
  const result = {
    status: recordsCompacted || recordsArchived || statePrune.keysDeleted ? 'compacted' : rejectedWrites ? 'capacity_blocked' : 'unchanged',
    recordsCompacted, bytesSaved, recordsArchived, bytesArchived, rejectedWrites,
    triplesStatePrune: statePrune,
    storedStringBytesBefore: audit.storedStringBytes,
    storedStringBytesAfter: audit.storedStringBytes - bytesSaved - bytesArchived,
    preservedAllRecords: true,
    checkedAt: new Date().toISOString(),
  };
  try {
    await redisCommand(['SET', 'mlbhr:storage:maintenance', JSON.stringify(result), 'EX', 604800]);
  } catch { /* Diagnostics must not interfere with archive delivery. */ }
  return result;
}

let inFlight;
function maintainStorage(options) {
  const work = require('./object-archive').archiveConfig().mode === 'off'
    ? compactRecords : require('./archive-migration').migrateBatch;
  if (!inFlight) inFlight = work(options).finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { maintainStorage, REPLACE_IF_UNCHANGED, releaseArchivedDuplicates, pruneStaleTriplesState };
