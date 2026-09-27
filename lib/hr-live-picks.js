const fs = require("node:fs");
const path = require("node:path");
const { ensureDiscoveryArchive } = require("../lib/discovery-runtime");

const CHECKPOINTS = ["0817", "1117", "1717", "2017"];
const ET = "America/New_York";

const HISTORY_PATH = path.join(process.cwd(), "data", "discovery.json");
const PRIMARY_PATH = path.join(process.cwd(), "data", "hr-picks.json");
const COMPANION_PATH = path.join(process.cwd(), "data", "hr-volume-companion.json");

let cachedHistory = null;
let cachedPrimary = null;
let cachedCompanion = null;

function historyData() {
  if (!cachedHistory) cachedHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  return cachedHistory;
}

function primaryData() {
  if (!cachedPrimary) cachedPrimary = JSON.parse(fs.readFileSync(PRIMARY_PATH, "utf8"));
  return cachedPrimary;
}

function companionData() {
  if (!cachedCompanion) cachedCompanion = JSON.parse(fs.readFileSync(COMPANION_PATH, "utf8"));
  return cachedCompanion;
}

function etDateString(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

function zonedCheckpointMs(slateDate, checkpoint) {
  const [year, month, day] = String(slateDate).split("-").map(Number);
  const hour = Number(String(checkpoint).slice(0, 2));
  const minute = Number(String(checkpoint).slice(2, 4));
  if (![year, month, day, hour, minute].every(Number.isFinite)) return NaN;

  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const read = (type) => Number(parts.find((part) => part.type === type)?.value);
    const shown = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second"),
    );
    guess += desired - shown;
  }
  return guess;
}

function pregameEligible(row) {
  if (row?.game_started_at_checkpoint === true || !row?.game_start_at) return false;
  const start = Date.parse(row.game_start_at);
  const scheduled = zonedCheckpointMs(row.slate_date, String(row.checkpoint || ""));
  return Number.isFinite(start) && Number.isFinite(scheduled) && start > scheduled;
}

function scoreBand(score) {
  const value = Number(score || 0);
  if (value >= 0.40) return "400p";
  if (value >= 0.30) return "300_399";
  if (value >= 0.20) return "200_299";
  if (value >= 0.10) return "100_199";
  return "u100";
}

function scoreBandLabel(ruleId) {
  return {
    "400p": "0.400+",
    "300_399": "0.300–0.399",
    "200_299": "0.200–0.299",
    "100_199": "0.100–0.199",
    "u100": "Below 0.100",
  }[ruleId] || ruleId;
}

function cellKey(row) {
  if (row?.best_odds == null || !row?.best_book) return null;
  return [String(row.checkpoint || ""), String(row.best_book), scoreBand(row.score)].join("|");
}

function summary(rows) {
  const values = Array.from(rows || []);
  const settled = values.filter((row) => row.result === "WIN" || row.result === "LOSS");
  const wins = settled.filter((row) => row.result === "WIN").length;
  const net = settled.reduce((total, row) => total + Number(row.profit_units || 0), 0);
  return {
    settled: settled.length,
    wins,
    losses: settled.length - wins,
    voids: values.filter((row) => row.result === "VOID").length,
    slates: new Set(settled.map((row) => String(row.slate_date || ""))).size,
    net_units: Math.round(net * 1000) / 1000,
    roi: settled.length ? net / settled.length : null,
    hit_rate: settled.length ? wins / settled.length : null,
  };
}

function completePriorRows(rows, target) {
  const prior = (rows || []).filter((row) =>
    row?.best_odds != null
    && row?.best_book
    && pregameEligible(row)
    && String(row.slate_date || "") < target
  );
  const grouped = new Map();
  for (const row of prior) {
    const slate = String(row.slate_date || "");
    if (!grouped.has(slate)) grouped.set(slate, []);
    grouped.get(slate).push(row);
  }
  const complete = new Set(
    [...grouped.entries()]
      .filter(([, values]) => values.length && !values.some((row) => row.result == null || row.result === "PENDING"))
      .map(([slate]) => slate),
  );
  return prior.filter((row) => complete.has(String(row.slate_date || "")));
}

