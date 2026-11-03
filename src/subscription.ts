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

export type JetstreamOptions = {
  // How often to ping the socket and check it for silence.
  heartbeatInterval: number
  // Reconnect if neither a message nor a pong arrives within this window.
  stallTimeout: number
  // How often to log a liveness summary (0 disables).
  livenessInterval: number
}

// Consumes the Bluesky Jetstream, filtered server-side to post events from the
// current set of list members (wantedDids), and indexes them. Reconnects with a
// refreshed wantedDids set whenever list membership changes.
//
// The socket is watchdogged, because the failure that actually bit us was not a
// dropped connection but a silent one: on 2026-09-30 the TCP connection went
// half-open and `ws` never fired 'close' or 'error', so the reconnect path below
// was never reached and ingestion stopped dead for 34 days while the process
// stayed healthy and kept serving HTTP. A half-open socket answers neither
// messages nor pings, so pinging on an interval and reconnecting when nothing
// comes back is what makes that state detectable at all.
export class JetstreamSubscription {
  private ws?: WebSocket
  private reconnectTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout
  private livenessTimer?: NodeJS.Timeout
  private stopped = false
  private eventsSinceCursorWrite = 0
  // Last time a message or pong arrived; the watchdog measures silence from here.
  private lastActivityAt = 0
  // Counters for the periodic liveness line, reset each time it's logged.
  private eventsSinceReport = 0
  private indexedSinceReport = 0

  constructor(
    private db: Database,
    private endpoint: string,
    private lists: ListManager,
    private reconnectDelay: number,
    private opts: JetstreamOptions,
  ) {}

  start() {
    this.lists.onChange = () => {
      console.log('list membership changed — reconnecting jetstream')
      this.reconnect()
    }
    this.startLivenessReport()
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.stopHeartbeat()
    this.discard(this.ws)
  }

  private reconnect() {
    this.discard(this.ws)
    this.scheduleConnect(0)
  }

  // Drop a socket we're done with. terminate(), not close(): we never need the
  // closing handshake with a firehose, and a half-open socket would never
  // complete one — close() would hang and leak the socket instead of firing
  // 'close'.
  private discard(ws?: WebSocket) {
    if (!ws) return
    this.stopHeartbeat()
    ws.removeAllListeners()
    ws.terminate()
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
    // handshakeTimeout so a connect that never completes fails loudly into the
    // reconnect path rather than hanging the way the half-open socket did.
    const ws = new WebSocket(url, { handshakeTimeout: 30000 })
    this.ws = ws

    ws.on('open', () => {
      console.log('jetstream connected')
      this.lastActivityAt = Date.now()
      this.startHeartbeat(ws)
    })
    ws.on('message', (data: WebSocket.RawData) => {
      this.lastActivityAt = Date.now()
      this.eventsSinceReport++
      this.handleMessage(data.toString()).catch((err) =>
        console.error('jetstream message error', err),
      )
    })
    // Jetstream answering our ping is proof the socket is still alive even when
    // every tracked account happens to be quiet.
    ws.on('pong', () => {
      this.lastActivityAt = Date.now()
    })
    ws.on('close', () => {
      if (this.stopped || this.ws !== ws) return
      this.stopHeartbeat()
      console.warn('jetstream closed — reconnecting')
      this.scheduleConnect(this.reconnectDelay)
    })
    ws.on('error', (err) => {
      console.error('jetstream socket error', err)
      ws.close() // triggers 'close' → reconnect
    })
  }

  private startHeartbeat(ws: WebSocket) {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped || this.ws !== ws) return
      const idleMs = Date.now() - this.lastActivityAt
      if (idleMs >= this.opts.stallTimeout) {
        console.warn(
          `jetstream stalled — nothing received for ${Math.round(
            idleMs / 1000,
          )}s; forcing reconnect`,
        )
        // Fires 'close' on the socket we're still tracking, so the usual
        // reconnect path picks it up from there.
        this.stopHeartbeat()
        ws.terminate()
        return
      }
      try {
        ws.ping()
      } catch (err) {
        console.error('jetstream ping failed', err)
        this.stopHeartbeat()
        ws.terminate()
      }
    }, this.opts.heartbeatInterval)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  // A periodic "still ingesting" line. Quiet accounts mean no post ever gets
  // logged, so without this there is no way to tell a working subscription from
  // a silently dead one by reading the logs.
  private startLivenessReport() {
    if (this.opts.livenessInterval <= 0) return
    this.livenessTimer = setInterval(() => {
      const connected = this.ws?.readyState === WebSocket.OPEN
      const idleSec = Math.round((Date.now() - this.lastActivityAt) / 1000)
      console.log(
        `jetstream ${connected ? 'alive' : 'DISCONNECTED'} — ` +
          `${this.eventsSinceReport} events, ${this.indexedSinceReport} posts indexed, ` +
          `last traffic ${idleSec}s ago`,
      )
      this.eventsSinceReport = 0
      this.indexedSinceReport = 0
    }, this.opts.livenessInterval)
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
      this.indexedSinceReport++
      console.log(`indexed ${uri}`)
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
