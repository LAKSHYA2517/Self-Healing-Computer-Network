import type { Snapshot } from '../api/types'
import holddown from './fixtures/holddown.json'
import linkDegradation from './fixtures/link_degradation.json'
import linkFailure from './fixtures/link_failure.json'
import noPath from './fixtures/no_path.json'
import nodeFailure from './fixtures/node_failure.json'
import offPath from './fixtures/off_path_failure.json'

// Slimmed copies of `scenario_runner.py --dump-snapshots` output (index i = after tick i was processed).
const as = (x: unknown): Snapshot[] => x as Snapshot[]
export const LINK_FAILURE = as(linkFailure)
export const LINK_DEGRADATION = as(linkDegradation)
export const NODE_FAILURE = as(nodeFailure)
export const OFF_PATH = as(offPath)
export const NO_PATH = as(noPath)
export const HOLDDOWN = as(holddown)
