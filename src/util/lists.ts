import { AtpAgent } from '@atproto/api'

// Resolves Bluesky list membership (the DIDs of members) for a fixed set of
// list URIs via the public AppView, caches it in memory, and refreshes
// periodically so feeds track list edits without a redeploy.
export class ListManager {
  private agent: AtpAgent
  private byList: Map<string, Set<string>> = new Map()
  private union: Set<string> = new Set()
  private timer?: NodeJS.Timeout
  private loaded = false

  // Invoked after a refresh whenever the union of all members changed.
  // The Jetstream subscription uses this to reconnect with new wantedDids.
  public onChange?: () => void

  // Invoked after a refresh with the DIDs of members that joined since the last
  // refresh (never on the initial load — that's the backfill script's job).
  // Used to auto-backfill a new member's existing posts into the feed.
  public onMembersAdded?: (dids: string[]) => void

  constructor(
    public listUris: string[],
    appviewUrl = 'https://public.api.bsky.app',
    private refreshIntervalMs = 5 * 60 * 1000,
  ) {
    this.agent = new AtpAgent({ service: appviewUrl })
  }

  // DIDs of the members of a single list.
  members(listUri: string): string[] {
    const set = this.byList.get(listUri)
    return set ? [...set] : []
  }

  // True if the DID is a member of any tracked list.
  isMember(did: string): boolean {
    return this.union.has(did)
  }

  // Union of all members across all tracked lists (for Jetstream wantedDids).
  unionDids(): string[] {
    return [...this.union]
  }

  // Fetch every member of a list, paginating through all items.
  private async fetchListMembers(listUri: string): Promise<Set<string>> {
    const dids = new Set<string>()
    let cursor: string | undefined
    do {
      const res = await this.agent.app.bsky.graph.getList({
        list: listUri,
        limit: 100,
        cursor,
      })
      for (const item of res.data.items) {
        dids.add(item.subject.did)
      }
      cursor = res.data.cursor
    } while (cursor)
    return dids
  }

  // Re-resolve every list. On failure for a given list, keep its last known
  // membership rather than dropping members.
  async refresh(): Promise<void> {
    const nextByList = new Map<string, Set<string>>()
    const nextUnion = new Set<string>()
    for (const listUri of this.listUris) {
      try {
        const members = await this.fetchListMembers(listUri)
        nextByList.set(listUri, members)
      } catch (err) {
        console.error(`failed to refresh list ${listUri}`, err)
        nextByList.set(listUri, this.byList.get(listUri) ?? new Set())
      }
    }
    for (const set of nextByList.values()) {
      for (const did of set) nextUnion.add(did)
    }

    const changed = !setsEqual(this.union, nextUnion)
    // New members relative to the previous union; skipped on the initial load.
    const added = this.loaded
      ? [...nextUnion].filter((did) => !this.union.has(did))
      : []

    this.byList = nextByList
    this.union = nextUnion
    this.loaded = true

    console.log(
      `list membership refreshed: ${nextUnion.size} unique members across ${this.listUris.length} lists`,
    )
    if (changed) this.onChange?.()
    if (added.length > 0) this.onMembersAdded?.(added)
  }

  // Initial load plus periodic refresh.
  async start(): Promise<void> {
    await this.refresh()
    this.timer = setInterval(() => {
      this.refresh().catch((err) => console.error('list refresh error', err))
    }, this.refreshIntervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}

const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}
