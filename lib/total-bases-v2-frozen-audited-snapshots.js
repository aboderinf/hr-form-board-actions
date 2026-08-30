const AUDIT_SOURCE = 'audited-archived-0817-reconstruction';

const FROZEN_RULE = Object.freeze({
  checkpoint: '0817',
  alpha: 0.75,
  minEdge: 0,
  topN: 3,
  maxOdds: 175,
});

function auditMetadata(oddsAsOf, supersedes) {
  return Object.freeze({
    status: 'verified',
    auditedAt: '2026-08-30T19:07:55.000Z',
    oddsAsOf,
    method: 'Replayed the frozen rule against the archived 8:17 AM O1.5 odds and leakage-safe pregame v2 probabilities.',
    supersedes,
  });
}

function selection({
  batterId, batterName, matchup, gameStartAt, odds, book,
  formProbability, v2Probability, executionProbability, edge, ev,
}) {
  return Object.freeze({
    batterId,
    batterName,
    matchup,
    gameStartAt,
    odds,
    book,
    formProbability,
    v2Probability,
    executionProbability,
    edge,
    ev,
  });
}

const AUDITED_SELECTION_SNAPSHOTS = Object.freeze({
  '2026-08-26': Object.freeze({
    schemaVersion: 1,
    kind: 'frozen_total_bases_selection_snapshot',
    date: '2026-08-26',
    checkpoint: '0817',
    source: AUDIT_SOURCE,
    capturedAt: '2026-08-26T12:17:00.000Z',
    rule: FROZEN_RULE,
    audit: auditMetadata('2026-08-26T12:17:00.000Z', Object.freeze({
      source: 'original-live-endpoint-observation',
      capturedAt: '2026-08-26T00:10:42.266Z',
      reason: 'The original observation preceded the slate-day 8:17 AM checkpoint.',
    })),
    selections: Object.freeze([
      selection({
        batterId: 645277, batterName: 'Ozzie Albies', matchup: 'LAD @ ATL',
        gameStartAt: '2026-08-26T23:15:00.000Z', odds: 171, book: 'draftkings',
        formProbability: 0.3546, v2Probability: 0.42601319509896324,
        executionProbability: 0.4082, edge: 0.0392, ev: 0.1061,
      }),
      selection({
        batterId: 696285, batterName: 'Jacob Young', matchup: 'COL @ WSH',
        gameStartAt: '2026-08-26T22:45:00.000Z', odds: 172, book: 'draftkings',
        formProbability: 0.3273, v2Probability: 0.42601319509896324,
        executionProbability: 0.4013, edge: 0.0337, ev: 0.0916,
      }),
      selection({
        batterId: 545361, batterName: 'Mike Trout', matchup: 'CLE @ LAA',
        gameStartAt: '2026-08-26T20:07:00.000Z', odds: 167, book: 'draftkings',
        formProbability: 0.3515, v2Probability: 0.42601319509896324,
        executionProbability: 0.4074, edge: 0.0329, ev: 0.0877,
      }),
    ]),
  }),
  '2026-08-27': Object.freeze({
    schemaVersion: 1,
    kind: 'frozen_total_bases_selection_snapshot',
    date: '2026-08-27',
    checkpoint: '0817',
    source: AUDIT_SOURCE,
    capturedAt: '2026-08-27T12:17:00.000Z',
    rule: FROZEN_RULE,
    audit: auditMetadata('2026-08-27T12:17:00.000Z', Object.freeze({
      source: 'live-frozen-endpoint',
      capturedAt: '2026-08-27T23:32:14.894Z',
      reason: 'The saved snapshot was created after the first game on the slate had started.',
    })),
    selections: Object.freeze([
      selection({
        batterId: 621566, batterName: 'Matt Olson', matchup: 'LAD @ ATL',
        gameStartAt: '2026-08-27T23:15:00.000Z', odds: 166, book: 'draftkings',
        formProbability: 0.3526, v2Probability: 0.42601319509896324,
        executionProbability: 0.4077, edge: 0.0317, ev: 0.0844,
      }),
      selection({
        batterId: 676475, batterName: 'Alec Burleson', matchup: 'BAL @ STL',
        gameStartAt: '2026-08-27T18:15:00.000Z', odds: 155, book: 'draftkings',
        formProbability: 0.3292, v2Probability: 0.42601319509896324,
        executionProbability: 0.4018, edge: 0.0097, ev: 0.0246,
      }),
      selection({
        batterId: 646240, batterName: 'Rafael Devers', matchup: 'ARI @ SF',
        gameStartAt: '2026-08-28T01:45:00.000Z', odds: 130, book: 'draftkings',
        formProbability: 0.3744, v2Probability: 0.46367851622874817,
        executionProbability: 0.4414, edge: 0.0066, ev: 0.0151,
      }),
    ]),
  }),
});

function auditedSelectionSnapshot(date) {
  return AUDITED_SELECTION_SNAPSHOTS[String(date || '')] || null;
}

async function resolveSelectionSnapshot(date, readPersistedSnapshot) {
  const audited = auditedSelectionSnapshot(date);
  if (audited) return audited;
  if (typeof readPersistedSnapshot !== 'function') return null;
  try {
    return await readPersistedSnapshot(String(date || '')) || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  AUDIT_SOURCE,
  AUDITED_SELECTION_SNAPSHOTS,
  auditedSelectionSnapshot,
  resolveSelectionSnapshot,
};
