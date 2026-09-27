const fs = require("node:fs");
const path = require("node:path");
const { ensureDiscoveryArchive } = require("../lib/discovery-runtime");
const { checkpointTargetUtc, currentEtDate } = require("../lib/checkpoint-runtime");

const CHECKPOINTS = ["0817", "1117", "1717", "2017"];
const SCORE_BANDS = [
  ["400p", "0.400+"],
  ["300_399", "0.300–0.399"],
  ["200_299", "0.200–0.299"],
  ["100_199", "0.100–0.199"],
  ["u100", "Below 0.100"],
];

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relPath), "utf8"));
}

function scoreBand(score) {
  const value = Number(score || 0);
  if (value >= 0.40) return "400p";
  if (value >= 0.30) return "300_399";
  if (value >= 0.20) return "200_299";
  if (value >= 0.10) return "100_199";
  return "u100";
}

function scoreBandLabel(id) {
  return (SCORE_BANDS.find(([value]) => value === id) || [id, id])[1];
}

function pregameEligible(row) {
  if (row?.game_started_at_checkpoint === true || !row?.game_start_at) return false;
  try {
    return new Date(row.game_start_at).getTime() >
      checkpointTargetUtc(String(row.slate_date || ""), String(row.checkpoint || "")).getTime();
  } catch {
    return false;
  }
}

function cellKey(row) {
  if (row?.best_odds == null || !row?.best_book) return null;
  return [String(row.checkpoint || ""), String(row.best_book), scoreBand(row.score)].join("|");
}

