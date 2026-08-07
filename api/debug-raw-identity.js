const zlib = require("node:zlib");
const { normalizeCheckpoint, redisCommand } = require("../lib/checkpoint-runtime");

module.exports = async function handler(request, response) {
  const date = String(request.query?.date || "");
  const checkpoint = normalizeCheckpoint(request.query?.checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checkpoint) {
    return response.status(400).json({ error: "invalid date/checkpoint" });
  }
  const stored = await redisCommand(["GET", `mlbhr:raw:${date}:${checkpoint}`]);
  if (!stored) return response.status(404).json({ error: "raw checkpoint not found" });
  const archive = JSON.parse(stored);
  const raw = JSON.parse(zlib.gunzipSync(Buffer.from(archive.responseGzipBase64, "base64")).toString("utf8"));
  const rows = [];
  for (const event of raw?.data || []) {
    for (const [oddKey, oddValue] of Object.entries(event?.odds || {})) {
      const odd = oddValue || {};
      const stat = String(odd.statID || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!["battinghomeruns", "homeruns", "batterhomeruns"].includes(stat)) continue;
      const side = String(odd.sideID || "").toLowerCase();
      const betType = String(odd.betTypeID || "").toLowerCase();
      if (!((betType === "yn" && side === "yes") || (betType === "ou" && side === "over"))) continue;
      rows.push({
        eventID: event.eventID || null,
        oddKey,
        oddID: odd.oddID || null,
        statEntityID: odd.statEntityID || null,
        books: Object.fromEntries(Object.entries(odd.byBookmaker || {}).filter(([book]) => ["fanduel", "draftkings", "betmgm"].includes(String(book).toLowerCase())).map(([book, value]) => [book, value?.odds ?? null])),
      });
    }
  }
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ date, checkpoint, responseSha256: archive.responseSha256, rows });
};
