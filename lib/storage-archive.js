const { createHash } = require('node:crypto');
const { decodeRedisValue } = require('./redis-value-codec');
const manifest = require('../data/storage-rescue-2026-09-10.json');
const verified = new Map();

// These immutable, previously public checkpoints are bundled with every
// deployment and retained in source history. Their normal API URLs still work
// when the redundant Redis copy is absent.
function readColdArchive(key) {
  const entry = manifest.records[key];
  if (!entry) return null;
  if (!verified.has(key)) {
    const original = decodeRedisValue(entry.value);
    if (createHash('sha256').update(original).digest('hex') !== entry.sha256) {
      throw new Error('Historical checkpoint backup integrity check failed');
    }
    verified.set(key, original);
  }
  return verified.get(key);
}

function archivedKeys() { return Object.keys(manifest.records); }

module.exports = { readColdArchive, archivedKeys };
