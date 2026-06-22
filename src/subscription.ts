import WebSocket from 'ws'
import { Database } from './db'
import { ListManager } from './util/lists'

// A single Jetstream commit event (https://github.com/bluesky-social/jetstream).
type JetstreamEvent = {
  did: string
  time_us: number
  kind: string
  commit?: {
    operation: 'create' | 'update' | 'delete'
    collection: string
    rkey: string
    cid?: string
    record?: Record<string, unknown>
  }
}

const POST_COLLECTION = 'app.bsky.feed.post'

// Consumes the Bluesky Jetstream, filtered server-side to post events from the
// current set of list members (wantedDids), and indexes them. Reconnects with a
// refreshed wantedDids set whenever list membership changes.
export class JetstreamSubscription {
  private ws?: WebSocket
  private reconnectTimer?: NodeJS.Timeout
  private stopped = false
  private eventsSinceCursorWrite = 0

  constructor(
    private db: Database,
    private endpoint: string,
    private lists: ListManager,
    private reconnectDelay: number,
  ) {}

  start() {
    this.lists.onChange = () => {
      console.log('list membership changed — reconnecting jetstream')
      this.reconnect()
    }
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.removeAllListeners()
    this.ws?.close()
  }

  private reconnect() {
    this.ws?.removeAllListeners()
    this.ws?.close()
    this.scheduleConnect(0)
  }

  private scheduleConnect(delay: number) {
    if (this.stopped) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error('jetstream connect error', err)
        this.scheduleConnect(this.reconnectDelay)
      })
    }, delay)
  }

  private async buildUrl(): Promise<string> {
    const url = new URL(this.endpoint)
    url.searchParams.set('wantedCollections', POST_COLLECTION)
    for (const did of this.lists.unionDids()) {
      url.searchParams.append('wantedDids', did)
    }
    const cursor = await this.getCursor()
    if (cursor) url.searchParams.set('cursor', String(cursor))
    return url.toString()
  }

  private async connect() {
    if (this.stopped) return

    const wanted = this.lists.unionDids()
    if (wanted.length === 0) {
      // Nothing to subscribe to yet; retry once membership loads.
      console.warn('no list members yet — delaying jetstream connect')
      this.scheduleConnect(this.reconnectDelay)
      return
    }

    const url = await this.buildUrl()
    console.log(`connecting to jetstream (${wanted.length} wantedDids)`)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => console.log('jetstream connected'))
    ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data.toString()).catch((err) =>
        console.error('jetstream message error', err),
      )
    })
    ws.on('close', () => {
      if (this.stopped || this.ws !== ws) return
      console.warn('jetstream closed — reconnecting')
      this.scheduleConnect(this.reconnectDelay)
    })
    ws.on('error', (err) => {
      console.error('jetstream socket error', err)
      ws.close() // triggers 'close' → reconnect
    })
  }

  private async handleMessage(raw: string) {
    let evt: JetstreamEvent
    try {
      evt = JSON.parse(raw)
    } catch {
      return
    }
    const commit = evt.commit
    if (evt.kind !== 'commit' || !commit) return
    if (commit.collection !== POST_COLLECTION) return

    const uri = `at://${evt.did}/${commit.collection}/${commit.rkey}`

    if (commit.operation === 'create') {
      // Safety belt: Jetstream already filters by wantedDids, but membership
      // may have just changed before a reconnect lands.
      if (!commit.cid || !this.lists.isMember(evt.did)) return
      // Top-level posts only — skip replies.
      if ((commit.record as { reply?: unknown } | undefined)?.reply) return
      await this.db
        .insertInto('post')
        .values({
          uri,
          cid: commit.cid,
          author: evt.did,
          indexedAt: new Date().toISOString(),
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
    } else if (commit.operation === 'delete') {
      await this.db.deleteFrom('post').where('uri', '=', uri).execute()
    }

    // Persist the Jetstream cursor (unix microseconds) every ~20 events so a
    // reconnect resumes roughly where we left off.
    if (++this.eventsSinceCursorWrite >= 20) {
      this.eventsSinceCursorWrite = 0
      await this.updateCursor(evt.time_us)
    }
  }

  private async getCursor(): Promise<number | undefined> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.endpoint)
      .executeTakeFirst()
    return res?.cursor
  }

  private async updateCursor(cursor: number) {
    await this.db
      .insertInto('sub_state')
      .values({ service: this.endpoint, cursor })
      .onConflict((oc) => oc.column('service').doUpdateSet({ cursor }))
      .execute()
  }
}
