const { digest, cacheSeconds, isRecordKey, isLeaseKey } = require('./object-archive');

// Values crossing this boundary are exact Redis wire strings, including the
// existing lossless codec. Both runtimes use the same archive and CAS leases.
function createArchiveStore({ redis, archive, mode, now = () => Date.now(), warn = console.warn }) {
  let cutoverChecked = false;
  async function ready() {
    if (mode !== 'active' || cutoverChecked) return;
    if (!(await archive.readControl('migration-mirror'))?.completedAt) {
      throw new Error('Active archive requires a completed, verified mirror migration');
    }
    cutoverChecked = true;
  }
  async function cache(key, value, options = []) {
    if (mode === 'mirror') return redis(['SET', key, value, ...options]);
    const ttl = cacheSeconds(key, value, now());
    if (ttl > 0) return redis(['SET', key, value, 'EX', ttl]);
    // Historical reads must not refill Redis. Migration safely expires any
    // remaining old copies after verifying their permanent archive versions.
    return null;
  }
  async function bestEffortCache(key, value, options) {
    try { await cache(key, value, options); }
    catch (error) { warn('Archive saved; Redis cache unavailable:', String(error.message || error)); }
  }
  async function command(input) {
    const [operation, key, value, ...options] = input;
    const op = String(operation).toUpperCase();
    if (isLeaseKey(key)) {
      await ready();
      if (op === 'GET') return await archive.readLease(key) ?? (mode === 'mirror' ? redis(input) : null);
      if (op === 'SET') {
        const ex = options.findIndex((part) => String(part).toUpperCase() === 'EX');
        const seconds = Number(options[ex + 1]);
        if (!options.includes('NX') || ex < 0 || !Number.isFinite(seconds) || seconds <= 0) throw new Error('Lease requires NX and a positive EX');
        if (!await archive.acquireLease(key, String(value), seconds)) return null;
        if (mode === 'mirror') {
          // Bridge the rolling deployment: old functions still use Redis
          // leases, while both new modes contend on the archive lease.
          try {
            const legacy = await redis(input);
            if (legacy === 'OK') return 'OK';
            await archive.releaseLease(key, String(value));
            return null;
          } catch (error) {
            await archive.releaseLease(key, String(value));
            throw error;
          }
        }
        return 'OK';
      }
      if (op === 'RELEASE') {
        const released = Number(await archive.releaseLease(key, String(value)));
        if (mode === 'mirror') await redis(['EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, key, value]);
        return released;
      }
      throw new Error('Lease deletion requires an owner token');
    }
    if (!isRecordKey(key) || !['GET', 'SET'].includes(op)) return redis(input);
    if (op === 'GET') {
      let head;
      try { head = await archive.head(key); }
      catch (error) {
        // Retain recent read availability during an archive service outage.
        // Never report a missing record when both storage systems failed.
        const recent = await redis(input);
        if (recent == null) throw error;
        warn('Serving recent cache while archive is unavailable:', String(error.message || error));
        return recent;
      }
      if (!head) {
        if (mode === 'active') { await ready(); return null; }
        return redis(input);
      }
      let recent = null;
      if (mode !== 'active' || cacheSeconds(key, '', now()) > 0) {
        try { recent = await redis(input); } catch { /* Verified archive is authoritative. */ }
      }
      if (typeof recent === 'string' && digest(recent) === head.sha256) return recent;
      const archived = await archive.readVersion(key, head.sha256);
      // Mirroring does not change existing retention or rehydrate old records.
      if (mode === 'active') await bestEffortCache(key, archived);
      return archived;
    }
    await ready();
    const nx = options.some((part) => String(part).toUpperCase() === 'NX');
    // Before the migration finishes, SET NX must also respect pre-existing
    // frozen selections in Redis that have not reached the archive yet.
    if (nx && mode === 'mirror' && !await archive.head(key)) {
      const existing = await redis(['GET', key]);
      if (existing != null) {
        await archive.write(key, String(existing), { onlyIfAbsent: true });
        return null;
      }
    }
    const saved = await archive.write(key, String(value), { onlyIfAbsent: nx });
    if (!saved.written) return null;
    // A concurrent newer pointer must never be hidden by an older Redis value:
    // GET compares the cache checksum with the current archive pointer.
    await bestEffortCache(key, String(value), options);
    return 'OK';
  }
  return { command, ready };
}

module.exports = { createArchiveStore };
