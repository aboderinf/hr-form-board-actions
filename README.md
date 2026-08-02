# HR Form Board — GitHub Actions edition

Independent cloud-run version of the MLB home-run form tracker. It does not modify or depend on the ChatGPT Scheduled Task site at `hr-form-board.vercel.app`.

## Status

The repository is populated and the GitHub Actions workflow is installed. The independent dashboard is available at `hr-form-board-actions.vercel.app`.

## Locked model

`0.50 × (HR-game rate L5) + 0.30 × (HR-game rate L7) + 0.20 × (HR-game rate L15)`

The windows are cumulative. A multi-home-run game counts as one HR game for the score. Same-day games are never used in another same-day checkpoint.

## Single shared odds source

This repository never calls SportsGameOdds, DraftKings, FanDuel, BetMGM, Vegas Insider, or another sportsbook source directly.

Only `aboderinf/mlb-hr-fair-odds-v1` is allowed to make the single provider request for a checkpoint. That project publishes the verified FanDuel, DraftKings, and BetMGM 1+ HR snapshot into the user-owned MLB HR Edge database. This tracker then reads:

`https://mlb-hr-edge.feranmi.chatgpt.site/api/odds?date=YYYY-MM-DD&asOf=<checkpoint timestamp>`

The `asOf` cutoff ensures a delayed retry cannot use prices captured after the frozen checkpoint. If the shared source is pending or unavailable, the tracker records that status and does not scrape, infer, or substitute prices.

## Daily operation

GitHub Actions checks at 8:17 AM, 11:17 AM, 5:17 PM and 8:17 PM America/New_York. The central odds source refreshes five minutes earlier. Because GitHub cron uses UTC, the workflow contains both DST and standard-time expressions; the Python runner gates to the correct ET checkpoint and immutable filenames prevent duplicate snapshots.

At each checkpoint it:

1. Settles earlier frozen picks using MLB game logs.
2. Reads the shared, timestamped MLB HR Edge odds snapshot.
3. Uses exact MLB batter IDs, game IDs, game starts, sportsbook names, prices, capture times, source event IDs, and source odd IDs.
4. Loads prior MLB PA-games and calculates the cumulative L5/L7/L15 score.
5. Excludes games already started at the checkpoint.
6. Keeps players whose best verified FanDuel, DraftKings, or BetMGM 1+ HR price is at least +500.
7. Freezes separate Top 10 and Top 20 portfolios.
8. Commits JSON ledgers and a rebuilt static dashboard.

Prices are never guessed. A missing DraftKings quote remains unavailable rather than being inferred.

## GitHub settings

The workflow needs **Read and write permissions** under **Settings → Actions → General → Workflow permissions** so it can commit updated ledgers and `index.html`.

The separate Vercel project should be connected to this repository so every Action commit triggers a deployment. The existing `hr-form-board` project must remain connected to its current source.

## Manual verification

Open **Actions → HR form checkpoints → Run workflow**. A manual date and checkpoint can be supplied, or left blank for the current scheduled checkpoint.

## Local checks

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python scripts/render_site.py
```
