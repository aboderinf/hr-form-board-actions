const { randomUUID } = require('node:crypto');
const { isRecordKey, cacheSeconds, archiveConfig, getArchive } = require('./object-archive');
const { readColdArchive, archivedKeys } = require('./storage-archive');

// Never shorten a concurrent writer's TTL and never delete a source record.
const EXPIRE_VERIFIED = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 or ttl > tonumber(ARGV[2]) then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 0`;

async function migrateBatch({ archive = getArchive(), redis = require('./checkpoint-runtime').redisRawCommand,
  mode = archiveConfig().mode, maxRecords = 16, budgetMs = 40000, now = () => Date.now() } = {}) {
  if (!archive || mode === 'off') return { status: 'archive_not_enabled', preservedAllRecords: true };
  if (mode === 'active' && !(await archive.readControl('migration-mirror'))?.completedAt) {
    throw new Error('Finish the verified mirror migration before activating retention');
  }
  const owner = randomUUID();
  if (!await archive.acquireLease('archive-maintenance', owner, 300)) return { status: 'migration_in_progress' };
  const started = now();
  const control = `migration-${mode}`;
  let state;
  try {
    state = await archive.readControl(control);
    if (state?.completedAt && (mode === 'mirror' || now() - Date.parse(state.completedAt) < 86400000)) return state;
    if (!state || state.completedAt) state = { schemaVersion: 1, mode, status: 'migrating',
      startedAt: new Date(now()).toISOString(), cursor: '0', scanDone: false,
      pending: archivedKeys(), verifiedRecords: 0, verifiedBytes: 0, expiredCopies: 0, missingSources: 0 };
    state.status = 'migrating';
    delete state.error;
    // Inventory only after old deployments have drained; otherwise a late
    // legacy writer could update a key after its migration page was scanned.
    if (mode === 'mirror' && now() - Date.parse(state.startedAt) < 600000) {
      state.status = 'awaiting_writer_drain';
      state.checkedAt = new Date(now()).toISOString();
      await archive.writeControl(control, state);
      return state;
    }
    let processed = 0;
    maxRecords = Math.max(1, Math.min(64, Number(maxRecords) || 16));
    while (processed < maxRecords && now() - started < budgetMs) {
      if (!state.pending.length) {
        if (state.scanDone) break;
        const page = await redis(['SCAN', state.cursor, 'MATCH', 'mlb*', 'COUNT', 64]);
        if (!Array.isArray(page) || !Array.isArray(page[1])) throw new Error('Invalid Redis migration scan');
        state.cursor = String(page[0]);
        state.scanDone = state.cursor === '0';
        state.pending = [...new Set(page[1].filter(isRecordKey))];
        // Checkpoint the page before processing: a timeout safely repeats it.
        await archive.writeControl(control, state);
        if (!state.pending.length) continue;
      }
      const key = state.pending[0];
      const original = await redis(['GET', key]);
      const value = original ?? readColdArchive(key);
      if (value != null) {
        // Import every exact source version; do not overwrite a newer pointer
        // published by an archive-first writer while SCAN was in progress.
        await archive.write(key, String(value), { onlyIfAbsent: true });
        if (mode === 'active' && original != null) {
          const ttl = Math.max(60, cacheSeconds(key, original, now()));
          state.expiredCopies += Number(await redis(['EVAL', EXPIRE_VERIFIED, 1, key, original, ttl])) || 0;
        }
        state.verifiedRecords += 1;
        state.verifiedBytes += Buffer.byteLength(String(value));
      } else {
        // A key can expire naturally between SCAN and GET. Do not invent it.
        state.missingSources += 1;
      }
      state.pending.shift();
      processed += 1;
      state.checkedAt = new Date(now()).toISOString();
      await archive.writeControl(control, state);
    }
    if (state.scanDone && !state.pending.length) {
      state.completedAt = new Date(now()).toISOString();
      state.status = 'complete';
    }
    state.checkedAt = new Date(now()).toISOString();
    await archive.writeControl(control, state);
    return state;
  } catch (error) {
    if (state) {
      state.status = 'blocked';
      state.error = String(error.message || error);
      state.checkedAt = new Date(now()).toISOString();
      await archive.writeControl(control, state);
    }
    throw error;
  } finally {
    await archive.releaseLease('archive-maintenance', owner);
  }
}

module.exports = { migrateBatch, EXPIRE_VERIFIED };
