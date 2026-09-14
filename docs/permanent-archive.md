# Permanent MLB archive rollout

The default is `ARCHIVE_MODE=off`. Deploying this code alone does not migrate,
delete, or expire existing history. Activation requires a private R2 bucket and
server-side credentials. No R2 bucket, credentials, or retention changes are
created by this source change.

## Storage behavior

| Data | Permanent home after activation | Redis retention |
| --- | --- | --- |
| Original provider captures and capture failures | Private R2, every content version | At most 14 days from the capture date |
| HR, strikeout, 2+ bases, triples and doubles checkpoints | Private R2, every content version | At most 14 days from the capture date |
| HR Discovery projections and daily Top 100 | Private R2 | At most 14 days from the slate date |
| Triples model outputs, state parts and state pointers | Private R2, versioned by checksum | At most 14 days |
| Frozen 2+ bases selections | Private R2; create-once pointer | At most 14 days from the slate date |
| Existing Git ledgers and native Sites D1 rule ledgers | Their existing Git/D1 stores | Not managed by this retention policy |
| Credentials and short-lived calculation caches | Existing secret/cache stores | Never exported to R2 |

Every record is stored under `mlb-archive/v1/records/<base64url Redis key>/`.
`versions/<sha256>.json.gz` contains the exact Redis wire string plus a checksum
and archival timestamp; `head.json` is a conditional-write current pointer.
Versions have no automatic expiry. Older versions remain available by their
checksum and can be enumerated in R2 under the record prefix. Keep the private
bucket's public access disabled and do not add a lifecycle expiry to `records/`.

Readers verify archived bytes and retain existing API URLs. Old Discovery reads
do not rehydrate Redis. A Redis quota failure after successful archival does not
fail a capture. A failed archive write does not authorize pruning. Archive outage
reads may use an existing recent Redis copy and log that fallback. Historical
reads without a valid copy fail explicitly; no historical odds are fabricated.

## Provision and mirror

1. Create a private R2 bucket, e.g. `mlb-discovery-archive`, with no public URL and
   no record expiration rules. Use an R2 S3 API token restricted to this bucket
   with object read/write access. The application only deletes its own temporary
   health probe objects; it has no record deletion code.
2. Set these **server-side production** environment variables on the shared
   `hr-form-board-actions` Vercel project. Do not use `NEXT_PUBLIC_` variables or
   put credential values in Git, chat, URLs, or CLI arguments:

   - `ARCHIVE_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
   - `ARCHIVE_R2_BUCKET=mlb-discovery-archive`
   - `ARCHIVE_R2_ACCESS_KEY_ID` and `ARCHIVE_R2_SECRET_ACCESS_KEY`
   - `ARCHIVE_MODE=mirror`
   - `ARCHIVE_HOT_DAYS=14`
   - Existing `QSTASH_TOKEN` and a server-side `SPORTSGAMEODDS_API_KEY`.

   Keep the existing Redis credentials. The provider key in Vercel allows a new
   capture even if Redis is unreachable. The Python model uses the same QStash
   HMAC to call the Node archive gateway. Its default is the production origin;
   set `ARCHIVE_GATEWAY_URL` explicitly for an isolated staging deployment, with
   the full `/api/capture-checkpoint?action=archive-record` URL. Never point a
   staging deployment at production with production credentials.
3. Redeploy. Read `/api/checkpoint-health?action=archive-health` and confirm a
   verified R2 write/read probe. Existing captures now mirror into R2 while
   retaining their original Redis TTLs.
4. Run `QSTASH_TOKEN` from a secure environment with:

   ```sh
   python scripts/migrate_archive.py --mode mirror
   ```

   The first batch starts a 10-minute drain interval for older functions. Then
   migration scans eligible Redis records in resumable batches and includes the
   four existing permanent rescue backups. Each exact record is copied and read
   back before progress advances. A failed copy leaves the record and cursor
   available for retry. New writes use conditional pointers so migration cannot
   replace a newer archived value with an older scanned value.

   Do not activate retention until `migration-mirror.completedAt` exists and
   reported errors are resolved. Investigate `missingSources` if nonzero: those
   keys expired naturally between SCAN and GET and are not claimed as recovered.

## Activate and verify

5. Change `ARCHIVE_MODE=active` and redeploy. The application refuses archive
   writes/retention before the completed mirror migration gate. Capture/model
   leases are now independent of Redis capacity; mirror deployments bridge both
   lease stores to prevent overlap during rollout.
6. Run `python scripts/migrate_archive.py --mode active`. Existing copies receive
   a shorter TTL only after verified permanent archival and an atomic equality
   check. Old historical copies receive a 60-second TTL. A concurrent change or
   rejected Redis command keeps the source intact. Once a scan completes,
   scheduled maintenance rechecks it daily. Batches also run after existing
   checkpoint and Top 100 jobs; no extra provider requests are made.
7. Verify a recent and an older date through each market's existing odds and
   Discovery URLs, compare provider call IDs/checksums and row counts, and check
   the triples model and frozen selection APIs. Observe one scheduled capture
   plus its recovery delivery: the second delivery must reuse the same capture.
8. `/api/checkpoint-health?action=archive-health` checks R2 read/write health,
   migration progress, overdue shared captures after their 15-minute window,
   and Redis storage estimates. Capacity inventory runs at most twice daily;
   alerts begin at 70%, with critical alerts at 85%. Stored-string bytes exclude
   key/database overhead, so also retain the provider's own quota/billing alerts.
   Connect an hourly health watch to notify the owner on failures; the health
   endpoint itself does not send notifications. Confirm the watch after setup.

## Recovery

After activation, keep the archive-aware reader deployed. Do not roll back to an
old Redis-only build: older Redis copies will have expired. If retention needs
to stop, switch to `mirror`, which keeps archive reads and stops new shortening;
already-applied TTLs continue to expire, with permanent copies still readable.
Do not use `off` after cutover unless every required record has first been
restored and verified in another durable reader.

Use a separate bucket and independent credentials for staging. Before activation
test the R2 conditional-write behavior and one real archive round trip. The local
test suite covers corruption, quota failures, frozen selection races, stale cache
reads, owner-checked leases, migration resumption and retention gating. A private
R2 connection is still required to validate actual infrastructure.
