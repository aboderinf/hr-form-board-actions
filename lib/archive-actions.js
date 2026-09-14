const { archiveConfig, getArchive, isRecordKey, isLeaseKey } = require('./object-archive');

// These actions are dispatched only AFTER the existing checkpoint HMAC check.
// The model gateway cannot read credentials or run arbitrary Redis commands.
async function handleArchiveAction(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (!getArchive()) return response.status(503).json({ error: 'Archive is not enabled' });
    const action = String(request.query.action);
    if (action === 'archive-migrate') {
      const result = await require('./archive-migration').migrateBatch({ maxRecords: request.body?.maxRecords });
      const { pending, ...summary } = result;
      return response.status(200).json({ result: { ...summary, pendingRecords: pending?.length || 0 } });
    }
    if (action === 'archive-record') {
      const command = request.body?.command;
      if (!Array.isArray(command) || command.length < 2 || command.length > 7) throw new Error('Invalid archive command');
      const [op, key, value, ...options] = command;
      const record = isRecordKey(key) && String(key).startsWith('mlbhr:triples-model:');
      const lease = isLeaseKey(key) && String(key).startsWith('mlbhr:triples-model:lock:');
      const validGet = op === 'GET' && command.length === 2;
      const validRelease = op === 'RELEASE' && lease && command.length === 3 && typeof value === 'string';
      const validSet = op === 'SET' && typeof value === 'string' && Buffer.byteLength(value) <= 3000000
        && (JSON.stringify(options) === '["EX",34560000]' || (lease && options[0] === 'NX' && options[1] === 'EX' && options.length === 3 && Number(options[2]) > 0 && Number(options[2]) <= 600));
      if (!(record || lease) || !(validGet || validRelease || validSet)) throw new Error('Unsupported archive command');
      const result = await require('./checkpoint-runtime').redisCommand(command);
      return response.status(200).json({ result });
    }
    return response.status(400).json({ error: 'Unknown archive action' });
  } catch (error) {
    return response.status(503).json({ error: String(error.message || error), archiveMode: archiveConfig().mode });
  }
}

module.exports = { handleArchiveAction };
