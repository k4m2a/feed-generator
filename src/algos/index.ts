import { AppContext } from '../config'
import {
  QueryParams,
  OutputSchema as AlgoOutput,
} from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { FEEDS, makeListFeed } from './list-feed'

type AlgoHandler = (ctx: AppContext, params: QueryParams) => Promise<AlgoOutput>

const algos: Record<string, AlgoHandler> = Object.fromEntries(
  Object.entries(FEEDS).map(([rkey, def]) => [rkey, makeListFeed(def.listUri)]),
)

export default algos
