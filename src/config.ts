import { Database } from './db'
import { DidResolver } from '@atproto/identity'
import { ListManager } from './util/lists'

export type AppContext = {
  db: Database
  didResolver: DidResolver
  lists: ListManager
  cfg: Config
}

export type Config = {
  port: number
  listenhost: string
  hostname: string
  sqliteLocation: string
  subscriptionEndpoint: string
  serviceDid: string
  publisherDid: string
  subscriptionReconnectDelay: number
  // Auto-backfill a member's existing posts when they join a tracked list.
  autoBackfill: boolean
  // AppView used for auto-backfill author-feed reads.
  appview: string
  // Cap on posts auto-backfilled per newly added member (0 = unlimited).
  backfillMaxPerAuthor: number
  // How often (ms) to ping the jetstream socket and check it for silence.
  jetstreamHeartbeatInterval: number
  // Reconnect jetstream if nothing arrives within this window (ms).
  jetstreamStallTimeout: number
  // How often (ms) to log a jetstream liveness summary (0 disables).
  jetstreamLivenessInterval: number
}
