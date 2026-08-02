# HR Form Board — GitHub Actions edition

Independent cloud-run version of the MLB home-run form tracker. It does not modify or depend on the ChatGPT Scheduled Task site at `hr-form-board.vercel.app`.

## Status

The repository is populated and the GitHub Actions workflow is installed. The independent dashboard is available at `hr-form-board-actions.vercel.app`.

## Locked model

`0.50 × (HR-game rate L5) + 0.30 × (HR-game rate L7) + 0.20 × (HR-game rate L15)`

The windows are cumulative. A multi-home-run game counts as one HR game for the score. Same-day games are never used in another same-day checkpoint.

## Daily operation

GitHub Actions checks at 8:17 AM, 11:17 AM, 5:17 PM and 8:17 PM America/New_York. Because GitHub cron uses UTC, the workflow contains both DST and standard-time expressions; the Python runner gates to the correct ET checkpoint and immutable filenames prevent duplicate snapshots.

At each checkpoint it:

1. Settles earlier frozen picks using MLB game logs.
2. Reads the current Vegas Insider home-run comparison table.
3. Reads official DraftKings Network 1+ HR rows when available.
4. Resolves MLB player IDs, schedules and prior 15 PA-games.
5. Excludes games already started.
6. Keeps players whose best verified displayed 1+ HR price is at least +500.
7. Freezes separate Top 10 and Top 20 portfolios.
8. Commits JSON ledgers and a rebuilt static dashboard.

Unknown sportsbook headers are labeled `unidentified`; prices are never guessed. DraftKings absence is labeled unverified.

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
