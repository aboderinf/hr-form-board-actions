# HR Form Board — GitHub Actions edition

Independent cloud-run version of the MLB home-run form tracker. It does not modify or depend on the ChatGPT Scheduled Task site at `hr-form-board.vercel.app`.

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

## Activation

1. Create a new repository and upload this project to its default branch.
2. Enable GitHub Actions with read/write workflow permissions.
3. Import that new repository as a separate Vercel project. Leave the existing `hr-form-board` project connected to its current source.
4. Run `HR form checkpoints` manually once to verify data collection.

No secrets are required for the public-data workflow. A public repository has unmetered standard GitHub Actions usage; a private GitHub Free repository receives a monthly Actions allowance.

## Local checks

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python scripts/render_site.py
```
