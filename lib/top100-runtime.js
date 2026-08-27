const { currentEtDate, redisCommand } = require("./checkpoint-runtime");

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function top100Key(date) {
  if (!validDate(date)) throw new Error("Invalid Top 100 slate date");
  return `mlbhr:top100:${date}`;
}

async function readTop100(date) {
  if (!validDate(date)) return null;
  const raw = await redisCommand(["GET", top100Key(date)]);
  if (!raw) return null;
  const payload = JSON.parse(raw);
  if (payload?.slate_date !== date || !Array.isArray(payload?.players)) return null;
  return payload;
}

module.exports = {
  currentEtDate,
  readTop100,
  top100Key,
  validDate,
};
