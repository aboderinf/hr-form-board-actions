const { redisCommand } = require('./checkpoint-runtime');
const { storageAudit } = require('./storage-health');
const { encodeRedisValue } = require('./redis-value-codec');

// A rejected SET or a concurrent update leaves the original record intact.
// Never DEL before SET: Redis Lua errors do not roll back prior commands.
const REPLACE_IF_UNCHANGED = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1`;

async function compactRecords({ maxRecords = 8 } = {}) {
  const audit = await storageAudit();
  let recordsCompacted = 0;
  let bytesSaved = 0;
  let rejectedWrites = 0;
  let examined = 0;
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
      // The service rejects all growth operations while full. Stop safely.
      break;
    }
  }
  const result = {
    status: recordsCompacted ? 'compacted' : rejectedWrites ? 'capacity_blocked' : 'unchanged',
    recordsCompacted, bytesSaved, rejectedWrites,
    storedStringBytesBefore: audit.storedStringBytes,
    storedStringBytesAfter: audit.storedStringBytes - bytesSaved,
    preservedAllKeys: true,
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

module.exports = { maintainStorage, REPLACE_IF_UNCHANGED };
