# MLB Doubles site

Standalone static frontend for the MLB batter 1+ double workflow.

Deploy with the project Root Directory set to `sites/doubles`. The frontend has no SportsGameOdds credential and makes zero provider calls. It reads the shared `hr-form-board-actions` backend, which derives doubles prices from the immutable raw 08:17 / 11:17 / 17:17 / 20:17 checkpoint archives.

## Phases

1. **Form** — current offered hitters ranked only by recent double-game form (50% L5 / 30% L7 / 20% L15, fixed denominators). Price is excluded from the score.
2. **Discovery** — accumulate and settle archived doubles prices, then test checkpoint, sportsbook, form-band and odds-band effects with chronological holdout validation.
3. **Model** — train only after the settled archive is large enough for an honest out-of-time comparison against the form baseline.

Backend routes:
- `/api/doubles-odds`
- `/api/doubles-form`
