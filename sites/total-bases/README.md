# MLB 2+ Total Bases standalone site

This directory is a separate static Vercel site. Set the Vercel project Root Directory to:

`sites/total-bases`

The site contains no SportsGameOdds or Redis credentials. It reads the shared, read-only Total Bases form API from the existing checkpoint infrastructure, so creating this site adds zero SportsGameOdds provider calls.

Recommended Vercel project name: `mlb-2plus-total-bases`

The production UI should be deployed from `main` after CI passes. The existing HR/strikeouts project should continue to use the repository root and does not serve the Total Bases UI.
