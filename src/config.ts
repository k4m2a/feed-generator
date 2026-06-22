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
}
