const CENTRAL_ODDS_ENDPOINT = "/api/central-odds";
const nativeFetch = window.fetch.bind(window);
const centralRequests = new Map();
const CENTRAL_ODDS_CACHE_MS = 60_000;

function currentTop100Date(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

window.currentTop100Date = currentTop100Date;

function normalizedPlayerKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedCheckpoint(value) {
  const raw = String(value || "").trim().toLowerCase();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 3) return `0${digits}`;
  if (digits.length === 4) return digits;
  return raw;
}

function decimalPrice(american) {
  const value = Number(american);
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

function centralOddsForDate(slateDate, checkpoint = "") {
  const date = String(slateDate || "").trim();
  const checkpointKey = normalizedCheckpoint(checkpoint);
  if (!date) return Promise.reject(new Error("Top 100 slate date is missing"));
  const cacheKey = `${date}:${checkpointKey || "latest"}`;
  const cached = centralRequests.get(cacheKey);
  if (cached && Date.now() - cached.createdAt >= CENTRAL_ODDS_CACHE_MS) centralRequests.delete(cacheKey);
  if (!centralRequests.has(cacheKey)) {
    const parameters = { date };
    if (checkpointKey) parameters.checkpoint = checkpointKey;
    const url = `${CENTRAL_ODDS_ENDPOINT}?${new URLSearchParams(parameters)}`;
    const entry = { createdAt: Date.now(), promise: null };
    entry.promise = nativeFetch(url, { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || `Central odds fetch failed: ${response.status}`);
      }
      if (payload?.date !== date) throw new Error(`Central odds slate mismatch for ${date}`);
      return payload;
    }).catch((error) => {
      if (centralRequests.get(cacheKey) === entry) centralRequests.delete(cacheKey);
      throw error;
    });
    centralRequests.set(cacheKey, entry);
  }
  return centralRequests.get(cacheKey).promise;
}

function mergeCentralOdds(top100, central, requestedCheckpoint = "") {
  if (central?.source !== "mlb-hr-edge-database" || !Array.isArray(central.rows)) {
    throw new Error("Central odds response is not database-backed");
  }
  if (!top100?.slate_date || central.date !== top100.slate_date) {
    throw new Error("Central odds and Top 100 slate dates do not match");
  }
  const expectedCheckpoint = normalizedCheckpoint(requestedCheckpoint);
  if (
    expectedCheckpoint
    && normalizedCheckpoint(central.checkpoint) !== expectedCheckpoint
  ) {
    throw new Error(
      `Central checkpoint mismatch: expected ${expectedCheckpoint}, received ${central.checkpoint || "none"}`,
    );
  }

  const byId = new Map();
  const byName = new Map();
  for (const row of central.rows) {
    if (row?.batterId != null) byId.set(String(row.batterId), row);
    const nameKey = normalizedPlayerKey(row?.batterName);
    if (nameKey) byName.set(nameKey, row);
  }

  const players = (top100.players || []).map((player) => {
    const id = player.batter_id ?? player.player_id ?? player.mlbam_id;
    const row = (id != null ? byId.get(String(id)) : null)
      || byName.get(normalizedPlayerKey(player.player));
    if (!row || !row.odds || typeof row.odds !== "object") return player;

    const prices = Object.entries(row.odds)
      .filter(([, quote]) => quote && Number.isFinite(Number(quote.americanOdds)))
      .map(([book, quote]) => ({
        book,
        odds: Number(quote.americanOdds),
        captured_at: quote.capturedAt || null,
        source_event_id: quote.sourceEventId || null,
        source_odd_id: quote.sourceOddId || null,
      }))
      .sort((a, b) => decimalPrice(b.odds) - decimalPrice(a.odds));

    if (!prices.length) return player;
    const best = prices[0];
    return {
      ...player,
      odds_available: true,
      best_odds: best.odds,
      best_book: best.book,
      odds_captured_at: best.captured_at,
      all_prices: prices,
      matchup: row.matchup || player.matchup,
      game_start_at: row.gameStartAt || player.game_start_at,
      central_provider_call_id: central.providerCallId || null,
      central_provider_response_sha256: central.providerResponseSha256 || null,
    };
  });

  const pricedPlayers = players.filter((player) => player.odds_available).length;
  return {
    ...top100,
    players,
    odds: {
      ...(top100.odds || {}),
      source: "mlb-hr-edge-database",
      endpoint: CENTRAL_ODDS_ENDPOINT,
      database_url: central.databaseUrl || null,
      date: central.date || top100.slate_date || null,
      checkpoint:
        normalizedCheckpoint(central.checkpoint)
        || normalizedCheckpoint(top100.checkpoint)
        || normalizedCheckpoint(top100.odds?.checkpoint)
        || null,
      provider_call_id:
        central.providerCallId || top100.odds?.provider_call_id || null,
      provider_response_sha256:
        central.providerResponseSha256
        || top100.odds?.provider_response_sha256
        || null,
      priced_players: pricedPlayers,
      quote_count: Math.max(
        Number(central.quoteCount || 0),
        Number(top100.odds?.quote_count || 0),
      ),
      refreshed_in_browser: new Date().toISOString(),
    },
  };
}

window.getCentralOddsDatabase = centralOddsForDate;

window.fetch = async function centralDatabaseFetch(input, init) {
  const requested = typeof input === "string" ? input : input?.url || String(input);
  const url = new URL(requested, location.href);
  const isTop100 = url.origin === location.origin
    && ["/data/top100.json", "/api/top100-current"].includes(url.pathname);
  if (!isTop100) return nativeFetch(input, init);

  // The generated file can shadow a Vercel rewrite. Always read the dated API.
  const date = url.searchParams.get("date") || currentTop100Date();
  const liveUrl = `/api/top100-current?${new URLSearchParams({ date })}`;
  const response = await nativeFetch(liveUrl, { ...init, cache: "no-store" });
  if (!response.ok || String(init?.method || input?.method || "GET").toUpperCase() === "HEAD") {
    return response;
  }
  const top100 = await response.clone().json();
  if (top100?.slate_date !== date || !Array.isArray(top100?.players)) {
    return new Response(JSON.stringify({
      status: "not_ready", slate_date: date, players: [],
      message: "The requested Top 100 slate is not available yet.",
    }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  try {
    const checkpoint = normalizedCheckpoint(top100.checkpoint)
      || normalizedCheckpoint(top100.odds?.checkpoint);
    const central = await centralOddsForDate(top100.slate_date, checkpoint);
    const merged = mergeCentralOdds(top100, central, checkpoint);
    return new Response(JSON.stringify(merged), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Odds-Source": "mlb-hr-edge-database",
        "X-Odds-Checkpoint": checkpoint || "latest",
      },
    });
  } catch (error) {
    console.warn("Current-slate odds unavailable; retaining generated checkpoint odds for this verified slate.", error);
    return response;
  }
};
