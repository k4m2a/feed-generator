# CoSeeker Feed Generator

An [AT Protocol](https://atproto.com) feed generator that serves three Bluesky custom
feeds, each surfacing posts from the members of a Bluesky list owned by
[`publisher.coseeker.org`](https://bsky.app/profile/publisher.coseeker.org)
(`did:plc:ieyfjh6ystyufa3a7pi3jw5q`).

| Feed (rkey) | Display name | Source list |
|---|---|---|
| `md-parivaar` | MD Parivaar | `app.bsky.graph.list/3moflnppcac2d` |
| `k4m2a` | K4M2A | `app.bsky.graph.list/3mofllwjqdk2d` |
| `coseeker` | CoSeeker | `app.bsky.graph.list/3moflmrivgk2d` |

Each feed is the equivalent of a Skyfeed "list input → sort by created_at" block: a post is
included iff its author is on the list, newest first.

> Built on the [Bluesky feed-generator starter kit](https://github.com/bluesky-social/feed-generator).
> The repo also contains a parallel Go implementation under [`go/`](go/); the deployed
> service is the **TypeScript** one in [`src/`](src/).

## How it works

1. **List membership** — [`src/util/lists.ts`](src/util/lists.ts) (`ListManager`) resolves
   each list's members from the public AppView (`app.bsky.graph.getList`, no auth), caches
   them in memory, and refreshes every ~5 minutes, so the feeds track list edits without a
   redeploy.
2. **Ingest** — [`src/subscription.ts`](src/subscription.ts) (`JetstreamSubscription`)
   consumes [Jetstream](https://github.com/bluesky-social/jetstream) filtered server-side to
   `app.bsky.feed.post` events from **only the current list members** (`wantedDids`).
   Matching **top-level** posts (replies and reposts excluded) are stored in SQLite tagged
   with their author DID; deletes are removed.
   When list membership changes, the subscription reconnects with the updated `wantedDids`
   (resuming from the stored `time_us` cursor).
3. **Serving** — each feed handler ([`src/algos/list-feed.ts`](src/algos/list-feed.ts))
   returns the stored posts whose author is a member of its list, newest first, with
   timestamp-based cursor pagination. Feeds are registered in
   [`src/algos/index.ts`](src/algos/index.ts) and auto-advertised by
   `app.bsky.feed.describeFeedGenerator`.

To add or change feeds, edit the `FEEDS` table in
[`src/algos/list-feed.ts`](src/algos/list-feed.ts) (rkey → list URI + display info).

## Configuration

All config is via environment variables (`.env`, gitignored — see `.env.example`):

| Variable | Value used in production |
|---|---|
| `FEEDGEN_HOSTNAME` | `feeds.coseeker.com` |
| `FEEDGEN_SERVICE_DID` | `did:web:feeds.coseeker.com` |
| `FEEDGEN_PUBLISHER_DID` | `did:plc:ieyfjh6ystyufa3a7pi3jw5q` (publisher.coseeker.org) |
| `FEEDGEN_SQLITE_LOCATION` | a persistent path, e.g. `feed.sqlite` (not `:memory:`) |
| `FEEDGEN_SUBSCRIPTION_ENDPOINT` | `wss://jetstream2.us-east.bsky.network/subscribe` |
| `FEEDGEN_LISTENHOST` | `127.0.0.1` (behind a reverse proxy) |
| `FEEDGEN_PORT` | `3000` |
| `FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY` | `3000` (ms) |

The **service host** (`feeds.coseeker.com`) is independent of the **publishing account**
(`publisher.coseeker.org`). The service DID is a `did:web` derived from the hostname.

## Running locally

```bash
yarn install
cp .env.example .env   # then edit values
yarn build             # tsc → dist/
yarn start             # ts-node src/index.ts
```

Verify:

```bash
curl -s "http://127.0.0.1:3000/xrpc/app.bsky.feed.describeFeedGenerator" | jq
curl -s "http://127.0.0.1:3000/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:plc:ieyfjh6ystyufa3a7pi3jw5q/app.bsky.feed.generator/md-parivaar&limit=10" | jq
```

> Feeds only contain posts seen **after** the service starts — there is no backfill. Leave
> it running (or wait for a list member to post) to see items appear.

## Deployment

The service runs on a small Linux host (AWS Lightsail, Ubuntu 24.04) behind Caddy for TLS.

- **App** runs as a `systemd` service (`feedgen`) executing `node dist/index.js` from the
  repo directory, with `Restart=always`. SQLite lives on the instance disk so feed history
  survives restarts.
- **Caddy** terminates TLS and reverse-proxies the host to the app:

  ```caddy
  feeds.coseeker.com {
      reverse_proxy 127.0.0.1:3000
  }
  ```

- **DNS**: `feeds.coseeker.com` A-record → the instance's static IP.
- **Firewall**: ports 80 and 443 open to the internet (Caddy uses them for ACME + serving).
- A swap file is recommended on small (≤512 MB RAM) instances so `yarn install` / `tsc`
  don't OOM.

This must serve `https://feeds.coseeker.com/.well-known/did.json` (the `did:web` document)
plus the `app.bsky.feed.getFeedSkeleton` and `describeFeedGenerator` XRPC endpoints.

Handy ops commands on the host:

```bash
sudo journalctl -u feedgen -f      # app logs
sudo systemctl restart feedgen     # restart after a deploy (git pull && yarn build first)
```

## Publishing the feeds

Feed records are published to the **publisher.coseeker.org** repo — this is what makes the
feeds discoverable and points them at the service DID. Use a Bluesky **App Password** (not
the main password).

### Batch (recommended)

Publishes/updates all feeds in `FEEDS` at once, prompting only for the app password:

```bash
yarn publishAll
```

It reads display names and descriptions from
[`src/algos/list-feed.ts`](src/algos/list-feed.ts), so editing a feed there and re-running
updates the live record. Login defaults to `publisher.coseeker.org` on
`https://coseeker.org`; override with `PUBLISH_HANDLE`, `PUBLISH_SERVICE`, or skip the
prompt with `BLUESKY_APP_PASSWORD`.

### Avatars

Drop a square **PNG or JPEG** (≈1000×1000, under ~1 MB) into [`avatars/`](avatars/) named
after the feed's rkey — `avatars/md-parivaar.png`, `avatars/k4m2a.png`,
`avatars/coseeker.png` — and `yarn publishAll` uploads it automatically. If no file is
present, the existing avatar on the record is preserved.

### Single feed (interactive)

The original starter-kit flow, one feed at a time:

```bash
yarn publishFeed     # prompts for handle, password, recordName, displayName, ...
```

To remove a feed record, use `yarn unpublishFeed`.

## License

MIT — see [LICENSE](LICENSE).
