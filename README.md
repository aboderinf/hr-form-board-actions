# HR Form Board — GitHub Actions edition

Independent cloud-run version of the MLB home-run form tracker. The dashboard is available at `hr-form-board-actions.vercel.app`.

## Locked model

`0.50 × (HR-game rate L5) + 0.30 × (HR-game rate L7) + 0.20 × (HR-game rate L15)`

The windows are cumulative. A multi-home-run game counts as one HR game for the score. Same-day games are never used in another same-day checkpoint.

## One provider call, one central database

Only `aboderinf/mlb-hr-fair-odds-v1` may call SportsGameOdds. For each enabled checkpoint it makes at most one provider request and immediately writes the returned payload to the MLB HR Edge hosted database.

The three public surfaces then read that same database-backed source:

- `https://mlb-hr-edge.feranmi.chatgpt.site`
- `https://hr-form-board-actions.vercel.app`
- `https://hr-form-board.vercel.app`

This repository never calls SportsGameOdds, DraftKings, FanDuel, BetMGM, Vegas Insider, or another sportsbook provider directly. It reads only public MLB HR Edge database endpoints such as:

`https://mlb-hr-edge.feranmi.chatgpt.site/api/odds?date=YYYY-MM-DD&checkpoint=0817`

Compatibility reads may use `date` plus `asOf`, or the database-backed `/api/dashboard` route. GitHub Pages, repository-to-repository JSON handoffs, and previously materialized local files are not accepted as source data.

After validating the requested date, checkpoint, provider call ID, and response hash, the workflow writes a static consumer cache under `data/shared-odds`. That cache allows Vercel to serve the board efficiently, but it is derived from the central database and is never used to satisfy a new checkpoint before the database is checked.

No `FORM_BOARD_REPO_TOKEN` is required. The only sportsbook credential is `SPORTSGAMEODDS_API_KEY`, stored in the central source repository.

## Daily operation

GitHub Actions resolves the intended Eastern Time checkpoint from the scheduled cron instant, so delayed GitHub runners retain the correct checkpoint. The enabled checkpoints are 8:17 AM, 11:17 AM, 5:17 PM, and 8:17 PM ET.

At each checkpoint it:

1. Waits for the exact central database record.
2. Verifies its slate date, checkpoint, provider call ID, and SHA-256 response identity.
3. Settles earlier frozen picks using official MLB game logs.
4. Loads prior MLB PA-games and calculates the cumulative L5/L7/L15 score.
5. Excludes games already started at the checkpoint.
6. Keeps players whose best verified FanDuel, DraftKings, or BetMGM 1+ HR price is at least +500.
7. Freezes separate Top 10 and Top 20 portfolios.
8. Rebuilds the Today, Top 100 Scores, Discovery, Tracker, and Data surfaces in one atomic commit.

Prices are never guessed. A missing DraftKings quote remains unavailable rather than being inferred.

## GitHub settings

The workflow needs **Read and write permissions** under **Settings → Actions → General → Workflow permissions** so it can commit updated ledgers and generated site data.

The Vercel project is connected to this repository, so each successful Action commit triggers deployment.

## Manual verification

Open **Actions → Source-driven Form Board refresh → Run workflow** and supply a slate date and checkpoint. The workflow must find the matching central database record; it does not make or retry a sportsbook provider request.

## Local checks

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python scripts/render_site.py
```
