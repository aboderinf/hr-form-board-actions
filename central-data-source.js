const CENTRAL_ODDS_ENDPOINT = "/api/central-odds";
const nativeFetch = window.fetch.bind(window);
const centralRequests = new Map();

function normalizedPlayerKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function decimalPrice(american) {
  const value = Number(american);
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

function centralOddsForDate(slateDate) {
  const date = String(slateDate || "").trim();
  if (!date) return Promise.reject(new Error("Top 100 slate date is missing"));
  if (!centralRequests.has(date)) {
    const url = `${CENTRAL_ODDS_ENDPOINT}?${new URLSearchParams({ date })}`;
    centralRequests.set(
      date,
      nativeFetch(url, { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error(`Central odds fetch failed: ${response.status}`);
        return response.json();
      }),
    );
  }
  return centralRequests.get(date);
}

function mergeCentralOdds(top100, central) {
  if (central?.source !== "mlb-hr-edge-database" || !Array.isArray(central.rows)) {
    throw new Error("Central odds response is not database-backed");
  }

  const byId = new Map();
  const byName = new Map();
  for (const row of central.rows) {
    if (row?.batterId != null) byId.set(String(row.batterId), row);
    const nameKey = normalizedPlayerKey(row?.batterName);
    if (nameKey) byName.set(nameKey, row);
  }

  let pricedPlayers = 0;
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
    pricedPlayers += 1;
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

  return {
    ...top100,
    players,
    odds: {
      ...(top100.odds || {}),
      source: "mlb-hr-edge-database",
      endpoint: CENTRAL_ODDS_ENDPOINT,
      database_url: central.databaseUrl || null,
      date: central.date || null,
      checkpoint: central.checkpoint || null,
      provider_call_id: central.providerCallId || null,
      provider_response_sha256: central.providerResponseSha256 || null,
      priced_players: pricedPlayers,
      quote_count: Number(central.quoteCount || 0),
      refreshed_in_browser: new Date().toISOString(),
    },
  };
}

window.getCentralOddsDatabase = centralOddsForDate;

window.fetch = async function centralDatabaseFetch(input, init) {
  const response = await nativeFetch(input, init);
  const requested = typeof input === "string" ? input : input?.url || "";
  const url = new URL(requested, location.href);
  if (url.origin !== location.origin || url.pathname !== "/data/top100.json" || !response.ok) {
    return response;
  }

  try {
    const top100 = await response.clone().json();
    const central = await centralOddsForDate(top100.slate_date);
    const merged = mergeCentralOdds(top100, central);
    return new Response(JSON.stringify(merged), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Odds-Source": "mlb-hr-edge-database",
      },
    });
  } catch (error) {
    console.warn("Central database overlay unavailable; retaining last generated Top 100 data.", error);
    return response;
  }
};
