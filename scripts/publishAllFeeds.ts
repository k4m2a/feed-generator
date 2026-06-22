import dotenv from 'dotenv'
import inquirer from 'inquirer'
import { AtpAgent, BlobRef, AppBskyFeedDefs } from '@atproto/api'
import fs from 'fs/promises'
import path from 'path'
import { ids } from '../src/lexicon/lexicons'
import { FEEDS } from '../src/algos/list-feed'

// Publishes every feed defined in FEEDS (src/algos/list-feed.ts) in one go.
// Reads handle/service/DID from env (with sensible defaults) and only prompts
// for the app password. Re-run any time to update display names / descriptions
// / avatars — putRecord upserts by rkey.
//
//   yarn publishAll
//
// Avatars: drop a square PNG or JPEG at avatars/<rkey>.{png,jpg,jpeg} and it is
// uploaded automatically. If no file is present, any existing avatar on the
// record is preserved.
//
// Env overrides: PUBLISH_HANDLE, PUBLISH_SERVICE, BLUESKY_APP_PASSWORD.

const AVATAR_DIR = path.join(__dirname, '..', 'avatars')

const run = async () => {
  dotenv.config()

  if (!process.env.FEEDGEN_SERVICE_DID && !process.env.FEEDGEN_HOSTNAME) {
    throw new Error(
      'Provide FEEDGEN_HOSTNAME (or FEEDGEN_SERVICE_DID) in your .env file',
    )
  }

  const handle = process.env.PUBLISH_HANDLE || 'publisher.coseeker.org'
  const service = process.env.PUBLISH_SERVICE || 'https://coseeker.org'

  let password = process.env.BLUESKY_APP_PASSWORD
  if (!password) {
    const ans = await inquirer.prompt([
      {
        type: 'password',
        name: 'password',
        message: `Enter the App Password for ${handle}:`,
        mask: '*',
      },
    ])
    password = ans.password
  }

  const feedGenDid =
    process.env.FEEDGEN_SERVICE_DID ?? `did:web:${process.env.FEEDGEN_HOSTNAME}`

  const agent = new AtpAgent({ service })
  await agent.login({ identifier: handle, password: password as string })
  const repo = agent.session?.did ?? ''

  console.log(`\nPublishing ${Object.keys(FEEDS).length} feeds as ${handle}`)
  console.log(`  service DID: ${feedGenDid}\n`)

  for (const [rkey, def] of Object.entries(FEEDS)) {
    const avatar = await resolveAvatar(agent, repo, rkey)
    await agent.api.com.atproto.repo.putRecord({
      repo,
      collection: ids.AppBskyFeedGenerator,
      rkey,
      record: {
        did: feedGenDid,
        displayName: def.displayName,
        description: def.description,
        avatar,
        createdAt: new Date().toISOString(),
        contentMode: AppBskyFeedDefs.CONTENTMODEUNSPECIFIED,
      },
    })
    console.log(
      `  ✓ ${rkey} — ${def.displayName}${avatar ? ' (avatar set)' : ''}`,
    )
  }

  console.log('\nAll done 🎉')
}

// Returns the blob to use for a feed's avatar: a fresh upload if an image file
// exists at avatars/<rkey>.{png,jpg,jpeg}, otherwise the avatar already on the
// record (so re-running without an image doesn't wipe it).
const resolveAvatar = async (
  agent: AtpAgent,
  repo: string,
  rkey: string,
): Promise<BlobRef | undefined> => {
  for (const ext of ['png', 'jpg', 'jpeg'] as const) {
    const file = path.join(AVATAR_DIR, `${rkey}.${ext}`)
    let img: Buffer
    try {
      img = await fs.readFile(file)
    } catch (err: any) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    const encoding = ext === 'png' ? 'image/png' : 'image/jpeg'
    const res = await agent.api.com.atproto.repo.uploadBlob(img, { encoding })
    return res.data.blob
  }

  // No new image — keep the existing avatar if the record already exists.
  try {
    const existing = await agent.api.com.atproto.repo.getRecord({
      repo,
      collection: ids.AppBskyFeedGenerator,
      rkey,
    })
    const value = existing.data.value as { avatar?: BlobRef }
    return value.avatar
  } catch {
    return undefined
  }
}

run()
