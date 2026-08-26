const { normalizeCheckpoint } = require('../lib/checkpoint-runtime');
const { readStrikeoutsCheckpoint } = require('../lib/strikeouts-runtime');
const { readTotalBasesCheckpoint } = require('../lib/total-bases-runtime');
const totalBasesDiscoveryHandler = require('../lib/total-bases-discovery-handler');
const totalBasesModelHandler = require('../lib/total-bases-model-safe-handler');
const totalBasesV2Handler = require('../lib/total-bases-v2-handler');

module.exports = async function handler(request, response) {
  const market = String(request.query?.market || '').toLowerCase();
  const mode = String(request.query?.mode || '').toLowerCase();
  if (market === 'total-bases-discovery') return totalBasesDiscoveryHandler(request, response);
  if (market === 'total-bases' && mode === 'model-v2') return totalBasesV2Handler(request, response);
  if (market === 'total-bases' && mode === 'model') return totalBasesModelHandler(request, response);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const date = String(request.query?.date || '');
  const checkpoint = normalizeCheckpoint(request.query?.checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checkpoint) {
    return response.status(400).json({ status: 'error', message: 'A valid date and checkpoint are required' });
  }

  const isTotalBases = market === 'total-bases';
  try {
    const payload = isTotalBases
      ? await readTotalBasesCheckpoint(date, checkpoint)
      : await readStrikeoutsCheckpoint(date, checkpoint);
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (!payload) {
      response.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=45');
      return response.status(404).json({
        status: 'pending', date, checkpoint,
        market: isTotalBases ? 'batter-total-bases-ou-1.5' : 'pitcher-strikeouts-ou',
        source: 'archived-sportsgameodds-events',
        delivery: 'existing-archive-readonly',
        providerRequests: 0,
        quotaObjectsAdded: 0,
      });
    }
    response.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    response.setHeader('X-Odds-Source', 'archived-sportsgameodds-events');
    response.setHeader('X-Quota-Objects-Added', '0');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(payload);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    return response.status(500).json({
      status: 'error', date, checkpoint,
      providerRequests: 0, quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

module.exports.config = { maxDuration: 60 };
