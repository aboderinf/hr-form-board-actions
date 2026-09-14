const { randomUUID } = require('node:crypto');
const { archiveConfig, getArchive } = require('./object-archive');

async function archiveHealth({ checkCaptures = false, now = new Date() } = {}) {
  const config = archiveConfig();
  const result = { mode: config.mode, configured: config.configured, hotDays: config.hotDays,
    status: config.mode === 'off' ? 'awaiting_setup' : 'checking', writable: false,
    checkedAt: now.toISOString(), alerts: [] };
  if (config.mode === 'off') return result;
  try {
    const archive = getArchive();
    let probe = await archive.readControl('health-probe');
    if (!probe || now.getTime() - Date.parse(probe.checkedAt) > 900000) {
      const key = `mlb-archive/v1/control/probe/${randomUUID()}`;
      const expected = Buffer.from(randomUUID());
      await archive.transport.put(key, expected, { absent: true });
      const copy = await archive.transport.get(key);
      if (!copy?.body.equals(expected)) throw new Error('Archive health read-back failed');
      await archive.transport.remove(key);
      probe = { checkedAt: now.toISOString(), writable: true };
      await archive.writeControl('health-probe', probe);
    }
    result.writable = probe.writable === true;
    result.lastVerifiedWriteAt = probe.checkedAt;
    const migration = await archive.readControl(`migration-${config.mode}`);
    const { pending, ...progress } = migration || {};
    result.migration = { ...progress, pendingRecords: pending?.length || 0 };
    if (config.mode === 'active' && !(await archive.readControl('migration-mirror'))?.completedAt) {
      result.alerts.push('Archive retention is blocked: mirror migration is incomplete');
    }
    if (migration?.status === 'blocked') result.alerts.push('Archive migration is blocked');
    if (!migration?.checkedAt || now.getTime() - Date.parse(migration.checkedAt) > 2 * 86400000) {
      result.alerts.push('Archive maintenance has not completed a recent check');
    }
    result.status = result.alerts.length ? 'attention_required' : 'ready';
    if (checkCaptures) {
      const { currentEtDate, checkpointTargetUtc, readRawArchive } = require('./checkpoint-runtime');
      const date = currentEtDate(now);
      result.captures = await Promise.all(['0817', '1117', '1717', '2017'].map(async (checkpoint) => {
        const targetAt = checkpointTargetUtc(date, checkpoint);
        if (now.getTime() < targetAt.getTime() + 15 * 60000) return { date, checkpoint, status: 'not_due' };
        try {
          const stored = await readRawArchive(date, checkpoint);
          if (!stored) {
            result.alerts.push(`Missing shared capture ${date} ${checkpoint}; affects HR, strikeouts, 2+ bases and triples`);
            return { date, checkpoint, status: 'missing' };
          }
          return { date, checkpoint, status: 'saved', completedAt: stored.archive.completedAt,
            responseSha256: stored.archive.responseSha256 };
        } catch (error) {
          result.alerts.push(`Capture ${date} ${checkpoint} could not be read`);
          return { date, checkpoint, status: 'unavailable', error: String(error.message || error) };
        }
      }));
      let capacity = await archive.readControl('capacity-audit');
      if (!capacity || now.getTime() - Date.parse(capacity.checkedAt) > 12 * 3600000) {
        const audit = await require('./storage-health').storageAudit();
        capacity = { checkedAt: now.toISOString(), storedStringBytes: audit.storedStringBytes,
          limitBytes: audit.limitBytes, complete: audit.complete,
          measure: 'stored string bytes; excludes key and database overhead' };
        await archive.writeControl('capacity-audit', capacity);
      }
      const ratio = capacity.storedStringBytes / capacity.limitBytes;
      result.cacheCapacity = { ...capacity, ratio, warningAt: 0.70, criticalAt: 0.85 };
      if (ratio >= 0.85) result.alerts.push('Redis stored values exceed the 85% critical threshold');
      else if (ratio >= 0.70) result.alerts.push('Redis stored values exceed the 70% warning threshold');
    }
  } catch (error) {
    result.error = String(error.message || error);
    result.alerts.push('Archive health verification failed');
  }
  if (result.alerts.length) result.status = 'attention_required';
  return result;
}

module.exports = { archiveHealth };
