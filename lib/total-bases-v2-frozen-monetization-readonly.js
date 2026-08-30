const { redisCommand } = require('./checkpoint-runtime');
const totalBasesV2Handler = require('./total-bases-v2-handler');
const { resolveSelectionSnapshot } = require('./total-bases-v2-frozen-audited-snapshots');

const MLB = 'https://statsapi.mlb.com/api/v1';
const FORWARD_START = '2026-08-26';

const FROZEN_RULE = Object.freeze({
  checkpoint: '0817', alpha: 0.75, minEdge: 0, topN: 3, maxOdds: 175,
});

const FROZEN_CALIBRATION = Object.freeze({
  early: {
    bets: 15, slates: 5, wins: 10, losses: 5, hitRate: 0.6667,
    averageOdds: 150.2, averageProbability: 0.4265595931310935,
    averageEdge: 0.02380401918808221, averageEv: 0.060102474431566306,
    averageContextLift: 0.08044252393953363,
    netUnits: 9.84, roi: 0.656, profitableSlates: 4, maxPositiveDayShare: 0.4093,
  },
  late: {
    bets: 13, slates: 5, wins: 8, losses: 5, hitRate: 0.6154,
    averageOdds: 153, averageProbability: 0.42501946010405867,
    averageEdge: 0.02831275922333106, averageEv: 0.0705527376112447,
    averageContextLift: 0.06710506492161655,
    netUnits: 7.4, roi: 0.5692, profitableSlates: 3, maxPositiveDayShare: 0.5017,
  },
  full: {
    bets: 28, slates: 10, wins: 18, losses: 10, hitRate: 0.6429,
    averageOdds: 151.5, averageProbability: 0.42584453136854167,
    averageEdge: 0.025897362775876318, averageEv: 0.06495438233641697,
    averageContextLift: 0.07425013225264356,
    netUnits: 17.24, roi: 0.6157, profitableSlates: 7, maxPositiveDayShare: 0.2335,
  },
});

const FROZEN_HOLDOUT = Object.freeze({
  through: '2026-08-25', bets: 27, slates: 9, wins: 13, losses: 14, hitRate: 0.4815,
  averageOdds: 151.96296296296296, averageProbability: 0.4323345827588376,
  averageEdge: 0.033317732945370375, averageEv: 0.08360362360115922,
  averageContextLift: 0.07994223954312328,
  netUnits: 5.38, roi: 0.1993, profitableSlates: 6, maxPositiveDayShare: 0.3185,
});

function etDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(iso, days) {
  const value = new Date(`${iso}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const out = [];
  if (!start || !end || start > end) return out;
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) out.push(cursor);
  return out;
}

function captureResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    setHeader() { return response; },
    status(code) { statusCode = Number(code); return response; },
    json(payload) { body = payload; return payload; },
    end() { return undefined; },
  };
  return { response, result: () => ({ statusCode, body }) };
}

async function v2Output(request, date) {
  const captured = captureResponse();
  const modelRequest = {
    method: 'GET',
    headers: request.headers || {},
    query: { ...(request.query || {}), date, checkpoint: FROZEN_RULE.checkpoint },
  };
  await totalBasesV2Handler(modelRequest, captured.response);
  return captured.result();
}

function clampProbability(value) {
  return Math.max(0.01, Math.min(0.80, Number(value)));
}

function impliedProbability(americanOdds) {
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : (-odds) / ((-odds) + 100);
}

function winProfit(americanOdds) {
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function expectedValue(probability, americanOdds) {
  const win = winProfit(americanOdds);
  return win == null ? null : Number(probability) * win - (1 - Number(probability));
}

function liveSelect(v2Rows) {
  return (v2Rows || []).map((row) => {
    const v2Probability = Number(row.v2Probability ?? row.modelProbability);
    const formProbability = Number(row.formProbability);
    const odds = Number(row.bestOver?.americanOdds);
    const implied = impliedProbability(odds);
    const monetizedProbability = clampProbability(formProbability + FROZEN_RULE.alpha * (v2Probability - formProbability));
    const monetizedEdge = implied == null ? null : monetizedProbability - implied;
    const monetizedEv = expectedValue(monetizedProbability, odds);
    return {
      ...row,
      odds,
      contextLift: v2Probability - formProbability,
      monetizedProbability: Number(monetizedProbability.toFixed(4)),
      monetizedEdge: monetizedEdge == null ? null : Number(monetizedEdge.toFixed(4)),
      monetizedEv: monetizedEv == null ? null : Number(monetizedEv.toFixed(4)),
    };
  }).filter((row) => Number.isFinite(row.odds) && row.odds <= FROZEN_RULE.maxOdds)
    .filter((row) => Number(row.monetizedEdge) >= FROZEN_RULE.minEdge && Number(row.monetizedEv) > 0)
    .sort((a, b) => Number(b.monetizedEv) - Number(a.monetizedEv) || Number(b.monetizedEdge) - Number(a.monetizedEdge))
    .slice(0, FROZEN_RULE.topN);
}

function snapshotKey(date) {
  return `mlbtb2:frozen-selections:${date}:0817`;
}

async function readSelectionSnapshot(date) {
  return resolveSelectionSnapshot(date, async () => {
    const raw = await redisCommand(['GET', snapshotKey(date)]);
    return raw ? JSON.parse(raw) : null;
  });
}

async function fetchJson(url, timeout = 20000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MLBTotalBasesFrozenTracker/2.0' },
    cache: 'no-store', signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`MLB Stats API HTTP ${response.status}`);
  return response.json();
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function extractGameLog(person) {
  for (const stat of person?.stats || []) if (Array.isArray(stat?.splits)) return stat.splits;
  return [];
}

async function bulkGameLogs(ids, season) {
  const unique = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  const output = new Map();
  await Promise.all(chunks(unique, 30).map(async (group) => {
    const params = new URLSearchParams({ personIds: group.join(','), hydrate: `stats(group=[hitting],type=[gameLog],season=${season})` });
    const payload = await fetchJson(`${MLB}/people?${params.toString()}`, 25000);
    for (const person of payload?.people || []) {
      const id = Number(person?.id);
      if (Number.isFinite(id)) output.set(id, extractGameLog(person));
    }
  }));
  return output;
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function totalBases(stat) {
  if (stat?.totalBases != null && Number.isFinite(Number(stat.totalBases))) return Number(stat.totalBases);
  const hits = number(stat?.hits), doubles = number(stat?.doubles), triples = number(stat?.triples), homeRuns = number(stat?.homeRuns);
  return Math.max(0, hits - doubles - triples - homeRuns) + 2 * doubles + 3 * triples + 4 * homeRuns;
}

function settledAppearance(logs, slateDate) {
  const appearances = (logs || []).filter((split) => String(split?.date || '') === slateDate)
    .filter((split) => Number(split?.stat?.plateAppearances || 0) > 0)
    .map((split) => ({ totalBases: totalBases(split?.stat || {}), gamePk: Number(split?.game?.gamePk || split?.gamePk || 0) || null }));
  if (appearances.length === 0) return { status: 'void' };
  if (appearances.length > 1) return { status: 'ambiguous' };
  return { status: 'graded', ...appearances[0] };
}

function gradeSelection(selection, date, gameLogs) {
  const appearance = settledAppearance(gameLogs.get(Number(selection.batterId)) || [], date);
  if (appearance.status === 'void') return { ...selection, result: 'void', actualTb: null, pnlUnits: 0 };
  if (appearance.status === 'ambiguous') return { ...selection, result: 'ambiguous', actualTb: null, pnlUnits: 0 };
  const hit = Number(appearance.totalBases) >= 2;
  return { ...selection, result: hit ? 'win' : 'loss', actualTb: appearance.totalBases, pnlUnits: Number((hit ? winProfit(selection.odds) : -1).toFixed(3)), gamePk: appearance.gamePk };
}

function summarizeSelections(selections) {
  const graded = selections.filter((row) => row.result === 'win' || row.result === 'loss');
  const bets = graded.length, wins = graded.filter((row) => row.result === 'win').length;
  const netUnits = graded.reduce((sum, row) => sum + Number(row.pnlUnits || 0), 0);
  return {
    bets, wins, losses: bets - wins,
    voids: selections.filter((row) => row.result === 'void').length,
    ambiguous: selections.filter((row) => row.result === 'ambiguous').length,
    hitRate: bets ? Number((wins / bets).toFixed(4)) : null,
    netUnits: Number(netUnits.toFixed(3)), roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
  };
}

function summarizeDays(days) {
  const usable = (days || []).filter((day) => ['settled', 'partial'].includes(day.status));
  const bettingDays = usable.filter((day) => day.bets > 0);
  const bets = usable.reduce((s, d) => s + d.bets, 0), wins = usable.reduce((s, d) => s + d.wins, 0);
  const netUnits = usable.reduce((s, d) => s + d.netUnits, 0);
  return {
    calendarDays: usable.length, slates: bettingDays.length, bets, wins, losses: bets - wins,
    voids: usable.reduce((s, d) => s + Number(d.voids || 0), 0),
    hitRate: bets ? Number((wins / bets).toFixed(4)) : null,
    netUnits: Number(netUnits.toFixed(3)), roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
    profitableSlates: bettingDays.filter((d) => d.netUnits > 0).length,
    losingSlates: bettingDays.filter((d) => d.netUnits < 0).length,
    flatSlates: bettingDays.filter((d) => d.netUnits === 0).length,
  };
}

function recentDays(days, n) {
  if (!days.length) return [];
  const end = days.at(-1).date, start = addDays(end, -(n - 1));
  return days.filter((day) => day.date >= start && day.date <= end);
}

async function forwardPerformance(through) {
  const dates = dateRange(FORWARD_START, through);
  const snapshots = await Promise.all(dates.map(async (date) => ({ date, snapshot: await readSelectionSnapshot(date) })));
  const ids = snapshots.flatMap(({ snapshot }) => (snapshot?.selections || []).map((row) => Number(row.batterId))).filter(Number.isFinite);
  let gameLogs = new Map();
  try { gameLogs = await bulkGameLogs(ids, Number(through.slice(0, 4))); } catch (_) {}

  let cumulativeBets = 0, cumulativeWins = 0, cumulativeNet = 0;
  const daily = snapshots.map(({ date, snapshot }) => {
    if (!snapshot) {
      return {
        date, status: 'snapshot_unavailable', bets: 0, wins: 0, losses: 0, voids: 0, netUnits: 0, roi: null, selections: [],
        cumulative: { bets: cumulativeBets, wins: cumulativeWins, losses: cumulativeBets - cumulativeWins, netUnits: Number(cumulativeNet.toFixed(3)), roi: cumulativeBets ? Number((cumulativeNet / cumulativeBets).toFixed(4)) : null },
      };
    }
    const selections = (snapshot.selections || []).map((selection) => gradeSelection(selection, date, gameLogs));
    const summary = summarizeSelections(selections);
    cumulativeBets += summary.bets; cumulativeWins += summary.wins; cumulativeNet += summary.netUnits;
    return {
      date, status: summary.ambiguous > 0 ? 'partial' : 'settled', ...summary,
      positive: summary.bets ? summary.netUnits > 0 : null,
      selections, snapshotSource: snapshot.source || null, capturedAt: snapshot.capturedAt || null,
      snapshotAuditStatus: snapshot.audit?.status || null,
      cumulative: { bets: cumulativeBets, wins: cumulativeWins, losses: cumulativeBets - cumulativeWins, netUnits: Number(cumulativeNet.toFixed(3)), roi: cumulativeBets ? Number((cumulativeNet / cumulativeBets).toFixed(4)) : null },
    };
  });

  const allForward = summarizeDays(daily);
  const overallBets = FROZEN_HOLDOUT.bets + allForward.bets;
  const overallWins = FROZEN_HOLDOUT.wins + allForward.wins;
  const overallNet = FROZEN_HOLDOUT.netUnits + allForward.netUnits;
  return {
    start: FORWARD_START, through, daily,
    periods: { last7Days: summarizeDays(recentDays(daily, 7)), last14Days: summarizeDays(recentDays(daily, 14)), allForward },
    overallOutOfSample: {
      bets: overallBets, wins: overallWins, losses: overallBets - overallWins, voids: allForward.voids,
      slates: FROZEN_HOLDOUT.slates + allForward.slates,
      profitableSlates: FROZEN_HOLDOUT.profitableSlates + allForward.profitableSlates,
      netUnits: Number(overallNet.toFixed(3)), roi: overallBets ? Number((overallNet / overallBets).toFixed(4)) : null,
      includes: 'Frozen Aug 17-25 holdout + Aug 26 onward forward results. Calibration excluded.',
    },
  };
}

function snapshotSummary(snapshot) {
  if (!snapshot) return { status: 'missing', selections: null, capturedAt: null, source: null, auditStatus: null };
  return {
    status: 'saved',
    selections: Array.isArray(snapshot.selections) ? snapshot.selections.length : 0,
    capturedAt: snapshot.capturedAt || null,
    source: snapshot.source || null,
    auditStatus: snapshot.audit?.status || null,
  };
}

module.exports = async function totalBasesFrozenReadonlyHandler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const date = String(request.query?.date || etDate());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return response.status(400).json({ status: 'error', message: 'Invalid date' });
    const ledgerThrough = String(request.query?.ledgerThrough || addDays(etDate(), -1));
    const modelResult = await v2Output(request, date);
    const v2 = modelResult.statusCode === 200 ? modelResult.body : null;
    if (!v2) return response.status(modelResult.statusCode || 503).json({ status: 'error', message: 'V2 model output unavailable', providerRequests: 0, quotaObjectsAdded: 0 });

    const probabilityPass = Boolean(v2?.validation?.probabilityPass);
    const promoted = probabilityPass;
    const rows = liveSelect(v2.rows || []).map((row) => ({ ...row, qualifies: promoted, researchOnly: !promoted }));
    const [forward, selectionSnapshot] = await Promise.all([
      forwardPerformance(ledgerThrough),
      readSelectionSnapshot(date),
    ]);

    const output = {
      schemaVersion: 5,
      kind: 'batter_two_plus_total_bases_v2_frozen_monetization',
      status: 'ready', generatedAt: new Date().toISOString(), date,
      checkpoint: FROZEN_RULE.checkpoint, ledgerThrough,
      providerRequests: 0, quotaObjectsAdded: 0,
      promoted, monetizationStatus: promoted ? 'PROMOTED_FROZEN' : 'HELD_MODEL_GATE',
      frozen: true, frozenAt: '2026-08-26', readOnlyLedger: true,
      methodology: {
        probability: 'Execution probability is fixed at 25% form baseline plus 75% of the v2 context-adjusted probability.',
        execution: 'Only the 8:17 AM checkpoint is eligible. Best O1.5 price must be +175 or shorter with positive conservative EV; at most three selections per slate.',
        forwardTracking: 'The checkpoint workflow writes daily selection snapshots. A versioned audit correction may supersede an invalid save only by replaying the frozen rule from the exact archived 8:17 checkpoint. This public endpoint reads the authoritative result and grades it through the latest completed ET day.',
      },
      split: { archiveStart: '2026-08-02', holdoutStart: '2026-08-17', holdoutThrough: FROZEN_HOLDOUT.through, forwardStart: FORWARD_START },
      rule: { ...FROZEN_RULE, label: '0817 · context weight 75% · edge >= 0.0% · top 3/slate · odds <= +175', contextWeight: 0.75, formWeight: 0.25 },
      calibration: { ...FROZEN_CALIBRATION, candidatesTested: 1280, note: 'Frozen validation snapshot.' },
      holdout: FROZEN_HOLDOUT,
      forward,
      selectionSnapshot: snapshotSummary(selectionSnapshot),
      gates: { probabilityPass, holdoutPass: true, promotionRequires: 'current v2 probability gate + frozen Aug 17-25 execution holdout pass' },
      rows,
      model: { modelStatus: v2.modelStatus, validation: v2.validation },
    };

    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({ status: 'error', providerRequests: 0, quotaObjectsAdded: 0, message: error instanceof Error ? error.message : String(error) });
  }
};
