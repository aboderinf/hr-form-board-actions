const { envFirst } = require("./checkpoint-runtime");

function trimBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function candidates() {
  const genericToken = envFirst("QSTASH_TOKEN");
  const rows = [
    [envFirst("QSTASH_URL"), genericToken],
    [envFirst("US_EAST_1_QSTASH_URL"), envFirst("US_EAST_1_QSTASH_TOKEN", "QSTASH_TOKEN")],
    [envFirst("EU_CENTRAL_1_QSTASH_URL"), envFirst("EU_CENTRAL_1_QSTASH_TOKEN", "QSTASH_TOKEN")],
    ["https://qstash.upstash.io", genericToken],
    ["https://qstash-us-east-1.upstash.io", genericToken],
    ["https://qstash-eu-central-1.upstash.io", genericToken],
  ];
  const seen = new Set();
  return rows
    .map(([base, token]) => ({ base: trimBase(base), token: String(token || "").trim() }))
    .filter(({ base, token }) => {
      const key = `${base}|${token.slice(0, 8)}`;
      if (!base || !token || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function resolveQstash() {
  const errors = [];
  for (const candidate of candidates()) {
    try {
      const response = await fetch(`${candidate.base}/v2/schedules`, {
        headers: { Authorization: `Bearer ${candidate.token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(payload)) {
        return { ...candidate, schedules: payload };
      }
      errors.push(`${candidate.base}: ${payload?.error || `HTTP ${response.status}`}`);
    } catch (error) {
      errors.push(`${candidate.base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No working QStash region endpoint: ${errors.join(" | ")}`);
}

module.exports = { candidates, resolveQstash };
