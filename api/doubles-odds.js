const { normalizeCheckpoint } = require('../lib/checkpoint-runtime');
const { readDoublesCheckpoint } = require('../lib/doubles-runtime');

module.exports = async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const date = String(request.query?.date || '');
  const checkpoint = normalizeCheckpoint(request.query?.checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checkpoint) {
    return response.status(400).json({ status: 'error', message: 'A valid date and checkpoint are required' });
  }

  try {
    const payload = await readDoublesCheckpoint(date, checkpoint);
    if (!payload) {
      response.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=45');
      return response.status(404).json({
        status: 'pending', date, checkpoint,
        source: 'archived-sportsgameodds-events',
        delivery: 'existing-archive-readonly',
        providerRequests: 0, quotaObjectsAdded: 0,
        message: 'The archived checkpoint is not available yet',
      });
    }
    response.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    response.setHeader('X-Odds-Source', 'archived-sportsgameodds-events');
    response.setHeader('X-Quota-Objects-Added', '0');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(payload);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({
      status: 'error', date, checkpoint, providerRequests: 0, quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
