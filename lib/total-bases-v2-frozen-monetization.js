const { redisCommand } = require('./checkpoint-runtime');
const totalBasesV2Handler = require('./total-bases-v2-handler');
const { resolveSelectionSnapshot } = require('./total-bases-v2-frozen-audited-snapshots');

const MLB = 'https://statsapi.mlb.com/api/v1';
const FORWARD_START = '2026-08-26';
const SNAPSHOT_TTL_SECONDS = 34560000;

const FROZEN_RULE = Object.freeze({
  checkpoint: '0817',
  alpha: 0.75,
  minEdge: 0,
  topN: 3,
  maxOdds: 175,
});

const FROZEN_CALIBRATION = Object.freeze({
  early: {
    bets: 15, slates: 5, wins: 10, losses: 5, hitRate: 0.6667,
    averageOdds: 150.2, averageProbability: 0.4265595931310935,
    averageEdge: 0.02380401918808221, averageEv: 0.060102474431566306,
    averageContextLift: 0.08044252393953363,
    netUnits: 9.84, roi: 0.656, profitableSlates: 4,
    maxPositiveDayShare: 0.4093,
  },
  late: {
    bets: 13, slates: 5, wins: 8, losses: 5, hitRate: 0.6154,
    averageOdds: 153, averageProbability: 0.42501946010405867,
    averageEdge: 0.02831275922333106, averageEv: 0.0705527376112447,
    averageContextLift: 0.06710506492161655,
    netUnits: 7.4, roi: 0.5692, profitableSlates: 3,
    maxPositiveDayShare: 0.5017,
  },
  full: {
    bets: 28, slates: 10, wins: 18, losses: 10, hitRate: 0.6429,
    averageOdds: 151.5, averageProbability: 0.42584453136854167,
    averageEdge: 0.025897362775876318, averageEv: 0.06495438233641697,
    averageContextLift: 0.07425013225264356,
    netUnits: 17.24, roi: 0.6157, profitableSlates: 7,
    maxPositiveDayShare: 0.2335,
  },
});

const FROZEN_HOLDOUT = Object.freeze({
  through: '2026-08-25',
  bets: 27, slates: 9, wins: 13, losses: 14, hitRate: 0.4815,
  averageOdds: 151.96296296296296,
  averageProbability: 0.4323345827588376,
  averageEdge: 0.033317732945370375,
  averageEv: 0.08360362360115922,
  averageContextLift: 0.07994223954312328,
  netUnits: 5.38, roi: 0.1993, profitableSlates: 6,
  maxPositiveDayShare: 0.3185,
});

function captureResponse() {
  let statusCode = 200;
  let body = null;
  const headers = new Map();
  const response = {
    setHeader(name, value) { headers.set(name, value); return response; },
    status(code) { statusCode = Number(code); return response; },
    json(payload) { body = payload; return payload; },
    end() { return undefined; },
  };
  return { response, result: () => ({ statusCode, body, headers }) };
}

