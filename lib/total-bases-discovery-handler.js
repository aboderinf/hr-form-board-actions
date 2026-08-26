const { playerKey, redisCommand } = require('./checkpoint-runtime');
const { readTotalBasesCheckpoint, TARGET_LINE } = require('./total-bases-runtime');

const MLB = 'https://statsapi.mlb.com/api/v1';
const ARCHIVE_START = '2026-08-02';
const CHECKPOINTS = ['0817', '1117', '1717', '2017'];
const BULK_SIZE = 30;
const PRIOR_GAMES = 4;
const DEFAULT_PRIOR = 0.40;
const CACHE_TTL_SECONDS = 21600;

function etDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const out = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) out.push(cursor);
  return out;
}

async function fetchJson(url, timeout = 20000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MLBTotalBasesDiscovery/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`MLB Stats API HTTP ${response.status}`);
  return response.json();
}

async function mapWithConcurrency(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function playerDirectory(season) {
  const cacheKey = `mlbtb2:player-directory:${season}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  const payload = await fetchJson(`${MLB}/sports/1/players?season=${season}&gameType=R`);
  const rawRows = payload?.people || payload?.players || [];
  const rows = rawRows
    .map((row) => row?.person || row)
    .filter((row) => Number.isFinite(Number(row?.id)) && row?.fullName)
    .map((row) => ({ id: Number(row.id), fullName: String(row.fullName), playerKey: playerKey(row.fullName) }));
  try { await redisCommand(['SET', cacheKey, JSON.stringify(rows), 'EX', 21600]); } catch (_) {}
  return rows;
}

function hydrateBatters(oddsRows, directory) {
  const byKey = new Map();
  for (const player of directory) {
    if (!byKey.has(player.playerKey)) byKey.set(player.playerKey, []);
    byKey.get(player.playerKey).push(player);
  }
  const rows = [];
  const missing = [];
  const ambiguous = [];
  for (const row of oddsRows || []) {
    const matches = byKey.get(row.playerKey) || [];
    if (matches.length === 1) rows.push({ ...row, batterId: matches[0].id });
    else if (matches.length > 1) ambiguous.push(row.batterName);
    else missing.push(row.batterName);
  }
  return { rows, missing, ambiguous };
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function extractHydratedGameLog(person) {
  for (const stat of person?.stats || []) {
    if (Array.isArray(stat?.splits)) return stat.splits;
  }
  return [];
}

async function bulkGameLogs(ids, season) {
  const uniqueIds = [...new Set(ids.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const groups = chunks(uniqueIds, BULK_SIZE);
  const responses = await mapWithConcurrency(groups, 5, async (group) => {
    const params = new URLSearchParams({
      personIds: group.join(','),
      hydrate: `stats(group=[hitting],type=[gameLog],season=${season})`,
    });
    const payload = await fetchJson(`${MLB}/people?${params.toString()}`, 25000);
    return payload?.people || [];
  });
  const output = new Map();
  for (const people of responses) {
    for (const person of people) {
      const id = Number(person?.id);
      if (Number.isFinite(id)) output.set(id, extractHydratedGameLog(person));
    }
  }
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

function startsBefore(logs, slateDate) {
  return (logs || [])
    .filter((split) => String(split?.date || '') < slateDate)
    .filter((split) => {
      const pa = Number(split?.stat?.plateAppearances);
      if (Number.isFinite(pa) && pa <= 0) return false;
      const gs = Number(split?.stat?.gamesStarted);
      return Number.isFinite(gs) ? gs > 0 : true;
    })
    .map((split) => {
      const stat = split?.stat || {};
      const tb = totalBases(stat);
      const xbh = number(stat.doubles) + number(stat.triples) + number(stat.homeRuns);
      return {
        date: String(split.date || ''),
        totalBases: tb,
        hit2Plus: tb >= 2 ? 1 : 0,
        extraBaseHit: xbh > 0 ? 1 : 0,
        plateAppearances: number(stat.plateAppearances) || null,
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
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
  if (appearances.length !== 1) {
    return { settled: false, ambiguousDoubleheader: appearances.length > 1, appearances: appearances.length };
  }
  return { settled: true, ...appearances[0] };
}

function avg(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function windowMetrics(starts, n, prior) {
  const sample = starts.slice(0, n);
  if (!sample.length) {
    return { games: 0, hits2Plus: 0, hitRate: null, adjustedHitRate: prior, avgTb: null, xbhRate: null };
  }
  const hits2Plus = sample.reduce((sum, row) => sum + row.hit2Plus, 0);
  return {
    games: sample.length,
    hits2Plus,
    hitRate: hits2Plus / sample.length,
    adjustedHitRate: (hits2Plus + prior * PRIOR_GAMES) / (sample.length + PRIOR_GAMES),
    avgTb: avg(sample.map((row) => row.totalBases)),
    xbhRate: avg(sample.map((row) => row.extraBaseHit)),
  };
}

function formMetrics(starts, prior) {
  const l5 = windowMetrics(starts, 5, prior);
  const l10 = windowMetrics(starts, 10, prior);
  const l15 = windowMetrics(starts, 15, prior);
  const weightedAdjustedRate = 0.5 * l5.adjustedHitRate + 0.3 * l10.adjustedHitRate + 0.2 * l15.adjustedHitRate;
  const avgParts = [[0.5, l5.avgTb], [0.3, l10.avgTb], [0.2, l15.avgTb]].filter(([, value]) => value != null);
  const avgWeight = avgParts.reduce((sum, [weight]) => sum + weight, 0) || 1;
  const weightedAvgTb = avgParts.reduce((sum, [weight, value]) => sum + weight * value, 0) / avgWeight;
  return {
    formScore: Number((100 * weightedAdjustedRate).toFixed(1)),
    weightedAvgTb: Number(weightedAvgTb.toFixed(2)),
    trend5v15: l5.hitRate == null || l15.hitRate == null ? null : Number((l5.hitRate - l15.hitRate).toFixed(4)),
    gamesAvailable: starts.length,
    l5,
    l10,
    l15,
  };
}

function slatePrior(histories) {
  let games = 0;
  let hits = 0;
  for (const starts of histories.values()) {
    for (const row of starts.slice(0, 30)) {
      games += 1;
      hits += row.hit2Plus;
    }
  }
  return games ? hits / games : DEFAULT_PRIOR;
}

function quoteSummary(odds) {
  const quotes = [];
  let bestOver = null;
  for (const [book, sides] of Object.entries(odds || {})) {
    const over = sides?.over;
    if (!over || Number(over.line) !== TARGET_LINE || !Number.isFinite(Number(over.americanOdds))) continue;
    const quote = { book, ...over, americanOdds: Number(over.americanOdds) };
    quotes.push(quote);
    if (!bestOver || quote.americanOdds > bestOver.americanOdds) bestOver = quote;
  }
  return { quotes, bestOver };
}

function impliedProbability(americanOdds) {
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : (-odds) / ((-odds) + 100);
}

function profitUnits(hit, americanOdds) {
  if (!hit) return -1;
  const odds = Number(americanOdds);
  if (odds > 0) return odds / 100;
  return 100 / Math.abs(odds);
}

function checkpointLabel(value) {
  const labels = { '0817': '8:17 AM', '1117': '11:17 AM', '1717': '5:17 PM', '2017': '8:17 PM' };
  return labels[value] || value;
}

function formBand(score) {
  const n = Number(score);
  if (n >= 65) return '65+';
  if (n >= 55) return '55–64.9';
  if (n >= 45) return '45–54.9';
  if (n >= 35) return '35–44.9';
  return 'Below 35';
}

function oddsBand(odds) {
  const n = Number(odds);
  if (n <= -140) return '≤ -140';
  if (n <= -110) return '-139 to -110';
  if (n <= 110) return '-109 to +110';
  if (n <= 140) return '+111 to +140';
  return '+141 or longer';
}

function tbBand(value) {
  const n = Number(value);
  if (n >= 2.5) return '2.50+ TB';
  if (n >= 2.0) return '2.00–2.49 TB';
  if (n >= 1.5) return '1.50–1.99 TB';
  return 'Below 1.50 TB';
}

function l5Band(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 'No L5';
  if (n >= 0.8) return '80%+';
  if (n >= 0.6) return '60–79%';
  if (n >= 0.4) return '40–59%';
  return 'Below 40%';
}

function wilsonLower(wins, n, z = 1.6448536269514722) {
  if (!n) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (center - spread) / denom;
}

function summary(rows) {
  const bets = rows.length;
  const wins = rows.filter((row) => row.hit).length;
  const losses = bets - wins;
  const netUnits = rows.reduce((sum, row) => sum + Number(row.profitUnits || 0), 0);
  const hitRate = bets ? wins / bets : null;
  const avgImplied = avg(rows.map((row) => row.impliedProbability));
  const slates = new Set(rows.map((row) => row.date)).size;
  const avgFormScore = avg(rows.map((row) => row.formScore));
  const avgWeightedTb = avg(rows.map((row) => row.weightedAvgTb));
  return {
    bets,
    slates,
    wins,
    losses,
    hitRate: hitRate == null ? null : Number(hitRate.toFixed(4)),
    averageBreakEven: avgImplied == null ? null : Number(avgImplied.toFixed(4)),
    empiricalProbabilityEdge: hitRate == null || avgImplied == null ? null : Number((hitRate - avgImplied).toFixed(4)),
    lower90HitRate: hitRate == null ? null : Number(wilsonLower(wins, bets).toFixed(4)),
    netUnits: Number(netUnits.toFixed(3)),
    roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
    averageFormScore: avgFormScore == null ? null : Number(avgFormScore.toFixed(1)),
    averageWeightedTb: avgWeightedTb == null ? null : Number(avgWeightedTb.toFixed(2)),
  };
}

function grouped(rows, keyFn, labelFn = (key) => key) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets.entries()]
    .map(([key, values]) => ({ label: labelFn(key), ...summary(values) }))
    .sort((a, b) => (b.roi ?? -999) - (a.roi ?? -999) || b.bets - a.bets);
}

function confidenceFor(total, train, holdout) {
  if (
    total.bets >= 40 && total.slates >= 8
    && train.bets >= 15 && holdout.bets >= 10
    && train.roi > 0 && holdout.roi > 0
    && total.lower90HitRate != null && total.averageBreakEven != null
    && total.lower90HitRate > total.averageBreakEven
  ) return 'validated';
  if (
    total.bets >= 25 && total.slates >= 6
    && train.bets >= 10 && holdout.bets >= 8
    && train.roi > 0 && holdout.roi > 0
  ) return 'promising';
  return 'exploratory';
}

function edgeCandidates(bestEntries, bookEntries, holdoutStart) {
  const cp = (row) => checkpointLabel(row.checkpoint);
  const specs = [
    ['Checkpoint', bestEntries, (row) => cp(row)],
    ['Checkpoint × form', bestEntries, (row) => `${cp(row)} · ${formBand(row.formScore)}`],
    ['Checkpoint × odds', bestEntries, (row) => `${cp(row)} · ${oddsBand(row.odds)}`],
    ['Checkpoint × best book', bestEntries, (row) => `${cp(row)} · ${row.book}`],
    ['Checkpoint × TB form', bestEntries, (row) => `${cp(row)} · ${tbBand(row.weightedAvgTb)}`],
    ['Checkpoint × L5', bestEntries, (row) => `${cp(row)} · ${l5Band(row.l5HitRate)}`],
    ['Checkpoint × form × odds', bestEntries, (row) => `${cp(row)} · ${formBand(row.formScore)} · ${oddsBand(row.odds)}`],
    ['Book quote', bookEntries, (row) => `${cp(row)} · ${row.book}`],
    ['Book × form', bookEntries, (row) => `${cp(row)} · ${row.book} · ${formBand(row.formScore)}`],
    ['Book × odds', bookEntries, (row) => `${cp(row)} · ${row.book} · ${oddsBand(row.odds)}`],
  ];

  const edges = [];
  for (const [dimension, rows, keyFn] of specs) {
    const buckets = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    for (const [rule, values] of buckets.entries()) {
      const total = summary(values);
      const train = summary(values.filter((row) => !holdoutStart || row.date < holdoutStart));
      const holdout = summary(values.filter((row) => holdoutStart && row.date >= holdoutStart));
      if (total.bets < 20 || total.slates < 5 || holdout.bets < 5) continue;
      if (!(total.roi > 0) || !(holdout.roi > 0) || !(total.empiricalProbabilityEdge > 0)) continue;
      const confidence = confidenceFor(total, train, holdout);
      edges.push({
        dimension,
        rule,
        execution: dimension.startsWith('Book') ? 'exact-book quote' : 'best available price',
        confidence,
        total,
        train,
        holdout,
      });
    }
  }

  const rank = { validated: 3, promising: 2, exploratory: 1 };
  return edges
    .sort((a, b) => {
      const confidence = rank[b.confidence] - rank[a.confidence];
      if (confidence) return confidence;
      const aFloor = Math.min(a.train.roi ?? -999, a.holdout.roi ?? -999);
      const bFloor = Math.min(b.train.roi ?? -999, b.holdout.roi ?? -999);
      return bFloor - aFloor || b.total.netUnits - a.total.netUnits || b.total.bets - a.total.bets;
    })
    .slice(0, 30);
}

module.exports = async function totalBasesDiscoveryHandler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const today = etDate();
  const defaultThrough = addDays(today, -1);
  const requestedThrough = String(request.query?.through || defaultThrough);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedThrough) || requestedThrough < ARCHIVE_START || requestedThrough > defaultThrough) {
    return response.status(400).json({
      status: 'error',
      message: `through must be between ${ARCHIVE_START} and ${defaultThrough}`,
    });
  }
  const monthStart = `${requestedThrough.slice(0, 7)}-01`;
  const start = monthStart > ARCHIVE_START ? monthStart : ARCHIVE_START;

  const cacheKey = `mlbtb2:discovery:v1:${start}:${requestedThrough}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) {
      const output = JSON.parse(cached);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
      response.setHeader('X-Total-Bases-Discovery-Cache', 'HIT');
      if (request.method === 'HEAD') return response.status(200).end();
      return response.status(200).json(output);
    }

    const dates = dateRange(start, requestedThrough);
    const captureRequests = dates.flatMap((date) => CHECKPOINTS.map((checkpoint) => ({ date, checkpoint })));
    const captureResults = await mapWithConcurrency(captureRequests, 12, async ({ date, checkpoint }) => {
      try {
        const payload = await readTotalBasesCheckpoint(date, checkpoint);
        return payload?.status === 'ready' ? payload : null;
      } catch (_) {
        return null;
      }
    });
    const captures = captureResults.filter(Boolean);
    if (!captures.length) {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
      return response.status(404).json({
        status: 'pending', start, through: requestedThrough,
        message: 'No archived Total Bases checkpoints were available in the requested window',
        providerRequests: 0,
      });
    }

    const season = Number(requestedThrough.slice(0, 4));
    const directory = await playerDirectory(season);
    const missingNames = new Set();
    const ambiguousNames = new Set();
    let archivedPropRows = 0;
    const hydratedCaptures = captures.map((capture) => {
      archivedPropRows += capture.rows?.length || 0;
      const hydrated = hydrateBatters(capture.rows || [], directory);
      hydrated.missing.forEach((name) => missingNames.add(name));
      hydrated.ambiguous.forEach((name) => ambiguousNames.add(name));
      return { capture, rows: hydrated.rows };
    });

    const uniqueIds = [...new Set(hydratedCaptures.flatMap(({ rows }) => rows.map((row) => Number(row.batterId))).filter(Number.isFinite))];
    const gameLogs = await bulkGameLogs(uniqueIds, season);

    const bestEntries = [];
    const bookEntries = [];
    let noPriorStarts = 0;
    let noSettledAppearance = 0;
    let ambiguousDoubleheaders = 0;

    for (const { capture, rows } of hydratedCaptures) {
      const unique = [...new Map(rows.map((row) => [Number(row.batterId), row])).values()];
      const histories = new Map();
      for (const batter of unique) histories.set(Number(batter.batterId), startsBefore(gameLogs.get(Number(batter.batterId)) || [], capture.date));
      const prior = slatePrior(histories);

      for (const oddsRow of rows) {
        const starts = histories.get(Number(oddsRow.batterId)) || [];
        if (!starts.length) {
          noPriorStarts += 1;
          continue;
        }
        const settled = settledAppearance(gameLogs.get(Number(oddsRow.batterId)) || [], capture.date);
        if (!settled.settled) {
          if (settled.ambiguousDoubleheader) ambiguousDoubleheaders += 1;
          else noSettledAppearance += 1;
          continue;
        }
        const quotes = quoteSummary(oddsRow.odds);
        if (!quotes.bestOver) continue;
        const form = formMetrics(starts, prior);
        const hit = settled.totalBases >= 2;
        const base = {
          date: capture.date,
          checkpoint: capture.checkpoint,
          batterId: Number(oddsRow.batterId),
          batterName: oddsRow.batterName,
          matchup: oddsRow.matchup || null,
          actualTb: settled.totalBases,
          hit,
          formScore: form.formScore,
          weightedAvgTb: form.weightedAvgTb,
          l5HitRate: form.l5.hitRate,
          l10HitRate: form.l10.hitRate,
          l15HitRate: form.l15.hitRate,
          trend5v15: form.trend5v15,
          gamesAvailable: form.gamesAvailable,
        };

        const best = quotes.bestOver;
        bestEntries.push({
          ...base,
          book: best.book,
          odds: Number(best.americanOdds),
          impliedProbability: impliedProbability(best.americanOdds),
          profitUnits: profitUnits(hit, best.americanOdds),
        });

        for (const quote of quotes.quotes) {
          bookEntries.push({
            ...base,
            book: quote.book,
            odds: Number(quote.americanOdds),
            impliedProbability: impliedProbability(quote.americanOdds),
            profitUnits: profitUnits(hit, quote.americanOdds),
          });
        }
      }
    }

    const settledDates = [...new Set(bestEntries.map((row) => row.date))].sort();
    let holdoutStart = null;
    if (settledDates.length >= 2) {
      const index = Math.max(1, Math.min(settledDates.length - 1, Math.floor(settledDates.length * 0.60)));
      holdoutStart = settledDates[index];
    }
    const edges = edgeCandidates(bestEntries, bookEntries, holdoutStart);
    const validatedEdges = edges.filter((row) => row.confidence === 'validated');
    const promisingEdges = edges.filter((row) => row.confidence === 'promising');

    const output = {
      schemaVersion: 1,
      kind: 'batter_two_plus_total_bases_discovery',
      status: 'ready',
      generatedAt: new Date().toISOString(),
      start,
      through: requestedThrough,
      holdoutStart,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      methodology: {
        market: 'Batter 2+ Total Bases (Over 1.5)',
        archive: 'Reads existing archived SportsGameOdds checkpoints only; discovery causes zero new provider calls.',
        settlement: 'Official MLB game-log total bases. A player-date with more than one MLB appearance is skipped to avoid assigning a doubleheader result to the wrong archived prop.',
        formLeakage: 'L5/L10/L15 form is reconstructed from starts strictly before the slate date, using the same empirical-Bayes score as the live form board.',
        execution: 'Best-price rules line-shop the three archived books at that checkpoint. Book rules use the exact named-book quote. Only Over 1.5 is included.',
        validation: holdoutStart ? `Rules are selected on the full month for exploration but must remain profitable in the fixed date holdout beginning ${holdoutStart}. Confidence also requires minimum bet/slate counts; validated requires a positive training ROI and 90% Wilson lower hit-rate above average break-even.` : 'Not enough settled dates for a holdout split.',
        caution: 'This is exploratory multiple-comparison analysis, not a guarantee of future profit. Confidence labels are intentionally conservative.',
      },
      coverage: {
        requestedCaptures: captureRequests.length,
        readyCaptures: captures.length,
        settledDates: settledDates.length,
        archivedPropRows,
        hydratedBatters: uniqueIds.length,
        settledBestPriceObservations: bestEntries.length,
        settledBookQuoteObservations: bookEntries.length,
        noPriorStarts,
        noSettledAppearance,
        ambiguousDoubleheaders,
        unmatchedPlayerNames: [...missingNames].sort(),
        ambiguousPlayerNames: [...ambiguousNames].sort(),
        mlbBulkRequests: Math.ceil(uniqueIds.length / BULK_SIZE) + 1,
      },
      baseline: summary(bestEntries),
      validationCounts: {
        validated: validatedEdges.length,
        promising: promisingEdges.length,
        exploratory: edges.length - validatedEdges.length - promisingEdges.length,
      },
      edges,
      breakdowns: {
        checkpoint: grouped(bestEntries, (row) => row.checkpoint, checkpointLabel),
        bestBook: grouped(bestEntries, (row) => `${row.checkpoint}|${row.book}`, (key) => {
          const [checkpoint, book] = key.split('|');
          return `${checkpointLabel(checkpoint)} · ${book}`;
        }),
        form: grouped(bestEntries, (row) => `${row.checkpoint}|${formBand(row.formScore)}`, (key) => {
          const [checkpoint, band] = key.split('|');
          return `${checkpointLabel(checkpoint)} · ${band}`;
        }),
        odds: grouped(bestEntries, (row) => `${row.checkpoint}|${oddsBand(row.odds)}`, (key) => {
          const [checkpoint, band] = key.split('|');
          return `${checkpointLabel(checkpoint)} · ${band}`;
        }),
      },
    };

    try { await redisCommand(['SET', cacheKey, JSON.stringify(output), 'EX', String(CACHE_TTL_SECONDS)]); } catch (_) {}
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    response.setHeader('X-Total-Bases-Discovery-Cache', 'MISS');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({
      status: 'error',
      start,
      through: requestedThrough,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

module.exports._test = {
  impliedProbability,
  profitUnits,
  formBand,
  oddsBand,
  summary,
  confidenceFor,
  edgeCandidates,
  wilsonLower,
};
