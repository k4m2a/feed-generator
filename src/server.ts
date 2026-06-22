import http from 'http'
import events from 'events'
import express from 'express'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { createServer } from './lexicon'
import feedGeneration from './methods/feed-generation'
import describeGenerator from './methods/describe-generator'
import { createDb, Database, migrateToLatest } from './db'
import { JetstreamSubscription } from './subscription'
import { AppContext, Config } from './config'
import { ListManager } from './util/lists'
import { listUris } from './algos/list-feed'
import wellKnown from './well-known'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public firehose: JetstreamSubscription
  public lists: ListManager
  public cfg: Config

  constructor(
    app: express.Application,
    db: Database,
    firehose: JetstreamSubscription,
    lists: ListManager,
    cfg: Config,
  ) {
    this.app = app
    this.db = db
    this.firehose = firehose
    this.lists = lists
    this.cfg = cfg
  }

  static create(cfg: Config) {
    const app = express()
    const db = createDb(cfg.sqliteLocation)
    const lists = new ListManager(listUris())
    const firehose = new JetstreamSubscription(
      db,
      cfg.subscriptionEndpoint,
      lists,
      cfg.subscriptionReconnectDelay,
    )

    const didCache = new MemoryCache()
    const didResolver = new DidResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    const server = createServer({
      validateResponse: true,
      payload: {
        jsonLimit: 100 * 1024, // 100kb
        textLimit: 100 * 1024, // 100kb
        blobLimit: 5 * 1024 * 1024, // 5mb
      },
    })
    const ctx: AppContext = {
      db,
      didResolver,
      lists,
      cfg,
    }
    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))

    return new FeedGenerator(app, db, firehose, lists, cfg)
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)
    // Load list membership before subscribing so wantedDids is populated.
    await this.lists.start()
    this.firehose.start()
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    return this.server
  }
}

export default FeedGenerator