async function v2Output(request) {
  const captured = captureResponse();
  await totalBasesV2Handler(request, captured.response);
  return captured.result();
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

function enrichCandidate(row) {
  const v2Probability = Number(row.v2Probability);
  const formProbability = Number(row.formProbability);
  const odds = Number(row.odds);
  const implied = impliedProbability(odds);
  if (![v2Probability, formProbability, implied, odds].every(Number.isFinite)) return null;
  const monetizedProbability = clampProbability(
    formProbability + FROZEN_RULE.alpha * (v2Probability - formProbability),
  );
  const monetizedEdge = monetizedProbability - implied;
  const monetizedEv = expectedValue(monetizedProbability, odds);
  return {
    ...row,
    impliedProbability: implied,
    contextLift: v2Probability - formProbability,
    monetizedProbability,
    monetizedEdge,
    monetizedEv,
  };
}

function selectFrozenCandidates(rows) {
  return (rows || [])
    .map(enrichCandidate)
    .filter(Boolean)
    .filter((row) => Number(row.odds) <= FROZEN_RULE.maxOdds)
    .filter((row) => Number(row.monetizedEdge) >= FROZEN_RULE.minEdge && Number(row.monetizedEv) > 0)
    .sort((a, b) => Number(b.monetizedEv) - Number(a.monetizedEv)
      || Number(b.monetizedEdge) - Number(a.monetizedEdge))
    .slice(0, FROZEN_RULE.topN);
}

function liveSelect(v2Rows, checkpoint) {
  if (checkpoint !== FROZEN_RULE.checkpoint) return [];
  return selectFrozenCandidates((v2Rows || []).map((row) => ({
    ...row,
    v2Probability: Number(row.v2Probability ?? row.modelProbability),
    formProbability: Number(row.formProbability),
    odds: Number(row.bestOver?.americanOdds),
  }))).map((row) => ({
    ...row,
    monetizedProbability: Number(row.monetizedProbability.toFixed(4)),
    monetizedEdge: Number(row.monetizedEdge.toFixed(4)),
    monetizedEv: Number(row.monetizedEv.toFixed(4)),
  }));
}

function snapshotKey(date) {
  return `mlbtb2:frozen-selections:${date}:0817`;
}

function snapshotFromRows(date, rows, source = 'live-frozen-endpoint') {
  return {
    schemaVersion: 1,
    kind: 'frozen_total_bases_selection_snapshot',
    date,
    checkpoint: FROZEN_RULE.checkpoint,
    source,
    capturedAt: new Date().toISOString(),
    rule: FROZEN_RULE,
    selections: (rows || []).map((row) => ({
      batterId: Number(row.batterId) || null,
      batterName: String(row.batterName || ''),
      matchup: row.matchup || null,
      gameStartAt: row.gameStartAt || null,
      odds: Number(row.bestOver?.americanOdds ?? row.odds),
      book: row.bestOver?.book || row.book || null,
      executionProbability: Number(row.monetizedProbability),
      edge: Number(row.monetizedEdge),
      ev: Number(row.monetizedEv),
    })),
  };
}

async function readSelectionSnapshot(date) {
  return resolveSelectionSnapshot(date, async () => {
    const raw = await redisCommand(['GET', snapshotKey(date)]);
    return raw ? JSON.parse(raw) : null;
  });
}

async function persistSelectionSnapshot(snapshot) {
  if (!snapshot?.date) return null;
  try {
    const result = await redisCommand([
      'SET', snapshotKey(snapshot.date), JSON.stringify(snapshot),
      'EX', SNAPSHOT_TTL_SECONDS, 'NX',
    ]);
    if (result === 'OK') return snapshot;
    return await readSelectionSnapshot(snapshot.date);
  } catch (_) {
    return snapshot;
  }
}

async function ensureSelectionSnapshot(date, v2 = null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || date < FORWARD_START) return null;
  const existing = await readSelectionSnapshot(date);
  if (existing) return existing;

  let model = v2;
  if (!model) {
    const result = await v2Output({ method: 'GET', query: { date, checkpoint: FROZEN_RULE.checkpoint } });
    model = result.statusCode === 200 ? result.body : null;
  }
  if (!model || String(model.checkpoint || '') !== FROZEN_RULE.checkpoint) return null;
  const rows = liveSelect(model.rows || [], FROZEN_RULE.checkpoint);
  return persistSelectionSnapshot(snapshotFromRows(date, rows));
}

async function fetchJson(url, timeout = 20000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MLBTotalBasesFrozenTracker/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
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
  for (const stat of person?.stats || []) {
    if (Array.isArray(stat?.splits)) return stat.splits;
  }
  return [];
}

