from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing patch target: {label}")
    return text.replace(old, new, 1)


v1 = Path("lib/total-bases-model-handler.js")
text = v1.read_text()
text = replace_once(text, "const MODEL_VERSION = 'v1.2';", "const MODEL_VERSION = 'v1.3';", "v1 version")
text = replace_once(text, "      kind: 'batter_two_plus_total_bases_model_v1_2',", "      kind: 'batter_two_plus_total_bases_model_v1_3',", "v1 kind")
text = replace_once(
    text,
    "    const holdoutMarketRows = archiveEvaluation.filter((row) => holdoutStart && row.date >= holdoutStart && row.date <= through);\n    const strategy = tuneStrategy(calibrationMarketRows);",
    "    const holdoutMarketRows = archiveEvaluation.filter((row) => holdoutStart && row.date >= holdoutStart && row.date <= through);\n    const holdoutProbabilityByPlayerDate = new Map();\n    for (const row of holdoutMarketRows) {\n      const key = `${row.date}|${row.batterId}`;\n      if (!holdoutProbabilityByPlayerDate.has(key)) {\n        holdoutProbabilityByPlayerDate.set(key, {\n          date: row.date, batterId: row.batterId, batterName: row.batterName, hit: row.hit,\n          modelProbability: row.modelProbability, formProbability: row.formProbability,\n        });\n      }\n    }\n    const holdoutProbabilityRows = [...holdoutProbabilityByPlayerDate.values()];\n    const strategy = tuneStrategy(calibrationMarketRows);",
    "v1 matched rows",
)
text = replace_once(
    text,
    "        holdoutByCheckpoint: byCheckpoint,\n      },",
    "        holdoutByCheckpoint: byCheckpoint,\n        holdoutProbabilityRows,\n      },",
    "v1 output rows",
)
v1.write_text(text)

v2 = Path("lib/total-bases-v2-handler.js")
text = v2.read_text()
marker = "function strategySummary(rows) {\n"
metrics_fn = """function probabilityMetrics(rows, field) {
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
"""
text = replace_once(text, marker, metrics_fn, "v2 metrics function")
old = """    const v1 = v1Result.statusCode === 200 ? v1Result.body : null;
    const offline = loaded.performance.holdout || {};
    const v2Metrics = offline.v2 || {};
    const formMetrics = offline.form || {};
    const v1Metrics = v1?.validation?.modelProbability || {};
    const sameSplit = String(v1?.split?.holdoutStart || '') === String(offline.start || HOLDOUT_START);
    const probabilityPass = Boolean(
      sameSplit
      && Number.isFinite(Number(v2Metrics.brier)) && Number.isFinite(Number(v1Metrics.brier)) && Number.isFinite(Number(formMetrics.brier))
      && Number(v2Metrics.brier) < Number(v1Metrics.brier) && Number(v2Metrics.brier) < Number(formMetrics.brier)
      && Number(v2Metrics.log_loss) < Number(v1Metrics.logLoss) && Number(v2Metrics.log_loss) < Number(formMetrics.log_loss)
    );"""
new = """    const v1 = v1Result.statusCode === 200 ? v1Result.body : null;
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
    );"""
text = replace_once(text, old, new, "v2 matched comparison")
text = replace_once(
    text,
    "        v2: v2Metrics, v1: v1Metrics, form: formMetrics,\n        improvementVsForm: offline.improvement_vs_form || null,\n        outOfTime2025: loaded.performance.out_of_time_2025 || null,",
    "        v2: v2Metrics, v1: v1Metrics, form: formMetrics,\n        improvementVsForm: {\n          brier: v2Metrics.brier == null || formMetrics.brier == null ? null : Number((formMetrics.brier - v2Metrics.brier).toFixed(5)),\n          log_loss: v2Metrics.log_loss == null || formMetrics.log_loss == null ? null : Number((formMetrics.log_loss - v2Metrics.log_loss).toFixed(5)),\n        },\n        statcastHoldoutAll: { v2: offlineV2Metrics, form: offlineFormMetrics },\n        outOfTime2025: loaded.performance.out_of_time_2025 || null,",
    "v2 validation output",
)
text = replace_once(
    text,
    "        observations: loaded.performance.observations, stateAsOf: loaded.state.as_of,\n        archiveMarketRows: evaluation.length, calibrationMarketRows: calibrationMarket.length, holdoutMarketRows: holdoutMarket.length,",
    "        observations: loaded.performance.observations, stateAsOf: loaded.state.as_of, matchedHoldoutRows: matchedRows.length,\n        archiveMarketRows: evaluation.length, calibrationMarketRows: calibrationMarket.length, holdoutMarketRows: holdoutMarket.length,",
    "v2 data quality",
)
v2.write_text(text)
