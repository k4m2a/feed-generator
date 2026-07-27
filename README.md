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

Every feed is one entry in the `FEEDS` table in
[`src/algos/list-feed.ts`](src/algos/list-feed.ts) (rkey → list URI + display info) — see
[Adding a new feed](#adding-a-new-feed).

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

The resource is a Coolify **Docker-image Application** (`kj0jt03zbp8bwhi0qf2pcsuc`, project
*K4M2A* → *production*), so its env vars and volume are configured **in the Coolify UI**, not
from a compose file in this repo. [`coolify-compose.yml`](coolify-compose.yml) is the
checked-in *record* of those values — edit one and you must edit the other.

Two things differ from the old Lightsail setup: the app binds `0.0.0.0` (Traefik proxies it
over the docker network), and `feed.sqlite` lives on a **named volume** (`feedgen-data`
→ `/data`) so feed history survives redeploys.

This must serve `https://feeds.coseeker.com/.well-known/did.json` (the `did:web` document)
plus the `app.bsky.feed.getFeedSkeleton` and `describeFeedGenerator` XRPC endpoints.

### One-time setup

Required GitHub Actions config (Settings → Secrets and variables → Actions):

| Kind | Name | Value |
|---|---|---|
| Variable | `COOLIFY_URL` | `https://coolify.achal.xyz` |
| Variable | `COOLIFY_RESOURCE_UUID` | `kj0jt03zbp8bwhi0qf2pcsuc` (from the resource's Coolify URL) |
| Variable | `COOLIFY_HEALTHCHECK_URL` | `https://feeds.coseeker.com/.well-known/did.json` (optional; this is the default) |
| Secret | `COOLIFY_TOKEN` | Coolify API token (Keys & Tokens → API tokens) |

DNS: point the `feeds.coseeker.com` A-record at the k4m2a-core box.

### Ops

Everything day-to-day is done from the **Coolify UI** — no SSH needed. Open the
feed-generator resource (project *K4M2A* → *production*):

- **Logs** tab — app logs.
- **Terminal** tab — pick the `feed-generator` container (the box also runs the PDS and
  social-app), *Connect*, and you get a root shell **inside** the container at `/app`. Run
  container commands directly there, with no `docker exec` wrapper:

  ```bash
  yarn backfill      # (re)backfill feed history for every tracked list
  ```

  The container's env (including `FEEDGEN_SQLITE_LOCATION=/data/feed.sqlite`) is inherited by
  the shell, so the backfill writes to the same DB on the `feedgen-data` volume that the live
  service reads.
- **Redeploy** / **Restart** buttons — a redeploy re-pulls `ghcr.io/k4m2a/feed-generator:latest`.

> Don't run `yarn publishAll` from the container: `avatars/` is excluded by
> [`.dockerignore`](.dockerignore), so it would find no image and leave the published avatar
> as-is. Publish from a checkout on your machine instead.

If you do end up on the k4m2a-core box over SSH, the container name is Coolify-prefixed:

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

## Adding a new feed

Someone creates a Bluesky list on `coseeker.com`; you turn it into a feed. `FEEDS` in
[`src/algos/list-feed.ts`](src/algos/list-feed.ts) is the only code change — handlers and
`describeFeedGenerator` are both derived from it.

**1. Look up the list.** Its `uri`, `name`, `description`, and `avatar` all come from the
public AppView (no auth):

```bash
curl -s "https://public.api.bsky.app/xrpc/app.bsky.graph.getLists?actor=did:plc:ieyfjh6ystyufa3a7pi3jw5q&limit=50" | jq '.lists[] | {uri, name, description, avatar}'
```

**2. Add it to `FEEDS`.** Pick a short lowercase `rkey` — it becomes the feed's URL — and use
the list's own name/description unless there's a reason not to:

```ts
gi4qc: {
  listUri: 'at://did:plc:ieyfjh6ystyufa3a7pi3jw5q/app.bsky.graph.list/3mrm42b52y22q',
  displayName: 'GI4QC',
  description: 'Power of Mind Over Matter?\n…',
},
```

**3. Add the avatar.** To reuse the list's own logo, pull the original blob from the PDS (the
CID is the last path segment of the `avatar` URL from step 1) and save it as
`avatars/<rkey>.{png,jpg}` — check the `content-type` to pick the extension:

```bash
curl -s -D- -o avatars/<rkey>.jpg "https://coseeker.org/xrpc/com.atproto.sync.getBlob?did=did:plc:ieyfjh6ystyufa3a7pi3jw5q&cid=<cid>"
```

**4. Commit and push** — CI builds the image and rolls out the deploy (~1 min). Do this
*before* step 5: the feed record points at `did:web:feeds.coseeker.com`, so if the record
exists before the service knows the rkey, anyone opening the feed gets `UnknownFeed` until
the deploy lands.

**5. Publish the record** from your machine (needs the app password, and `avatars/` isn't in
the image):

```bash
yarn publishAll
```

**6. Backfill.** Live indexing only captures posts made *after* the service saw them, so a new
feed starts nearly empty. In the Coolify **Terminal** tab (see [Ops](#ops)):

```bash
yarn backfill
```

**7. Verify:**

```bash
curl -s "https://feeds.coseeker.com/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:plc:ieyfjh6ystyufa3a7pi3jw5q/app.bsky.feed.generator/<rkey>&limit=5" | jq
curl -s "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://did:plc:ieyfjh6ystyufa3a7pi3jw5q/app.bsky.feed.generator/<rkey>" | jq '{isOnline: .isOnline, isValid: .isValid}'
```

Finally, add a row to the feed table at the top of this README and to
[`avatars/README.md`](avatars/README.md).

## License

MIT — see [LICENSE](LICENSE).