function summarize(rows) {
  const values = Array.from(rows || []);
  const settled = values.filter((row) => row.result === "WIN" || row.result === "LOSS");
  const wins = settled.filter((row) => row.result === "WIN").length;
  const net = settled.reduce((sum, row) => sum + Number(row.profit_units || 0), 0);
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

function addDays(dateIso, days) {
  const date = new Date(dateIso + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function completePriorRows(rows, target) {
  const prior = rows.filter((row) =>
    row?.best_odds != null &&
    row?.best_book &&
    pregameEligible(row) &&
    String(row.slate_date || "") < target
  );
  const bySlate = new Map();
  for (const row of prior) {
    const slate = String(row.slate_date || "");
    if (!bySlate.has(slate)) bySlate.set(slate, []);
    bySlate.get(slate).push(row);
  }
  const complete = new Set(
    [...bySlate.entries()]
      .filter(([, values]) => values.length && !values.some((row) => row.result == null || row.result === "PENDING"))
      .map(([slate]) => slate)
  );
  return prior.filter((row) => complete.has(String(row.slate_date || "")));
}

function windowRows(rows, target, days) {
  const start = addDays(target, -days);
  return rows.filter((row) => {
    const slate = String(row.slate_date || "");
    return slate >= start && slate < target;
  });
}

function qualifyingCells(rows, target, checkpoint, availableKeys) {
  const prior = completePriorRows(rows, target);
  const trailing14 = windowRows(prior, target, 14);
  const trailing30 = windowRows(prior, target, 30);
  const keys = [...new Set(
    prior
      .map(cellKey)
      .filter((key) => key && key.startsWith(checkpoint + "|") && availableKeys.has(key))
  )].sort();

  const output = [];
  for (const key of keys) {
    const [cp, book, formId] = key.split("|");
    const subset = (values) => values.filter((row) => cellKey(row) === key);
    const evidence = {
      all_time: summarize(subset(prior)),
      trailing_30d: summarize(subset(trailing30)),
      trailing_14d: summarize(subset(trailing14)),
    };
    const all = evidence.all_time;
    const month = evidence.trailing_30d;
    const recent = evidence.trailing_14d;
    if (!(all.settled >= 40 && all.wins >= 4 && all.slates >= 5 && all.net_units > 0)) continue;
    if (!(recent.settled >= 20 && Number(recent.roi || 0) >= 0.10)) continue;
    if (!(month.settled >= 5 && month.net_units > 0)) continue;

    const total = all.settled + month.settled + recent.settled;
    output.push({
      checkpoint: cp,
      book,
      form_id: formId,
      form: scoreBandLabel(formId),
      label: cp + " · " + book + " best price · " + scoreBandLabel(formId),
      evidence,
      weighted_expected_return: total
        ? (all.net_units + month.net_units + recent.net_units) / total
        : null,
    });
  }

  output.sort((a, b) =>
    Number(b.weighted_expected_return || 0) - Number(a.weighted_expected_return || 0) ||
    Number(b.evidence.trailing_14d.settled || 0) - Number(a.evidence.trailing_14d.settled || 0) ||
    Number(b.evidence.all_time.roi || 0) - Number(a.evidence.all_time.roi || 0) ||
    String(a.label).localeCompare(String(b.label))
  );
  return output.slice(0, 3);
}

function toDynamicPick(row, cell) {
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

function selectDynamicCheckpoint(rows, target, checkpoint, selectedIds) {
  const current = rows.filter((row) =>
    String(row.slate_date || "") === target &&
    String(row.checkpoint || "") === checkpoint &&
    row.best_odds != null &&
    row.best_book &&
    pregameEligible(row)
  );
  const available = new Set(current.map(cellKey).filter(Boolean));
  const cells = qualifyingCells(rows, target, checkpoint, available);
  const byKey = new Map(cells.map((cell) => [
    [cell.checkpoint, cell.book, cell.form_id].join("|"),
    cell,
  ]));
  const ordered = [...current].sort((a, b) =>
    Number(b.score || 0) - Number(a.score || 0) ||
    Number(b.best_odds || -999999) - Number(a.best_odds || -999999) ||
    Number(a.rank || 999) - Number(b.rank || 999) ||
    String(a.player || "").localeCompare(String(b.player || ""))
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
    const id = Number(row.mlbam_id);
    if (!Number.isFinite(id) || selectedIds.has(id)) continue;
    picks.push(toDynamicPick(row, cell));
    selectedIds.add(id);
  }
  return { cells, picks };
}

function matchForm(row, id) {
  const score = Number(row.score || 0);
  if (id === "100_199") return score >= 0.10 && score < 0.20;
  if (id === "200p") return score >= 0.20;
  if (id === "300_399") return score >= 0.30 && score < 0.40;
  if (id === "400p") return score >= 0.40;
  if (id === "all") return true;
  return scoreBand(score) === id;
}

function matchOdds(row, id) {
  const value = Number(row.best_odds);
  if (!Number.isFinite(value)) return false;
  if (id === "400_499") return value >= 400 && value < 500;
  if (id === "u400") return value < 400;
  if (id === "600p") return value >= 600;
  if (id === "400p") return value >= 400;
  return true;
}

function matchBook(row, id) {
  if (!id || id === "all") return true;
  if (id === "DK") return row.best_book === "DraftKings";
  if (id === "FD") return row.best_book === "FanDuel";
  if (id === "BMGM") return row.best_book === "BetMGM";
  return true;
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

function selectFixed(entries, rule, mode) {
  if (!rule) return [];
  return entries
    .filter((row) =>
      String(row.checkpoint || "") === String(rule.checkpoint || "") &&
      row.best_odds != null &&
      row.best_book &&
      pregameEligible(row) &&
      matchForm(row, rule.form_id) &&
      matchOdds(row, rule.odds_id) &&
      matchBook(row, rule.book_id)
    )
    .sort((a, b) =>
      Number(b.score || 0) - Number(a.score || 0) ||
      Number(b.best_odds || -999999) - Number(a.best_odds || -999999) ||
      Number(a.rank || 999) - Number(b.rank || 999) ||
      String(a.player || "").localeCompare(String(b.player || ""))
    )
    .slice(0, Number(rule.top_n || 0))
    .map((row) => fixedPick(row, mode));
}

function sameDaySnapshots(dynamicStatic, slateDate) {
  return (((dynamicStatic || {}).forward || {}).snapshots || [])
    .filter((snapshot) => String(snapshot.slate_date || "") === slateDate);
}

async function handleLiveHrPicks(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  try {
    const now = new Date();
    const slateDate = String(request.query?.date || currentEtDate(now));
    const discovery = readJson("data/discovery.json");
    const primaryStatic = readJson("data/hr-picks.json");
    const companionStatic = readJson("data/hr-volume-companion.json");
    const dynamicStatic = readJson("data/hr-dynamic-daily.json");

    const archives = {};
    for (const checkpoint of CHECKPOINTS) {
      const target = checkpointTargetUtc(slateDate, checkpoint);
      if (target.getTime() > now.getTime()) continue;
      try {
        const archive = await ensureDiscoveryArchive(slateDate, checkpoint);
        if (archive) archives[checkpoint] = archive;
      } catch (error) {
        archives[checkpoint] = {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const currentRows = Object.entries(archives)
      .filter(([, archive]) => Array.isArray(archive?.entries))
      .flatMap(([, archive]) => archive.entries);
    const historicalRows = Array.isArray(discovery.slice_rows) ? discovery.slice_rows : [];
    const allRows = historicalRows.concat(currentRows);

    const dynamicSnapshots = [];
    const selectedIds = new Set();
    const staticByCheckpoint = new Map(
      sameDaySnapshots(dynamicStatic, slateDate)
        .map((snapshot) => [String(snapshot.checkpoint || ""), snapshot])
    );

    for (const checkpoint of CHECKPOINTS) {
      const staticSnapshot = staticByCheckpoint.get(checkpoint);
      if (staticSnapshot) {
        const picks = Array.isArray(staticSnapshot.selections) ? staticSnapshot.selections : [];
        dynamicSnapshots.push({
          checkpoint,
          source: "frozen-static",
          qualified_cells: staticSnapshot.qualified_cells || [],
          picks,
        });
        for (const pick of picks) {
          const id = Number(pick.mlbam_id);
          if (Number.isFinite(id)) selectedIds.add(id);
        }
        continue;
      }
      const archive = archives[checkpoint];
      if (!Array.isArray(archive?.entries)) continue;
      const selected = selectDynamicCheckpoint(allRows, slateDate, checkpoint, selectedIds);
      dynamicSnapshots.push({
        checkpoint,
        source: "canonical-live",
        qualified_cells: selected.cells,
        picks: selected.picks,
      });
    }

    const cp1717 = archives["1717"];
    const fixedRows = Array.isArray(cp1717?.entries) ? cp1717.entries : [];
    const primaryPicks = fixedRows.length
      ? selectFixed(fixedRows, primaryStatic.rule, "primary")
      : [];
    const companionPicks = fixedRows.length
      ? selectFixed(fixedRows, companionStatic.rule, "companion")
      : [];

    const seen = new Set();
    const portfolioPicks = [];
    for (const pick of primaryPicks.concat(companionPicks)) {
      const key = String(pick.mlbam_id || pick.player || "");
      if (seen.has(key)) continue;
      seen.add(key);
      portfolioPicks.push({ ...pick, strategy: pick.mode });
    }

    const dynamicPicks = dynamicSnapshots.flatMap((snapshot) => snapshot.picks || []);
    const has1717 = Array.isArray(cp1717?.entries);
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({
      status: "ok",
      slate_date: slateDate,
      generated_at: new Date().toISOString(),
      source: "canonical-checkpoint-live",
      checkpoints: Object.fromEntries(
        Object.entries(archives).map(([checkpoint, archive]) => [
          checkpoint,
          {
            status: Array.isArray(archive?.entries) ? "ready" : (archive?.status || "unavailable"),
            captured_at: archive?.captured_at || null,
            provider_call_id: archive?.source?.provider_call_id || null,
            priced_rows: archive?.priced_rows ?? null,
          },
        ])
      ),
      dynamic: {
        slate_date: slateDate,
        status: dynamicSnapshots.length ? "live" : "checkpoint_pending",
        checkpoints: dynamicSnapshots,
        picks: dynamicPicks,
      },
      primary: {
        slate_date: slateDate,
        checkpoint: "1717",
        status: has1717 ? "active" : "checkpoint_pending",
        picks: primaryPicks,
      },
      companion: {
        slate_date: slateDate,
        checkpoint: "1717",
        status: has1717 ? "active" : "checkpoint_pending",
        picks: companionPicks,
      },
      portfolio: {
        slate_date: slateDate,
        status: has1717 ? "active" : "checkpoint_pending",
        picks: portfolioPicks,
      },
    });
  } catch (error) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(500).json({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

module.exports = { handleLiveHrPicks };
