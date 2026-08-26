const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { playerKey, redisCommand } = require('./checkpoint-runtime');
const { readTotalBasesCheckpoint, TARGET_LINE } = require('./total-bases-runtime');
const totalBasesModelSafeHandler = require('./total-bases-model-safe-handler');

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, 'data', 'total-bases-model-v2');
const CHECKPOINTS = ['0817', '1117', '1717', '2017'];
const ARCHIVE_START = '2026-08-02';
const HOLDOUT_START = '2026-08-17';
const FEATURE_NAMES = [
  'b_single_pa_30', 'b_single_pa_90',
  'b_double_pa_30', 'b_double_pa_90',
  'b_triple_pa_30', 'b_triple_pa_90',
  'b_hr_pa_30', 'b_hr_pa_90',
  'b_hit_pa_30', 'b_hit_pa_90', 'b_hit_pa_season', 'b_hit_pa_previous',
  'b_xbh_pa_30', 'b_xbh_pa_90',
  'b_tb_pa_7', 'b_tb_pa_30', 'b_tb_pa_90', 'b_tb_pa_season', 'b_tb_pa_previous',
  'b_hard_bip_30', 'b_hard_bip_90',
  'b_ev_30', 'b_ev_90', 'b_launch_angle_30',
  'b_xba_30', 'b_xba_90', 'b_xslg_30', 'b_xslg_90',
  'b_line_bip_30', 'b_fly_bip_30', 'b_ground_bip_30',
  'b_pa_game_7', 'b_pa_game_30',
  'b_strikeout_pa_30', 'b_walk_pa_30',
  'b_rest_days', 'b_last_slot', 'b_age',
  'p_hit_pa_30', 'p_hit_pa_90', 'p_hit_pa_season',
  'p_double_pa_30', 'p_hr_pa_30',
  'p_tb_pa_30', 'p_tb_pa_90', 'p_tb_pa_season',
  'p_hard_bip_30', 'p_ev_30', 'p_xba_30', 'p_xslg_30', 'p_pa_30',
  't_hit_pa_30', 't_hit_pa_90', 't_tb_pa_30', 't_tb_pa_90', 't_hard_bip_30',
  'park_hit_factor', 'park_double_factor', 'park_hr_factor',
  'park_left_center', 'park_center', 'park_right_center', 'park_elevation',
  'temperature_f', 'humidity_pct', 'pressure_hpa', 'precipitation_mm',
  'wind_speed_mph', 'wind_out_mph', 'roof_closed',
  'is_home', 'batter_left', 'pitcher_left', 'same_hand', 'day_game',
  'month_sin', 'month_cos',
];

let artifactMemo = null;
let stateMemo = null;
let predictionsMemo = null;
let performanceMemo = null;

