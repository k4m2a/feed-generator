import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

export type FeedDef = {
  listUri: string
  displayName: string
  description: string
}

// The feeds served by this generator, keyed by rkey (the value shown in the
// feed's URL). Each surfaces posts authored by members of one Bluesky list.
export const FEEDS: Record<string, FeedDef> = {
  'md-parivaar': {
    listUri:
      'at://did:plc:ieyfjh6ystyufa3a7pi3jw5q/app.bsky.graph.list/3moflnppcac2d',
    displayName: 'MD Parivaar',
    description: 'Posts from members of the MD Parivaar list.',
  },
  k4m2a: {
    listUri:
      'at://did:plc:ieyfjh6ystyufa3a7pi3jw5q/app.bsky.graph.list/3mofllwjqdk2d',
    displayName: 'K4M2A',
    description: 'Posts from members of the K4M2A list.',
  },
  coseeker: {
    listUri:
      'at://did:plc:ieyfjh6ystyufa3a7pi3jw5q/app.bsky.graph.list/3moflmrivgk2d',
    displayName: 'CoSeeker',
    description: 'Posts from members of the CoSeeker list.',
  },
}

// All distinct list URIs the generator needs to track membership for.
export const listUris = (): string[] => [
  ...new Set(Object.values(FEEDS).map((f) => f.listUri)),
]

// Builds a feed handler that returns the stored posts whose author is a member
// of the given list, newest first, with the same cursor scheme as the template.
export const makeListFeed = (listUri: string) => {
  return async (ctx: AppContext, params: QueryParams) => {
    const members = ctx.lists.members(listUri)
    if (members.length === 0) {
      return { feed: [] }
    }

    let builder = ctx.db
      .selectFrom('post')
      .selectAll()
      .where('author', 'in', members)
      .orderBy('indexedAt', 'desc')
      .orderBy('cid', 'desc')
      .limit(params.limit)

    if (params.cursor) {
      const timeStr = new Date(parseInt(params.cursor, 10)).toISOString()
      builder = builder.where('post.indexedAt', '<', timeStr)
    }
    const res = await builder.execute()

    const feed = res.map((row) => ({
      post: row.uri,
    }))

    let cursor: string | undefined
    const last = res.at(-1)
    if (last) {
      cursor = new Date(last.indexedAt).getTime().toString(10)
    }

    return {
      cursor,
      feed,
    }
  }
}
