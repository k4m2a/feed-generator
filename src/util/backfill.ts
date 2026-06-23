import { AtpAgent } from '@atproto/api'
import { Database } from '../db'

export type BackfillOptions = {
  // AppView the author feeds are pulled from.
  appview?: string
  // Cap on posts inserted per author (0 = unlimited).
  maxPerAuthor?: number
  // Include replies as well as top-level posts.
  includeReplies?: boolean
  // Delay between paginated AppView requests, to stay gentle on rate limits.
  pageDelayMs?: number
  // Optional per-author progress hook (used by the CLI for logging).
  onAuthorDone?: (did: string, inserted: number, scanned: number) => void
}

// Pulls each given author's existing posts from the AppView and inserts them
// into the same `post` table the feeds query, with indexedAt = the post's
// createdAt so they interleave chronologically with live-indexed posts.
// Reposts (and, by default, replies) are skipped. Idempotent — existing rows
// are left as-is, so re-running is safe. Returns the total rows inserted.
export const backfillAuthors = async (
  db: Database,
  dids: string[],
  opts: BackfillOptions = {},
): Promise<number> => {
  const appview = opts.appview ?? 'https://public.api.bsky.app'
  const maxPerAuthor = opts.maxPerAuthor ?? 1000
  const includeReplies = opts.includeReplies ?? false
  const pageDelayMs = opts.pageDelayMs ?? 120
  const filter = includeReplies ? 'posts_with_replies' : 'posts_no_replies'

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
        if (pageDelayMs > 0) await sleep(pageDelayMs)
      } while (cursor)
    } catch (err: any) {
      console.error(`  ! ${did} — ${err?.status ?? ''} ${err?.message ?? err}`)
    }

    grandTotal += inserted
    opts.onAuthorDone?.(did, inserted, seen)
  }

  return grandTotal
}

// Use the post's createdAt for ordering, falling back to the AppView's
// indexedAt; clamp future-dated posts to now so they can't pin to the top.
const postTimestamp = (post: {
  record: unknown
  indexedAt: string
}): string => {
  const createdAt = (post.record as { createdAt?: string })?.createdAt
  let t = createdAt ? new Date(createdAt) : new Date(NaN)
  if (isNaN(t.getTime())) t = new Date(post.indexedAt)
  if (isNaN(t.getTime()) || t.getTime() > Date.now()) t = new Date()
  return t.toISOString()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