function addDays(iso, days) {
  const value = new Date(`${iso}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const out = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) out.push(cursor);
  return out;
}

function num(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function avg(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function compactName(value) {
  return playerKey(value).replace(/\s+/g, '');
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, filename), 'utf8'));
}

function loadState() {
  if (stateMemo) return stateMemo;
  const stateDir = path.join(ARTIFACT_DIR, 'state-parts');
  const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'manifest.json'), 'utf8'));
  const compressed = Buffer.concat(manifest.parts.map((name) => fs.readFileSync(path.join(stateDir, name))));
  const digest = crypto.createHash('sha256').update(compressed).digest('hex');
  if (digest !== manifest.sha256) throw new Error('Total Bases v2 state checksum mismatch');
  stateMemo = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
  return stateMemo;
}

function artifactsReady() {
  return ['model.json', 'performance.json', 'august-predictions.json', 'state-parts/manifest.json']
    .every((filename) => fs.existsSync(path.join(ARTIFACT_DIR, filename)));
}

function loadArtifacts() {
  if (!artifactsReady()) return null;
  artifactMemo ||= readJson('model.json');
  performanceMemo ||= readJson('performance.json');
  predictionsMemo ||= readJson('august-predictions.json');
  return { artifact: artifactMemo, performance: performanceMemo, predictions: predictionsMemo, state: loadState() };
}

function daysBetween(a, b) {
  const left = Date.parse(`${a}T12:00:00Z`);
  const right = Date.parse(`${b}T12:00:00Z`);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.max(0, Math.round((right - left) / 86400000)) : 7;
}

function emptyTotals() {
  return {
    games: 0, pa: 0, single: 0, double: 0, triple: 0, home_run: 0,
    walk: 0, strikeout: 0, bip: 0, of_bip: 0, line_drive: 0,
    fly_ball: 0, ground_ball: 0, hard_hit: 0, ev_sum: 0, ev_n: 0,
    la_sum: 0, la_n: 0, xba_sum: 0, xslg_sum: 0, xmetric_n: 0,
    distance_sum: 0, distance_n: 0,
  };
}

function bucketAt(entity, window, onDate) {
  if (!entity) return emptyTotals();
  const seasonYear = Number(entity.season_year || 0);
  const year = Number(String(onDate).slice(0, 4));
  if (window === 'season') return seasonYear === year ? { ...emptyTotals(), ...(entity.season || {}) } : emptyTotals();
  if (window === 'previous') {
    const source = seasonYear === year ? entity.previous : entity.season;
    return { ...emptyTotals(), ...(source || {}) };
  }
  const totals = { ...emptyTotals(), ...((entity.ewma || {})[String(window)] || {}) };
  const elapsed = entity.last_date ? daysBetween(String(entity.last_date), onDate) : 0;
  const factor = elapsed ? Math.exp(-Math.log(2) * elapsed / Number(window)) : 1;
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, num(value) * factor]));
}

function rate(totals, numerator, denominator, prior = 0, priorWeight = 40) {
  return (num(totals[numerator]) + prior * priorWeight) / (num(totals[denominator]) + priorWeight);
}

function mean(totals, numerator, denominator, fallback) {
  const d = num(totals[denominator]);
  return d > 0 ? num(totals[numerator]) / d : fallback;
}

function eventRate(totals, keys, prior, priorWeight = 40) {
  const numerator = keys.reduce((sum, key) => sum + num(totals[key]), 0);
  return (numerator + prior * priorWeight) / (num(totals.pa) + priorWeight);
}

function tbRate(totals, prior = 0.33, priorWeight = 50) {
  const tb = num(totals.single) + 2 * num(totals.double) + 3 * num(totals.triple) + 4 * num(totals.home_run);
  return (tb + prior * priorWeight) / (num(totals.pa) + priorWeight);
}

function weatherFeatures(context) {
  const weather = context.weather || {};
  const venue = context.venue || {};
  const field = venue.field_info || {};
  const location = venue.location || {};
  const condition = String(weather.condition || '').toLowerCase();
  const roofType = String(field.roof_type || '').toLowerCase();
  const roofClosed = Number(condition.includes('dome') || condition.includes('closed') || ['dome', 'fixed', 'indoor'].includes(roofType));
  let temperature = Number.isFinite(Number(weather.temperature_f)) ? Number(weather.temperature_f) : 72;
  let windSpeed = Number.isFinite(Number(weather.wind_speed_mph)) ? Number(weather.wind_speed_mph) : 0;
  let windOut = Number.isFinite(Number(weather.wind_out_mph)) ? Number(weather.wind_out_mph) : 0;
  let precipitation = Number.isFinite(Number(weather.precipitation_mm)) ? Number(weather.precipitation_mm) : 0;
  if (roofClosed) {
    temperature = 72; windSpeed = 0; windOut = 0; precipitation = 0;
  }
  return {
    temperature_f: temperature,
    humidity_pct: Number.isFinite(Number(weather.humidity_pct)) ? Number(weather.humidity_pct) : 55,
    pressure_hpa: Number.isFinite(Number(weather.pressure_hpa)) ? Number(weather.pressure_hpa) : 1013,
    precipitation_mm: precipitation,
    wind_speed_mph: windSpeed,
    wind_out_mph: windOut,
    roof_closed: roofClosed,
    elevation: num(location.elevation),
  };
}

function featureRow(batter, pitcher, opponent, context, onDate) {
  const b7 = bucketAt(batter, 7, onDate); const b30 = bucketAt(batter, 30, onDate); const b90 = bucketAt(batter, 90, onDate);
  const bs = bucketAt(batter, 'season', onDate); const bp = bucketAt(batter, 'previous', onDate);
  const p30 = bucketAt(pitcher, 30, onDate); const p90 = bucketAt(pitcher, 90, onDate); const ps = bucketAt(pitcher, 'season', onDate);
  const t30 = bucketAt(opponent, 30, onDate); const t90 = bucketAt(opponent, 90, onDate);
  const park = context.park || {}; const weather = weatherFeatures(context);
  const rest = batter?.last_date ? Math.min(14, daysBetween(String(batter.last_date), onDate)) : 7;
  const pitcherLeft = Number(String(pitcher?.throws || context.pitcher_throws || '').toUpperCase() === 'L');
  const stand = String(batter?.stand || context.batter_stand || '').toUpperCase();
  const batterLeft = stand === 'S' ? 1 - pitcherLeft : Number(stand === 'L');
  const month = Number(String(onDate).slice(5, 7));
  const angle = 2 * Math.PI * (month - 1) / 12;
  const hits = ['single', 'double', 'triple', 'home_run'];
  const xbh = ['double', 'triple', 'home_run'];
  return {
    b_single_pa_30: rate(b30, 'single', 'pa', .145, 40), b_single_pa_90: rate(b90, 'single', 'pa', .145, 55),
    b_double_pa_30: rate(b30, 'double', 'pa', .045, 40), b_double_pa_90: rate(b90, 'double', 'pa', .045, 55),
    b_triple_pa_30: rate(b30, 'triple', 'pa', .004, 50), b_triple_pa_90: rate(b90, 'triple', 'pa', .004, 65),
    b_hr_pa_30: rate(b30, 'home_run', 'pa', .030, 40), b_hr_pa_90: rate(b90, 'home_run', 'pa', .030, 55),
    b_hit_pa_30: eventRate(b30, hits, .224, 45), b_hit_pa_90: eventRate(b90, hits, .224, 60),
    b_hit_pa_season: eventRate(bs, hits, .224, 70), b_hit_pa_previous: eventRate(bp, hits, .224, 90),
    b_xbh_pa_30: eventRate(b30, xbh, .079, 45), b_xbh_pa_90: eventRate(b90, xbh, .079, 60),
    b_tb_pa_7: tbRate(b7, .33, 35), b_tb_pa_30: tbRate(b30, .33, 50), b_tb_pa_90: tbRate(b90, .33, 70),
    b_tb_pa_season: tbRate(bs, .33, 90), b_tb_pa_previous: tbRate(bp, .33, 110),
    b_hard_bip_30: rate(b30, 'hard_hit', 'ev_n', .39, 35), b_hard_bip_90: rate(b90, 'hard_hit', 'ev_n', .39, 50),
    b_ev_30: mean(b30, 'ev_sum', 'ev_n', 88.5), b_ev_90: mean(b90, 'ev_sum', 'ev_n', 88.5),
    b_launch_angle_30: mean(b30, 'la_sum', 'la_n', 12),
    b_xba_30: mean(b30, 'xba_sum', 'xmetric_n', .245), b_xba_90: mean(b90, 'xba_sum', 'xmetric_n', .245),
    b_xslg_30: mean(b30, 'xslg_sum', 'xmetric_n', .410), b_xslg_90: mean(b90, 'xslg_sum', 'xmetric_n', .410),
    b_line_bip_30: rate(b30, 'line_drive', 'bip', .20, 35), b_fly_bip_30: rate(b30, 'fly_ball', 'bip', .24, 35),
    b_ground_bip_30: rate(b30, 'ground_ball', 'bip', .43, 35),
    b_pa_game_7: rate(b7, 'pa', 'games', 4, 3), b_pa_game_30: rate(b30, 'pa', 'games', 4, 5),
    b_strikeout_pa_30: rate(b30, 'strikeout', 'pa', .225, 40), b_walk_pa_30: rate(b30, 'walk', 'pa', .085, 40),
    b_rest_days: rest, b_last_slot: num(batter?.last_slot, 6), b_age: num(batter?.age, 28),
    p_hit_pa_30: eventRate(p30, hits, .224, 60), p_hit_pa_90: eventRate(p90, hits, .224, 90), p_hit_pa_season: eventRate(ps, hits, .224, 110),
    p_double_pa_30: rate(p30, 'double', 'pa', .045, 60), p_hr_pa_30: rate(p30, 'home_run', 'pa', .030, 60),
    p_tb_pa_30: tbRate(p30, .33, 70), p_tb_pa_90: tbRate(p90, .33, 100), p_tb_pa_season: tbRate(ps, .33, 120),
    p_hard_bip_30: rate(p30, 'hard_hit', 'ev_n', .39, 55), p_ev_30: mean(p30, 'ev_sum', 'ev_n', 88.5),
    p_xba_30: mean(p30, 'xba_sum', 'xmetric_n', .245), p_xslg_30: mean(p30, 'xslg_sum', 'xmetric_n', .410), p_pa_30: num(p30.pa),
    t_hit_pa_30: eventRate(t30, hits, .224, 100), t_hit_pa_90: eventRate(t90, hits, .224, 140),
    t_tb_pa_30: tbRate(t30, .33, 110), t_tb_pa_90: tbRate(t90, .33, 150), t_hard_bip_30: rate(t30, 'hard_hit', 'ev_n', .39, 100),
    park_hit_factor: num(park.hit_factor, 100), park_double_factor: num(park.double_factor, 100), park_hr_factor: num(park.hr_factor, 100),
    park_left_center: num(park.left_center, 375), park_center: num(park.center, 400), park_right_center: num(park.right_center, 375), park_elevation: weather.elevation,
    temperature_f: weather.temperature_f, humidity_pct: weather.humidity_pct, pressure_hpa: weather.pressure_hpa,
    precipitation_mm: weather.precipitation_mm, wind_speed_mph: weather.wind_speed_mph, wind_out_mph: weather.wind_out_mph, roof_closed: weather.roof_closed,
    is_home: Number(Boolean(context.is_home)), batter_left: batterLeft, pitcher_left: pitcherLeft,
    same_hand: stand === 'S' ? 0 : Number(batterLeft === pitcherLeft), day_game: Number(num(context.local_hour, 19) < 17),
    month_sin: Math.sin(angle), month_cos: Math.cos(angle),
  };
}

function treeValue(tree, row) {
  let node = 0;
  while (Number(tree.children_left[node]) !== -1) {
    const feature = Number(tree.feature[node]);
    node = row[feature] <= Number(tree.threshold[node]) ? Number(tree.children_left[node]) : Number(tree.children_right[node]);
  }
  return Number(tree.value[node]);
}

function interpolate(value, xs, ys) {
  if (!xs?.length) return value;
  if (value <= xs[0]) return ys[0];
  if (value >= xs.at(-1)) return ys.at(-1);
  let low = 0; let high = xs.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (xs[middle] <= value) low = middle; else high = middle;
  }
  const span = xs[high] - xs[low];
  const weight = span ? (value - xs[low]) / span : 0;
  return ys[low] + weight * (ys[high] - ys[low]);
}

function predict(artifact, features) {
  const model = artifact.model || artifact;
  const names = model.feature_names || artifact.feature_names || FEATURE_NAMES;
  const row = names.map((name) => num(features[name]));
  let raw = num(model.init_raw);
  for (const tree of model.trees || []) raw += num(model.learning_rate, 1) * treeValue(tree, row);
  raw = Math.max(-35, Math.min(35, raw));
  let probability = 1 / (1 + Math.exp(-raw));
  const calibration = model.calibration || {};
  if (calibration.x?.length && calibration.y?.length) probability = interpolate(probability, calibration.x.map(Number), calibration.y.map(Number));
  return Math.max(.001, Math.min(.999, probability));
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
  return win == null ? null : probability * win - (1 - probability);
}

function fairAmerican(probability) {
  const p = Math.max(.0001, Math.min(.9999, Number(probability)));
  return p >= .5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

function bestOver(odds) {
  let best = null;
  for (const [book, sides] of Object.entries(odds || {})) {
    const over = sides?.over;
    if (!over || Number(over.line) !== TARGET_LINE || !Number.isFinite(Number(over.americanOdds))) continue;
    if (!best || Number(over.americanOdds) > best.americanOdds) best = { book, americanOdds: Number(over.americanOdds), line: TARGET_LINE };
  }
  return best;
}

function settle(hit, odds) {
  return hit ? (winProfit(odds) ?? -1) : -1;
}

function probabilityMetrics(rows, field) {
  const usable = rows.filter((row) => Number.isFinite(Number(row[field])) && [0, 1].includes(Number(row.hit)));
  if (!usable.length) return { n: 0, brier: null, log_loss: null, average_probability: null, hit_rate: null, calibration_gap: null };
  let brier = 0; let loss = 0; let wins = 0; let probabilitySum = 0;
  for (const row of usable) {
    const y = Number(row.hit);
    const p = Math.max(.001, Math.min(.999, Number(row[field])));
    wins += y; probabilitySum += p; brier += (p - y) ** 2;
    loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  const averageProbability = probabilitySum / usable.length;
  const hitRate = wins / usable.length;
  return {
    n: usable.length,
    brier: Number((brier / usable.length).toFixed(5)),
    log_loss: Number((loss / usable.length).toFixed(5)),
    average_probability: Number(averageProbability.toFixed(4)),
    hit_rate: Number(hitRate.toFixed(4)),
    calibration_gap: Number((averageProbability - hitRate).toFixed(4)),
  };
}

function strategySummary(rows) {
  const bets = rows.length;
  const wins = rows.reduce((sum, row) => sum + Number(row.hit), 0);
  const netUnits = rows.reduce((sum, row) => sum + settle(row.hit, row.odds), 0);
  return {
    bets, slates: new Set(rows.map((row) => row.date)).size, wins, losses: bets - wins,
    hitRate: bets ? wins / bets : null,
    averageOdds: avg(rows.map((row) => row.odds)), averageEdge: avg(rows.map((row) => row.edge)), averageEv: avg(rows.map((row) => row.ev)),
    netUnits: Number(netUnits.toFixed(3)), roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
  };
}

function tuneStrategy(rows) {
  const checkpoints = [null, ...CHECKPOINTS];
  const edges = [0, .01, .02, .03, .04, .05, .07, .10];
  const evs = [0, .02, .04, .06, .08, .10, .15];
  let best = null;
  for (const checkpoint of checkpoints) {
    for (const minEdge of edges) {
      for (const minEv of evs) {
        const selected = rows.filter((row) => (!checkpoint || row.checkpoint === checkpoint) && row.edge >= minEdge && row.ev >= minEv);
        if (selected.length < 25 || new Set(selected.map((row) => row.date)).size < 5) continue;
        const stats = strategySummary(selected);
        if (!(stats.roi > 0)) continue;
        const score = stats.netUnits + .20 * Math.sqrt(stats.bets) + 2 * stats.roi;
        if (!best || score > best.score) best = { checkpoint, minEdge, minEv, score, stats };
      }
    }
  }
  return best ? { ...best, ready: true } : { ready: false, checkpoint: null, minEdge: null, minEv: null, stats: strategySummary([]) };
}

function captureResponse() {
  let statusCode = 200; let body = null;
  const headers = new Map();
  const response = {
    setHeader(name, value) { headers.set(name, value); return response; }, status(code) { statusCode = Number(code); return response; },
    json(payload) { body = payload; return payload; }, end() { return undefined; },
  };
  return { response, result: () => ({ statusCode, body, headers }) };
}

async function v1Output(request) {
  const captured = captureResponse();
  await totalBasesModelSafeHandler(request, captured.response);
  return captured.result();
}

async function archiveEvaluation(predictions, through) {
  const predictionMap = new Map();
  for (const row of predictions || []) {
    if (row.date > through) continue;
    predictionMap.set(`${row.date}|${compactName(row.player_key || row.player)}`, row);
  }
  const requests = dateRange(ARCHIVE_START, through).flatMap((date) => CHECKPOINTS.map((checkpoint) => ({ date, checkpoint })));
  const captures = await Promise.all(requests.map(async ({ date, checkpoint }) => {
    try {
      const payload = await readTotalBasesCheckpoint(date, checkpoint);
      return payload?.status === 'ready' ? { date, checkpoint, rows: payload.rows || [] } : null;
    } catch { return null; }
  }));
  const output = [];
  for (const capture of captures.filter(Boolean)) {
    for (const oddsRow of capture.rows) {
      const prediction = predictionMap.get(`${capture.date}|${compactName(oddsRow.batterName || oddsRow.playerKey)}`);
      if (!prediction) continue;
      const quote = bestOver(oddsRow.odds);
      if (!quote) continue;
      const implied = impliedProbability(quote.americanOdds);
      const probability = Number(prediction.probability);
      const ev = expectedValue(probability, quote.americanOdds);
      output.push({
        date: capture.date, checkpoint: capture.checkpoint, player: prediction.player, hit: Number(prediction.target) === 1,
        probability, odds: quote.americanOdds, book: quote.book, implied, edge: probability - implied, ev,
      });
    }
  }
  return output;
}

function parseWeather(raw) {
  const temperature = Number(raw?.temp);
  const wind = String(raw?.wind || '');
  const match = wind.match(/([0-9.]+)\s*mph/i);
  const speed = match ? Number(match[1]) : 0;
  const lower = wind.toLowerCase();
  return {
    temperature_f: Number.isFinite(temperature) ? temperature : null,
    wind_speed_mph: speed,
    wind_out_mph: lower.includes('out to') ? speed : lower.includes('in from') ? -speed : 0,
    condition: raw?.condition || null,
  };
}

function teamCode(team) {
  return String(team?.abbreviation || team?.teamCode || team?.name || '').toUpperCase().replace(/[^A-Z]/g, '');
}

async function currentSchedule(date) {
  const params = new URLSearchParams({ sportId: '1', gameType: 'R', date, hydrate: 'team,probablePitcher,venue,weather' });
  const response = await fetch(`https://statsapi.mlb.com/api/v1/schedule?${params}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`MLB schedule HTTP ${response.status}`);
  const payload = await response.json();
  const games = new Map();
  for (const dateRow of payload.dates || []) {
    for (const game of dateRow.games || []) {
      const away = teamCode(game?.teams?.away?.team); const home = teamCode(game?.teams?.home?.team);
      if (!away || !home) continue;
      games.set(`${away}@${home}`, {
        away, home, venueId: Number(game?.venue?.id || 0) || null,
        dayGame: String(game?.dayNight || '').toLowerCase() === 'day', weather: parseWeather(game?.weather || {}),
      });
    }
  }
  return games;
}

function matchupKey(value) {
  const parts = String(value || '').split('@').map((part) => part.trim().toUpperCase().replace(/[^A-Z]/g, ''));
  return parts.length === 2 ? `${parts[0]}@${parts[1]}` : null;
}

function liveV2Rows(v1Rows, artifact, state, schedule, date) {
  const parkYear = String(Number(date.slice(0, 4)) - 1);
  const staticData = state.static || {};
  const parks = staticData.parks?.[parkYear] || {};
  const venues = staticData.venues || {};
  const output = [];
  for (const row of v1Rows || []) {
    const batter = state.batters?.[String(row.batterId)];
    const pitcher = state.pitchers?.[String(row.starterId)];
    const game = schedule.get(matchupKey(row.matchup));
    if (!batter || !pitcher || !game) continue;
    const team = String(batter.team || '').toUpperCase();
    const opponentCode = team === game.home ? game.away : team === game.away ? game.home : null;
    const opponent = opponentCode ? state.teams?.[opponentCode] : null;
    const venue = venues[String(game.venueId)] || {};
    const field = venue.field_info || {};
    const factors = parks[String(game.venueId)] || {};
    const context = {
      park: { ...factors, left_center: field.left_center, center: field.center, right_center: field.right_center },
      venue, weather: game.weather, is_home: team === game.home, pitcher_throws: pitcher.throws,
      batter_stand: batter.stand, batter_age: batter.age, local_hour: game.dayGame ? 13 : 19,
    };
    const features = featureRow(batter, pitcher, opponent, context, date);
    const probability = predict(artifact, features);
    const odds = Number(row.bestOver?.americanOdds);
    const implied = impliedProbability(odds);
    if (implied == null) continue;
    output.push({
      batterId: row.batterId, batterName: row.batterName, matchup: row.matchup, gameStartAt: row.gameStartAt,
      v2Probability: Number(probability.toFixed(4)), modelProbability: Number(probability.toFixed(4)), v1Probability: row.modelProbability, formProbability: row.formProbability,
      fairAmerican: fairAmerican(probability), bestOver: row.bestOver,
      impliedProbability: Number(implied.toFixed(4)), probabilityEdge: Number((probability - implied).toFixed(4)),
      expectedValue: Number(expectedValue(probability, odds).toFixed(4)), starterId: row.starterId,
      starterStatePa30: Math.round(num(bucketAt(pitcher, 30, date).pa)),
      researchOnly: true, qualifies: false,
    });
  }
  return output.sort((a, b) => b.expectedValue - a.expectedValue || b.probabilityEdge - a.probabilityEdge);
}

module.exports = async function totalBasesV2Handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
  if (!artifactsReady()) return response.status(503).json({
    status: 'training', kind: 'batter_two_plus_total_bases_model_v2', modelStatus: 'TRAINING',
    providerRequests: 0, quotaObjectsAdded: 0, message: 'Total Bases v2 artifacts are still being built.',
  });

  const loaded = loadArtifacts();
  const date = String(request.query?.date || new Date().toISOString().slice(0, 10));
  const through = addDays(date, -1);
  const cacheKey = `mlbtb2:model:v2:${date}:${String(request.query?.checkpoint || 'latest')}:${through}:${loaded.state.as_of}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) return response.status(200).json(JSON.parse(cached));
  } catch (_) {}

  try {
    const [v1Result, evaluation, schedule] = await Promise.all([
      v1Output(request), archiveEvaluation(loaded.predictions, through), currentSchedule(date),
    ]);
    const calibrationMarket = evaluation.filter((row) => row.date < HOLDOUT_START);
    const holdoutMarket = evaluation.filter((row) => row.date >= HOLDOUT_START);
    const strategy = tuneStrategy(calibrationMarket);
    const select = (rows) => strategy.ready ? rows.filter((row) =>
      (!strategy.checkpoint || row.checkpoint === strategy.checkpoint) && row.edge >= strategy.minEdge && row.ev >= strategy.minEv
    ) : [];
    const calibrationStrategy = strategySummary(select(calibrationMarket));
    const holdoutStrategy = strategySummary(select(holdoutMarket));

    const v1 = v1Result.statusCode === 200 ? v1Result.body : null;
    const offline = loaded.performance.holdout || {};
    const offlineV2Metrics = offline.v2 || {};
    const offlineFormMetrics = offline.form || {};
    const v2ByPlayerDate = new Map((loaded.predictions || []).map((row) => [`${row.date}|${Number(row.batter_id)}`, row]));
    const matchedRows = [];
    for (const row of v1?.validation?.holdoutProbabilityRows || []) {
      const v2Row = v2ByPlayerDate.get(`${row.date}|${Number(row.batterId)}`);
      if (!v2Row || !Number.isFinite(Number(v2Row.probability))) continue;
      matchedRows.push({
        date: row.date, batterId: Number(row.batterId), hit: Number(row.hit),
        v2Probability: Number(v2Row.probability), v1Probability: Number(row.modelProbability), formProbability: Number(row.formProbability),
      });
    }
    const v2Metrics = probabilityMetrics(matchedRows, 'v2Probability');
    const v1Matched = probabilityMetrics(matchedRows, 'v1Probability');
    const formMetrics = probabilityMetrics(matchedRows, 'formProbability');
    const v1Metrics = { ...v1Matched, logLoss: v1Matched.log_loss };
    const sameSplit = String(v1?.split?.holdoutStart || '') === String(offline.start || HOLDOUT_START);
    const probabilityPass = Boolean(
      sameSplit && matchedRows.length >= 500
      && Number.isFinite(Number(v2Metrics.brier)) && Number.isFinite(Number(v1Metrics.brier)) && Number.isFinite(Number(formMetrics.brier))
      && Number(v2Metrics.brier) < Number(v1Metrics.brier) && Number(v2Metrics.brier) < Number(formMetrics.brier)
      && Number(v2Metrics.log_loss) < Number(v1Metrics.logLoss) && Number(v2Metrics.log_loss) < Number(formMetrics.log_loss)
    );
    const bettingPass = Boolean(strategy.ready && holdoutStrategy.bets >= 20 && holdoutStrategy.slates >= 4 && Number(holdoutStrategy.roi) > 0);
    const promoted = probabilityPass && bettingPass;
    const liveRows = v1 ? liveV2Rows(v1.rows || [], loaded.artifact, loaded.state, schedule, date) : [];
    if (promoted) {
      for (const row of liveRows) {
        row.qualifies = Boolean(
          (!strategy.checkpoint || String(v1?.checkpoint) === strategy.checkpoint)
          && row.probabilityEdge >= strategy.minEdge && row.expectedValue >= strategy.minEv
        );
        row.researchOnly = !row.qualifies;
      }
    }

    const output = {
      schemaVersion: 2, kind: 'batter_two_plus_total_bases_model_v2', status: 'ready', generatedAt: new Date().toISOString(),
      date, checkpoint: v1?.checkpoint || request.query?.checkpoint || null, providerRequests: 0, quotaObjectsAdded: 0,
      promoted, modelStatus: promoted ? 'PROMOTED' : 'UNPROMOTED',
      split: { holdoutStart: offline.start || HOLDOUT_START, through: offline.end || loaded.state.as_of, stateAsOf: loaded.state.as_of },
      methodology: {
        probabilityFit: 'HistGradientBoosting on leakage-safe Baseball Savant PA state. Sportsbook odds and book identity are excluded from training, calibration, and hyperparameter selection.',
        features: 'Batter TB/hit/XBH outcome rates plus xBA/xSLG, exit velocity, hard-hit and launch angle; lineup/PA opportunity; opposing-starter contact quality; opponent allowed profile; park factors/dimensions; recorded weather; handedness and home/day context.',
        validation: '2023 trains model selection, 2024 selects hyperparameters/calibrates the historical test, 2025 is a first out-of-time test; the final model trains on 2023-25, calibrates only before Aug 17 2026, and evaluates Aug 17 onward untouched.',
        marketValidation: 'A price/EV rule is selected only on Aug 2-16 archived Total Bases prices and then frozen for Aug 17+ holdout. No extra SportsGameOdds request is made.',
      },
      validation: {
        sameHoldoutAsV1: sameSplit, probabilityPass, bettingPass,
        v2: v2Metrics, v1: v1Metrics, form: formMetrics,
        improvementVsForm: {
          brier: v2Metrics.brier == null || formMetrics.brier == null ? null : Number((formMetrics.brier - v2Metrics.brier).toFixed(5)),
          log_loss: v2Metrics.log_loss == null || formMetrics.log_loss == null ? null : Number((formMetrics.log_loss - v2Metrics.log_loss).toFixed(5)),
        },
        statcastHoldoutAll: { v2: offlineV2Metrics, form: offlineFormMetrics },
        outOfTime2025: loaded.performance.out_of_time_2025 || null,
        strategyRule: strategy.ready ? { checkpoint: strategy.checkpoint, minProbabilityEdge: strategy.minEdge, minExpectedValue: strategy.minEv } : { ready: false },
        calibrationStrategy, holdoutStrategy,
      },
      dataQuality: {
        observations: loaded.performance.observations, stateAsOf: loaded.state.as_of, matchedHoldoutRows: matchedRows.length,
        archiveMarketRows: evaluation.length, calibrationMarketRows: calibrationMarket.length, holdoutMarketRows: holdoutMarket.length,
        liveV1Rows: v1?.rows?.length || 0, liveV2Rows: liveRows.length,
      },
      featureNames: loaded.artifact.feature_names || FEATURE_NAMES,
      selectedParams: loaded.artifact.selected_params || null,
      rows: liveRows.slice(0, 100),
    };
    try { await redisCommand(['SET', cacheKey, JSON.stringify(output), 'EX', 21600]); } catch (_) {}
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({ status: 'error', kind: 'batter_two_plus_total_bases_model_v2', providerRequests: 0, quotaObjectsAdded: 0, message: error instanceof Error ? error.message : String(error) });
  }
};
