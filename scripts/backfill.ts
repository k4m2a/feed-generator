import dotenv from 'dotenv'
import { AtpAgent } from '@atproto/api'
import { createDb, migrateToLatest } from '../src/db'
import { ListManager } from '../src/util/lists'
import { listUris } from '../src/algos/list-feed'

// One-off backfill: pulls each list member's existing posts from the AppView and
// inserts them into the same SQLite DB the feeds query, so the feeds aren't
// limited to posts seen live since the service started.
//
//   yarn backfill
//
// Posts are stored with indexedAt = the post's createdAt, so they interleave
// chronologically with live-indexed posts. Reposts are skipped (the feeds only
// show a member's own posts). Re-running is safe — existing rows are left as-is.
//
// Env: APPVIEW (default https://public.api.bsky.app),
//      BACKFILL_MAX_PER_AUTHOR (default 1000, 0 = unlimited),
//      BACKFILL_INCLUDE_REPLIES (default true).

const run = async () => {
  dotenv.config()

  const sqliteLocation = process.env.FEEDGEN_SQLITE_LOCATION ?? ':memory:'
  const appview = process.env.APPVIEW ?? 'https://public.api.bsky.app'
  const maxPerAuthor = parseInt(process.env.BACKFILL_MAX_PER_AUTHOR ?? '1000', 10)
  const includeReplies = process.env.BACKFILL_INCLUDE_REPLIES !== 'false'
  const filter = includeReplies ? 'posts_with_replies' : 'posts_no_replies'

  const db = createDb(sqliteLocation)
  await migrateToLatest(db)

  const lists = new ListManager(listUris())
  await lists.refresh()
  const dids = lists.unionDids()
  console.log(`backfilling ${dids.length} members into ${sqliteLocation}\n`)

  const agent = new AtpAgent({ service: appview })
  let grandTotal = 0

  for (const did of dids) {
    let inserted = 0
    let seen = 0
    let cursor: string | undefined
    try {
      do {
        const res = await agent.app.bsky.feed.getAuthorFeed({
          actor: did,
          limit: 100,
          cursor,
          filter,
        })
        cursor = res.data.cursor

        const rows = res.data.feed
          // Skip reposts and anything not authored by this member.
          .filter((item) => !item.reason && item.post.author.did === did)
          .map((item) => ({
            uri: item.post.uri,
            cid: item.post.cid,
            author: did,
            indexedAt: postTimestamp(item.post),
          }))

        seen += res.data.feed.length
        if (rows.length > 0) {
          await db
            .insertInto('post')
            .values(rows)
            .onConflict((oc) => oc.doNothing())
            .execute()
          inserted += rows.length
        }

        if (maxPerAuthor > 0 && inserted >= maxPerAuthor) break
        await sleep(120)
      } while (cursor)
    } catch (err: any) {
      console.error(`  ! ${did} — ${err?.status ?? ''} ${err?.message ?? err}`)
    }

    grandTotal += inserted
    console.log(`  ${did}: ${inserted} posts (scanned ${seen})`)
  }

  console.log(`\nDone — ${grandTotal} posts backfilled 🎉`)
  await db.destroy()
}

// Use the post's createdAt for ordering, falling back to the AppView's
// indexedAt; clamp future-dated posts to now so they can't pin to the top.
const postTimestamp = (post: { record: unknown; indexedAt: string }): string => {
  const createdAt = (post.record as { createdAt?: string })?.createdAt
  let t = createdAt ? new Date(createdAt) : new Date(NaN)
  if (isNaN(t.getTime())) t = new Date(post.indexedAt)
  if (isNaN(t.getTime()) || t.getTime() > Date.now()) t = new Date()
  return t.toISOString()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

run()