function dateMinusDays(target, days) {
  const [year, month, day] = target.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function windowRows(rows, target, days) {
  const start = dateMinusDays(target, days);
  return rows.filter((row) => {
    const slate = String(row.slate_date || "");
    return slate >= start && slate < target;
  });
}

function qualifyingCells(historyRows, target, checkpoint, availableKeys) {
  const prior = completePriorRows(historyRows, target);
  const trailing14 = windowRows(prior, target, 14);
  const trailing30 = windowRows(prior, target, 30);
  const keys = [...new Set(prior.map(cellKey).filter((key) =>
    key
    && key.startsWith(checkpoint + "|")
    && (!availableKeys || availableKeys.has(key))
  ))].sort();

  const output = [];
  for (const key of keys) {
    const [cp, book, formId] = key.split("|");
    const rowsFor = (values) => values.filter((row) => cellKey(row) === key);
    const evidence = {
      all_time: summary(rowsFor(prior)),
      trailing_30d: summary(rowsFor(trailing30)),
      trailing_14d: summary(rowsFor(trailing14)),
    };
    const all = evidence.all_time;
    const month = evidence.trailing_30d;
    const recent = evidence.trailing_14d;

    if (!(all.settled >= 40 && all.wins >= 4 && all.slates >= 5 && all.net_units > 0)) continue;
    if (!(recent.settled >= 20 && Number(recent.roi || 0) >= 0.10)) continue;
    if (!(month.settled >= 5 && month.net_units > 0)) continue;

    const totalSettled = all.settled + month.settled + recent.settled;
    output.push({
      checkpoint: cp,
      book,
      form_id: formId,
      form: scoreBandLabel(formId),
      label: cp + " · " + book + " best price · " + scoreBandLabel(formId),
      evidence,
      weighted_expected_return: totalSettled
        ? (all.net_units + month.net_units + recent.net_units) / totalSettled
        : null,
    });
  }

  output.sort((a, b) =>
    Number(b.weighted_expected_return || 0) - Number(a.weighted_expected_return || 0)
    || Number(b.evidence?.trailing_14d?.settled || 0) - Number(a.evidence?.trailing_14d?.settled || 0)
    || Number(b.evidence?.all_time?.roi || 0) - Number(a.evidence?.all_time?.roi || 0)
    || String(a.label || "").localeCompare(String(b.label || ""))
  );
  return output.slice(0, 3);
}

function dynamicPick(row, cell) {
  return {
    slate_date: row.slate_date,
    checkpoint: row.checkpoint,
    player: row.player,
    mlbam_id: row.mlbam_id,
    team: row.team,
    matchup: row.matchup,
    rank: row.rank,
    score: row.score,
    odds: row.best_odds,
    book: row.best_book,
    game_start_at: row.game_start_at,
    captured_at: row.captured_at || row.captured_at_et,
    cell: {
      checkpoint: cell.checkpoint,
      book: cell.book,
      form: cell.form,
      label: cell.label,
      evidence: cell.evidence,
    },
    result: "PENDING",
    home_runs: null,
    profit_units: 0,
  };
}

function selectDynamicCheckpoint(historyRows, target, checkpoint, archive, selectedIds) {
  const current = (archive?.entries || []).filter((row) =>
    row?.best_odds != null
    && row?.best_book
    && pregameEligible(row)
  );
  const available = new Set(current.map(cellKey).filter(Boolean));
  const cells = qualifyingCells(historyRows, target, checkpoint, available);
  const byKey = new Map(cells.map((cell) => [
    [cell.checkpoint, cell.book, cell.form_id].join("|"),
    cell,
  ]));

  const ordered = [...current].sort((a, b) =>
    Number(b.score || 0) - Number(a.score || 0)
    || Number(b.best_odds || -999999) - Number(a.best_odds || -999999)
    || Number(a.rank || 999) - Number(b.rank || 999)
    || String(a.player || "").localeCompare(String(b.player || ""))
  );

  const capped = [];
  for (const row of ordered) {
    const cell = byKey.get(cellKey(row));
    if (!cell) continue;
    capped.push([row, cell]);
    if (capped.length >= 2) break;
  }

  const picks = [];
  for (const [row, cell] of capped) {
    const playerId = Number(row.mlbam_id);
    if (!Number.isFinite(playerId) || selectedIds.has(playerId)) continue;
    picks.push(dynamicPick(row, cell));
    selectedIds.add(playerId);
  }
  return { cells, picks };
}

function formMatch(score, ruleId) {
  if (ruleId === "all") return true;
  if (ruleId === "100_199") return score >= 0.1 && score < 0.2;
  if (ruleId === "200_299") return score >= 0.2 && score < 0.3;
  if (ruleId === "300_399") return score >= 0.3 && score < 0.4;
  if (ruleId === "400p") return score >= 0.4;
  if (ruleId === "100p") return score >= 0.1;
  if (ruleId === "200p") return score >= 0.2;
  if (ruleId === "300p") return score >= 0.3;
  return false;
}

function oddsMatch(odds, ruleId) {
  if (ruleId === "all") return true;
  if (ruleId === "u400") return odds < 400;
  if (ruleId === "400_499") return odds >= 400 && odds < 500;
  if (ruleId === "500_599") return odds >= 500 && odds < 600;
  if (ruleId === "600_799") return odds >= 600 && odds < 800;
  if (ruleId === "800_999") return odds >= 800 && odds < 1000;
  if (ruleId === "1000p") return odds >= 1000;
  if (ruleId === "400_599") return odds >= 400 && odds < 600;
  if (ruleId === "400_799") return odds >= 400 && odds < 800;
  if (ruleId === "500_799") return odds >= 500 && odds < 800;
  if (ruleId === "600_999") return odds >= 600 && odds < 1000;
  if (ruleId === "400p") return odds >= 400;
  if (ruleId === "500p") return odds >= 500;
  if (ruleId === "600p") return odds >= 600;
  return false;
}

function bookMatch(book, ruleId) {
  if (ruleId === "all") return true;
  const expected = { FD: "FanDuel", DK: "DraftKings", MGM: "BetMGM" }[ruleId];
  return Boolean(expected) && String(book || "") === expected;
}

function fixedPick(row, mode) {
  return {
    slate_date: row.slate_date,
    checkpoint: row.checkpoint,
    mode,
    player: row.player,
    mlbam_id: row.mlbam_id,
    team: row.team,
    matchup: row.matchup,
    rank: row.rank,
    score: row.score,
    odds: row.best_odds,
    book: row.best_book,
    game_start_at: row.game_start_at,
    captured_at: row.captured_at || row.captured_at_et,
    result: "PENDING",
    home_runs: null,
    profit_units: 0,
  };
}

function selectFixed(archive, rule, mode) {
  if (!archive || !rule) return [];
  const rows = (archive.entries || []).filter((row) => {
    if (String(row.checkpoint || "") !== String(rule.checkpoint || "")) return false;
    if (row.best_odds == null || !pregameEligible(row)) return false;
    const score = Number(row.score || 0);
    const price = Number(row.best_odds);
    return formMatch(score, String(rule.form_id || ""))
      && oddsMatch(price, String(rule.odds_id || ""))
      && bookMatch(row.best_book, String(rule.book_id || ""));
  });
  rows.sort((a, b) =>
    Number(b.score || 0) - Number(a.score || 0)
    || Number(b.best_odds || -999999) - Number(a.best_odds || -999999)
    || Number(a.rank || 999) - Number(b.rank || 999)
    || String(a.player || "").localeCompare(String(b.player || ""))
  );
  return rows.slice(0, Number(rule.top_n || 0)).map((row) => fixedPick(row, mode));
}

async function buildLiveHrPicks(requestedDate) {
  const requested = String(requestedDate || "").trim();
  const slateDate = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : etDateString();
  const archives = {};
  const errors = {};

  for (const checkpoint of CHECKPOINTS) {
    try {
      const archive = await ensureDiscoveryArchive(slateDate, checkpoint);
      if (archive) archives[checkpoint] = archive;
    } catch (error) {
      errors[checkpoint] = error instanceof Error ? error.message : String(error);
    }
  }

  const historyRows = historyData().slice_rows || [];
  const selectedIds = new Set();
  const dynamicCheckpoints = [];
  const dynamicPicks = [];

  for (const checkpoint of CHECKPOINTS) {
    const archive = archives[checkpoint];
    if (!archive) continue;
    const selected = selectDynamicCheckpoint(
      historyRows,
      slateDate,
      checkpoint,
      archive,
      selectedIds,
    );
    dynamicCheckpoints.push({
      checkpoint,
      captured_at: archive.captured_at || null,
      qualified_cells: selected.cells,
      picks: selected.picks,
    });
    dynamicPicks.push(...selected.picks);
  }

  const primaryRule = primaryData().rule || null;
  const companionRule = companionData().rule || null;
  const fixedArchive = archives["1717"] || null;
  const primaryPicks = selectFixed(fixedArchive, primaryRule, "primary");
  const companionPicks = selectFixed(fixedArchive, companionRule, "companion");

  const seen = new Set();
  const portfolioPicks = [];
  for (const pick of [
    ...primaryPicks.map((row) => ({ ...row, strategy: "primary" })),
    ...companionPicks.map((row) => ({ ...row, strategy: "companion" })),
  ]) {
    const key = String(pick.mlbam_id || pick.player || "");
    if (seen.has(key)) continue;
    seen.add(key);
    portfolioPicks.push(pick);
  }

  return {
    schema_version: 1,
    kind: "hr_live_current_picks",
    generated_at: new Date().toISOString(),
    slate_date: slateDate,
    source: "canonical-redis-checkpoints",
    checkpoints: Object.fromEntries(
      CHECKPOINTS.map((checkpoint) => [
        checkpoint,
        archives[checkpoint] ? {
          status: "ready",
          captured_at: archives[checkpoint].captured_at || null,
          provider_call_id: archives[checkpoint].source?.provider_call_id || null,
          priced_rows: Number(archives[checkpoint].priced_rows || 0),
        } : {
          status: "pending",
          error: errors[checkpoint] || null,
        },
      ]),
    ),
    current: {
      dynamic: {
        slate_date: slateDate,
        status: dynamicCheckpoints.length ? "live" : "checkpoint_pending",
        checkpoints: dynamicCheckpoints,
        picks: dynamicPicks,
      },
      primary: {
        slate_date: slateDate,
        checkpoint: "1717",
        status: fixedArchive ? "active" : "checkpoint_pending",
        picks: primaryPicks,
      },
      companion: {
        slate_date: slateDate,
        checkpoint: "1717",
        status: fixedArchive ? "active" : "checkpoint_pending",
        picks: companionPicks,
      },
      portfolio: {
        slate_date: slateDate,
        status: fixedArchive ? "active" : "checkpoint_pending",
        picks: portfolioPicks,
      },
    },
  };
}

module.exports = { buildLiveHrPicks };
