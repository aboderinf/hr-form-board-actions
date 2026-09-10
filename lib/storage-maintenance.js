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
    const released = await redisCommand(['EVAL', RELEASE_VERIFIED_DUPLICATE, 1, key, original]);
    if (Number(released) === 1) {
      recordsArchived += 1;
      bytesArchived += Buffer.byteLength(original);
    }
  }
  return { recordsArchived, bytesArchived };
}

async function compactRecords({ maxRecords = 8 } = {}) {
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
    status: recordsCompacted || recordsArchived ? 'compacted' : rejectedWrites ? 'capacity_blocked' : 'unchanged',
    recordsCompacted, bytesSaved, recordsArchived, bytesArchived, rejectedWrites,
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
  if (!inFlight) inFlight = compactRecords(options).finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { maintainStorage, REPLACE_IF_UNCHANGED, releaseArchivedDuplicates };
