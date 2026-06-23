import dotenv from 'dotenv'
import { createDb, migrateToLatest } from '../src/db'
import { ListManager } from '../src/util/lists'
import { listUris } from '../src/algos/list-feed'
import { backfillAuthors } from '../src/util/backfill'

// One-off backfill: pulls every current list member's existing posts from the
// AppView and inserts them into the same SQLite DB the feeds query, so the
// feeds aren't limited to posts seen live since the service started.
//
//   yarn backfill
//
// Newly added members are backfilled automatically by the running service (see
// FEEDGEN_AUTO_BACKFILL); this script is for the initial bulk load or a one-off
// reconciliation. Re-running is safe — existing rows are left as-is.
//
// Env: APPVIEW (default https://public.api.bsky.app),
//      BACKFILL_MAX_PER_AUTHOR (default 1000, 0 = unlimited),
//      BACKFILL_INCLUDE_REPLIES (default false — set to true to include replies).

const run = async () => {
  dotenv.config()

  const sqliteLocation = process.env.FEEDGEN_SQLITE_LOCATION ?? ':memory:'
  const appview = process.env.APPVIEW ?? 'https://public.api.bsky.app'
  const maxPerAuthor = parseInt(
    process.env.BACKFILL_MAX_PER_AUTHOR ?? '1000',
    10,
  )
  const includeReplies = process.env.BACKFILL_INCLUDE_REPLIES === 'true'

  const db = createDb(sqliteLocation)
  await migrateToLatest(db)

  const lists = new ListManager(listUris())
  await lists.refresh()
  const dids = lists.unionDids()
  console.log(`backfilling ${dids.length} members into ${sqliteLocation}\n`)

  const grandTotal = await backfillAuthors(db, dids, {
    appview,
    maxPerAuthor,
    includeReplies,
    onAuthorDone: (did, inserted, scanned) =>
      console.log(`  ${did}: ${inserted} posts (scanned ${scanned})`),
  })

  console.log(`\nDone — ${grandTotal} posts backfilled 🎉`)
  await db.destroy()
}

run()
