const GAME_LOG_HYDRATE = (season) => `stats(group=[hitting,fielding],type=[gameLog],season=${season})`;
const GAME_LOG_FIELDS = [
  'people', 'id', 'stats', 'group', 'displayName', 'splits', 'date', 'game', 'gamePk',
  'stat', 'totalBases', 'hits', 'doubles', 'triples', 'homeRuns', 'plateAppearances',
  'gamesStarted', 'positionsPlayed', 'code', 'name', 'type', 'abbreviation',
].join(',');

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function totalBases(stat) {
  if (stat?.totalBases != null && Number.isFinite(Number(stat.totalBases))) {
    return Number(stat.totalBases);
  }
  const hits = number(stat?.hits);
  const doubles = number(stat?.doubles);
  const triples = number(stat?.triples);
  const homeRuns = number(stat?.homeRuns);
  const singles = Math.max(0, hits - doubles - triples - homeRuns);
  return singles + 2 * doubles + 3 * triples + 4 * homeRuns;
}

function statGroup(stat) {
  return String(stat?.group?.displayName || stat?.group?.name || '').toLowerCase();
}

function extractBatterGameLogs(person) {
  const output = { hitting: [], fielding: [] };
  for (const stat of person?.stats || []) {
    const group = statGroup(stat);
    if ((group === 'hitting' || group === 'fielding') && Array.isArray(stat?.splits)) {
      output[group].push(...stat.splits);
    }
  }
  return output;
}

function splitGamePk(split) {
  return Number(split?.game?.gamePk || split?.gamePk || 0) || null;
}

function pinchRole(split) {
  return (split?.positionsPlayed || []).some((position) => {
    const code = String(position?.code || '');
    const abbreviation = String(position?.abbreviation || '').toUpperCase();
    return code === '11' || code === '12' || abbreviation === 'PH' || abbreviation === 'PR';
  });
}

function matchingHittingSplit(gameLogs, slateDate, gamePk) {
  const matching = (gameLogs?.hitting || [])
    .filter((split) => String(split?.date || '') === String(slateDate || ''))
    .filter((split) => gamePk == null || splitGamePk(split) === Number(gamePk));
  return matching.length === 1 ? matching[0] : null;
}

function starterStatus(gameLogs, slateDate, gamePk, hittingSplit = null) {
  const allForDate = (gameLogs?.fielding || [])
    .filter((split) => String(split?.date || '') === String(slateDate || ''));
  const matching = gamePk == null
    ? allForDate
    : allForDate.filter((split) => splitGamePk(split) === Number(gamePk));
  const oneGame = gamePk != null || new Set(matching.map(splitGamePk).filter(Boolean)).size <= 1;
  if (matching.length && oneGame) {
    const starts = matching
      .map((split) => Number(split?.stat?.gamesStarted))
      .filter(Number.isFinite);
    if (starts.length) return starts.some((value) => value > 0);
  }

  const appearance = hittingSplit || matchingHittingSplit(gameLogs, slateDate, gamePk);
  if (appearance && pinchRole(appearance)) return false;
  return null;
}

function hittingAppearances(gameLogs, slateDate) {
  return (gameLogs?.hitting || [])
    .filter((split) => String(split?.date || '') === String(slateDate || ''))
    .filter((split) => Number(split?.stat?.plateAppearances || 0) > 0)
    .map((split) => ({
      totalBases: totalBases(split?.stat || {}),
      plateAppearances: number(split?.stat?.plateAppearances),
      gamePk: splitGamePk(split),
      hittingSplit: split,
    }));
}

function settledBatterGame(gameLogs, slateDate) {
  const appearances = hittingAppearances(gameLogs, slateDate);
  if (appearances.length === 0) {
    return {
      status: 'void', reason: 'no_plate_appearance', totalBases: null,
      plateAppearances: 0, appearances: 0, started: null, gamePk: null,
    };
  }
  if (appearances.length > 1) {
    return {
      status: 'ambiguous', reason: 'multiple_same_date_appearances', totalBases: null,
      plateAppearances: null, appearances: appearances.length, started: null, gamePk: null,
    };
  }

  const appearance = appearances[0];
  const started = starterStatus(gameLogs, slateDate, appearance.gamePk, appearance.hittingSplit);
  const settledAppearance = {
    totalBases: appearance.totalBases,
    plateAppearances: appearance.plateAppearances,
    gamePk: appearance.gamePk,
  };
  if (started === false) {
    return {
      status: 'void', reason: 'did_not_start', appearances: 1, started, ...settledAppearance,
    };
  }
  if (started == null) {
    return {
      status: 'unverified', reason: 'starter_status_unavailable', appearances: 1,
      started: null, ...settledAppearance,
    };
  }
  return { status: 'graded', reason: null, appearances: 1, started, ...settledAppearance };
}

module.exports = {
  GAME_LOG_FIELDS,
  GAME_LOG_HYDRATE,
  extractBatterGameLogs,
  number,
  settledBatterGame,
  splitGamePk,
  starterStatus,
  totalBases,
};
