# CoSeeker Feed Generator

An [AT Protocol](https://atproto.com) feed generator that serves four Bluesky custom
feeds, each surfacing posts from the members of a Bluesky list owned by
[`coseeker.com`](https://bsky.app/profile/coseeker.com)
(`did:plc:ieyfjh6ystyufa3a7pi3jw5q`).

| Feed (rkey) | Display name | Source list |
|---|---|---|
| `md-parivaar` | MD Parivaar | `app.bsky.graph.list/3moflnppcac2d` |
| `k4m2a` | K4M2A | `app.bsky.graph.list/3mofllwjqdk2d` |
| `coseeker` | CoSeeker | `app.bsky.graph.list/3moflmrivgk2d` |
| `gi4qc` | GI4QC | `app.bsky.graph.list/3mrm42b52y22q` |

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
| `FEEDGEN_PUBLISHER_DID` | `did:plc:ieyfjh6ystyufa3a7pi3jw5q` (coseeker.com) |
| `FEEDGEN_SQLITE_LOCATION` | a persistent path, e.g. `feed.sqlite` (not `:memory:`) |
| `FEEDGEN_SUBSCRIPTION_ENDPOINT` | `wss://jetstream2.us-east.bsky.network/subscribe` |
| `FEEDGEN_LISTENHOST` | `127.0.0.1` (behind a reverse proxy) |
| `FEEDGEN_PORT` | `3000` |
| `FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY` | `3000` (ms) |

The **service host** (`feeds.coseeker.com`) is independent of the **publishing account**
(`coseeker.com`). The service DID is a `did:web` derived from the hostname.

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

> Live indexing only captures posts seen **after** the service starts. To seed a feed with
> members' existing posts, run `yarn backfill` once. After that, whenever someone joins a
> tracked list the service auto-backfills their existing posts in the background (toggle with
> `FEEDGEN_AUTO_BACKFILL`).

## Deployment

The service runs as a Docker container on the shared **k4m2a-core** box, managed by
[Coolify](https://coolify.io) alongside the PDS and social-app. Coolify's Traefik proxy
terminates TLS for `feeds.coseeker.com`; there is no per-host Caddy anymore.

Deploys are CI-driven — push to `main` and
[`.github/workflows/deploy-coolify.yml`](.github/workflows/deploy-coolify.yml):

1. builds the image (see [`Dockerfile`](Dockerfile)) and pushes it to GHCR as
   `ghcr.io/k4m2a/feed-generator:latest` (plus a short-SHA tag for rollbacks),
2. calls the Coolify deploy API to roll out the new image, and
3. polls `https://feeds.coseeker.com/.well-known/did.json` until the new container serves.

The Coolify service stack is defined by [`coolify-compose.yml`](coolify-compose.yml) (the
source-of-truth to paste into the resource's *Edit Compose File* screen). Two things differ
from the old Lightsail setup: the app binds `0.0.0.0` (Traefik proxies it over the docker
network), and `feed.sqlite` lives on a **named volume** (`feedgen-data`) so feed history
survives redeploys.

This must serve `https://feeds.coseeker.com/.well-known/did.json` (the `did:web` document)
plus the `app.bsky.feed.getFeedSkeleton` and `describeFeedGenerator` XRPC endpoints.

### One-time setup

Required GitHub Actions config (Settings → Secrets and variables → Actions):

| Kind | Name | Value |
|---|---|---|
| Variable | `COOLIFY_URL` | Coolify base URL, e.g. `https://coolify.k4m2a.app` |
| Variable | `COOLIFY_RESOURCE_UUID` | UUID of the feed-generator resource (from its Coolify URL) |
| Variable | `COOLIFY_HEALTHCHECK_URL` | `https://feeds.coseeker.com/.well-known/did.json` (optional; this is the default) |
| Secret | `COOLIFY_TOKEN` | Coolify API token (Keys & Tokens → API tokens) |

DNS: point the `feeds.coseeker.com` A-record at the k4m2a-core box.

### Ops

The container name is prefixed by Coolify; find it and tail logs / run scripts with:

```bash
docker ps --filter name=feed-generator            # find the container id
docker logs -f <container>                         # app logs
docker exec -it <container> yarn backfill          # (re)backfill feed history
```

## Publishing the feeds

Feed records are published to the **coseeker.com** repo — this is what makes the
feeds discoverable and points them at the service DID. Use a Bluesky **App Password** (not
the main password).

### Batch (recommended)

Publishes/updates all feeds in `FEEDS` at once, prompting only for the app password:

```bash
yarn publishAll
```

It reads display names and descriptions from
[`src/algos/list-feed.ts`](src/algos/list-feed.ts), so editing a feed there and re-running
updates the live record. Login defaults to `coseeker.com` on
`https://coseeker.org`; override with `PUBLISH_HANDLE`, `PUBLISH_SERVICE`, or skip the
prompt with `BLUESKY_APP_PASSWORD`.

### Avatars

Drop a square **PNG or JPEG** (≈1000×1000, under ~1 MB) into [`avatars/`](avatars/) named
after the feed's rkey — `avatars/md-parivaar.png`, `avatars/k4m2a.png`,
`avatars/coseeker.png`, `avatars/gi4qc.jpg` — and `yarn publishAll` uploads it automatically. If no file is
present, the existing avatar on the record is preserved.

### Single feed (interactive)

The original starter-kit flow, one feed at a time:

```bash
yarn publishFeed     # prompts for handle, password, recordName, displayName, ...
```

To remove a feed record, use `yarn unpublishFeed`.

## License

MIT — see [LICENSE](LICENSE).