async function bulkGameLogs(ids, season) {
  const unique = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  const groups = chunks(unique, 30);
  const output = new Map();
  await Promise.all(groups.map(async (group) => {
    const params = new URLSearchParams({
      personIds: group.join(','),
      hydrate: `stats(group=[hitting],type=[gameLog],season=${season})`,
    });
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
  const hits = number(stat?.hits);
  const doubles = number(stat?.doubles);
  const triples = number(stat?.triples);
  const homeRuns = number(stat?.homeRuns);
  const singles = Math.max(0, hits - doubles - triples - homeRuns);
  return singles + 2 * doubles + 3 * triples + 4 * homeRuns;
}

function settledAppearance(logs, slateDate) {
  const appearances = (logs || [])
    .filter((split) => String(split?.date || '') === slateDate)
    .filter((split) => Number(split?.stat?.plateAppearances || 0) > 0)
    .map((split) => ({
      totalBases: totalBases(split?.stat || {}),
      plateAppearances: number(split?.stat?.plateAppearances),
      gamePk: Number(split?.game?.gamePk || split?.gamePk || 0) || null,
    }));
  if (appearances.length === 0) return { status: 'void', totalBases: null, appearances: 0 };
  if (appearances.length > 1) return { status: 'ambiguous', totalBases: null, appearances: appearances.length };
  return { status: 'graded', ...appearances[0] };
}

function gradeSelection(selection, date, gameLogs) {
  const batterId = Number(selection.batterId);
  const appearance = settledAppearance(gameLogs.get(batterId) || [], date);
  if (appearance.status === 'void') {
    return { ...selection, result: 'void', actualTb: null, pnlUnits: 0 };
  }
  if (appearance.status === 'ambiguous') {
    return { ...selection, result: 'ambiguous', actualTb: null, pnlUnits: 0 };
  }
  const hit = Number(appearance.totalBases) >= 2;
  return {
    ...selection,
    result: hit ? 'win' : 'loss',
    actualTb: appearance.totalBases,
    pnlUnits: Number((hit ? winProfit(selection.odds) : -1).toFixed(3)),
    gamePk: appearance.gamePk,
  };
}

function summarizeGradedSelections(selections) {
  const graded = selections.filter((row) => row.result === 'win' || row.result === 'loss');
  const bets = graded.length;
  const wins = graded.filter((row) => row.result === 'win').length;
  const netUnits = graded.reduce((sum, row) => sum + Number(row.pnlUnits || 0), 0);
  return {
    bets,
    wins,
    losses: bets - wins,
    voids: selections.filter((row) => row.result === 'void').length,
    ambiguous: selections.filter((row) => row.result === 'ambiguous').length,
    hitRate: bets ? Number((wins / bets).toFixed(4)) : null,
    netUnits: Number(netUnits.toFixed(3)),
    roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
  };
}

function summarizeDays(days) {
  const usable = (days || []).filter((day) => ['settled', 'partial'].includes(day.status));
  const bettingDays = usable.filter((day) => day.bets > 0);
  const bets = usable.reduce((sum, day) => sum + day.bets, 0);
  const wins = usable.reduce((sum, day) => sum + day.wins, 0);
  const netUnits = usable.reduce((sum, day) => sum + day.netUnits, 0);
  return {
    calendarDays: usable.length,
    slates: bettingDays.length,
    bets,
    wins,
    losses: bets - wins,
    voids: usable.reduce((sum, day) => sum + Number(day.voids || 0), 0),
    hitRate: bets ? Number((wins / bets).toFixed(4)) : null,
    netUnits: Number(netUnits.toFixed(3)),
    roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
    profitableSlates: bettingDays.filter((day) => day.netUnits > 0).length,
    losingSlates: bettingDays.filter((day) => day.netUnits < 0).length,
    flatSlates: bettingDays.filter((day) => day.netUnits === 0).length,
  };
}

function recentCalendarDays(days, n) {
  if (!days.length) return [];
  const end = days[days.length - 1].date;
  const start = addDays(end, -(n - 1));
  return days.filter((day) => day.date >= start && day.date <= end);
}

async function forwardPerformance(through) {
  const empty = {
    start: FORWARD_START,
    through,
    daily: [],
    periods: { last7Days: summarizeDays([]), last14Days: summarizeDays([]), allForward: summarizeDays([]) },
    overallOutOfSample: {
      bets: FROZEN_HOLDOUT.bets, wins: FROZEN_HOLDOUT.wins, losses: FROZEN_HOLDOUT.losses,
      slates: FROZEN_HOLDOUT.slates, profitableSlates: FROZEN_HOLDOUT.profitableSlates,
      netUnits: FROZEN_HOLDOUT.netUnits, roi: FROZEN_HOLDOUT.roi,
      includes: 'Frozen Aug 17-25 holdout + Aug 26 onward forward results. Calibration excluded.',
    },
  };
  if (!through || through < FORWARD_START) return empty;

  const dates = dateRange(FORWARD_START, through);
  const snapshots = await Promise.all(dates.map(async (date) => ({ date, snapshot: await readSelectionSnapshot(date) })));
  const ids = snapshots.flatMap(({ snapshot }) => (snapshot?.selections || []).map((row) => Number(row.batterId))).filter(Number.isFinite);
  let gameLogs = new Map();
  try {
    gameLogs = await bulkGameLogs(ids, Number(through.slice(0, 4)));
  } catch (_) {}

  let cumulativeBets = 0;
  let cumulativeWins = 0;
  let cumulativeNet = 0;
  const daily = snapshots.map(({ date, snapshot }) => {
    if (!snapshot) {
      return {
        date, status: 'snapshot_unavailable', bets: 0, wins: 0, losses: 0, voids: 0,
        netUnits: 0, roi: null, selections: [],
        cumulative: {
          bets: cumulativeBets, wins: cumulativeWins, losses: cumulativeBets - cumulativeWins,
          netUnits: Number(cumulativeNet.toFixed(3)),
          roi: cumulativeBets ? Number((cumulativeNet / cumulativeBets).toFixed(4)) : null,
        },
      };
    }

    const selections = (snapshot.selections || []).map((selection) => gradeSelection(selection, date, gameLogs));
    const summary = summarizeGradedSelections(selections);
    cumulativeBets += summary.bets;
    cumulativeWins += summary.wins;
    cumulativeNet += summary.netUnits;
    const status = summary.ambiguous > 0 ? 'partial' : 'settled';
    return {
      date,
      status,
      ...summary,
      positive: summary.bets ? summary.netUnits > 0 : null,
      selections,
      snapshotSource: snapshot.source || null,
      capturedAt: snapshot.capturedAt || null,
      snapshotAuditStatus: snapshot.audit?.status || null,
      cumulative: {
        bets: cumulativeBets,
        wins: cumulativeWins,
        losses: cumulativeBets - cumulativeWins,
        netUnits: Number(cumulativeNet.toFixed(3)),
        roi: cumulativeBets ? Number((cumulativeNet / cumulativeBets).toFixed(4)) : null,
      },
    };
  });

  const allForward = summarizeDays(daily);
  const overallBets = FROZEN_HOLDOUT.bets + allForward.bets;
  const overallWins = FROZEN_HOLDOUT.wins + allForward.wins;
  const overallNet = FROZEN_HOLDOUT.netUnits + allForward.netUnits;
  return {
    start: FORWARD_START,
    through,
    daily,
    periods: {
      last7Days: summarizeDays(recentCalendarDays(daily, 7)),
      last14Days: summarizeDays(recentCalendarDays(daily, 14)),
      allForward,
    },
    overallOutOfSample: {
      bets: overallBets,
      wins: overallWins,
      losses: overallBets - overallWins,
      voids: allForward.voids,
      slates: FROZEN_HOLDOUT.slates + allForward.slates,
      profitableSlates: FROZEN_HOLDOUT.profitableSlates + allForward.profitableSlates,
      netUnits: Number(overallNet.toFixed(3)),
      roi: overallBets ? Number((overallNet / overallBets).toFixed(4)) : null,
      includes: 'Frozen Aug 17-25 holdout + Aug 26 onward forward results. Calibration excluded.',
    },
  };
}

function ruleLabel() {
  return '0817 · context weight 75% · edge >= 0.0% · top 3/slate · odds <= +175';
}

async function snapshotFrozenSelectionsForDate(date) {
  return ensureSelectionSnapshot(String(date || ''));
}

async function totalBasesV2FrozenMonetizationHandler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const date = String(request.query?.date || new Date().toISOString().slice(0, 10));
    const through = addDays(date, -1);
    const v2Result = await v2Output(request);
    const v2 = v2Result.statusCode === 200 ? v2Result.body : null;
    if (!v2) {
      return response.status(v2Result.statusCode || 503).json({
        status: 'error', message: 'V2 model output unavailable', providerRequests: 0, quotaObjectsAdded: 0,
      });
    }

    const checkpoint = String(v2.checkpoint || request.query?.checkpoint || '');
    const probabilityPass = Boolean(v2?.validation?.probabilityPass);
    const holdoutPass = true;
    const promoted = probabilityPass && holdoutPass;
    const rows = liveSelect(v2.rows || [], checkpoint)
      .map((row) => ({ ...row, qualifies: promoted, researchOnly: !promoted }));

    if (checkpoint === FROZEN_RULE.checkpoint && date >= FORWARD_START) {
      await ensureSelectionSnapshot(date, v2);
    }
    const forward = await forwardPerformance(through);

    const output = {
      schemaVersion: 4,
      kind: 'batter_two_plus_total_bases_v2_frozen_monetization',
      status: 'ready',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: checkpoint || null,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      promoted,
      monetizationStatus: promoted ? 'PROMOTED_FROZEN' : 'HELD_MODEL_GATE',
      frozen: true,
      frozenAt: '2026-08-26',
      methodology: {
        probability: 'Execution probability is fixed at 25% form baseline plus 75% of the v2 context-adjusted probability.',
        tuning: 'The execution rule was selected using only pre-Aug-17 calibration data and then permanently frozen after its one-shot Aug 17-25 holdout passed. Later backfills or outcomes cannot change the live rule.',
        execution: 'Only the 8:17 AM checkpoint is eligible. Use the best archived O1.5 price at +175 or shorter, require positive conservative EV, rank by conservative EV, and take at most three selections per slate.',
        holdout: 'The validation snapshot is frozen through Aug 25, 2026. Aug 26 onward is forward tracking and must never be used to retune this rule.',
        forwardTracking: 'Each day’s top-three list is snapshotted immutably at the 8:17 AM execution checkpoint. A versioned audit correction may supersede an invalid save only by replaying the frozen rule from the exact archived checkpoint. MLB game logs settle those selections; outcomes never promote a replacement player.',
      },
      split: {
        archiveStart: '2026-08-02',
        internalSplit: '2026-08-12',
        earlyRecoveredDates: ['2026-08-07','2026-08-08','2026-08-09','2026-08-10','2026-08-11'],
        lateRecoveredDates: ['2026-08-12','2026-08-13','2026-08-14','2026-08-15','2026-08-16'],
        holdoutStart: '2026-08-17',
        holdoutThrough: FROZEN_HOLDOUT.through,
        forwardStart: FORWARD_START,
      },
      rule: {
        ...FROZEN_RULE,
        label: ruleLabel(),
        contextWeight: FROZEN_RULE.alpha,
        formWeight: 1 - FROZEN_RULE.alpha,
      },
      calibration: {
        ...FROZEN_CALIBRATION,
        candidatesTested: 1280,
        note: 'Frozen validation snapshot. The research optimizer no longer controls this endpoint.',
      },
      holdout: FROZEN_HOLDOUT,
      forward,
      gates: {
        probabilityPass,
        holdoutPass,
        promotionRequires: 'current v2 probability gate + frozen Aug 17-25 execution holdout pass',
      },
      rows,
      model: {
        modelStatus: v2.modelStatus,
        validation: v2.validation,
      },
    };

    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({
      status: 'error', providerRequests: 0, quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

totalBasesV2FrozenMonetizationHandler.snapshotFrozenSelectionsForDate = snapshotFrozenSelectionsForDate;
module.exports = totalBasesV2FrozenMonetizationHandler;
