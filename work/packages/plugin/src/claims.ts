/** The one definition of a worker claim id — a node's binding AND the worker's session id; the
 *  full-shape match is provenance, so a notice from a worker started BEFORE a restart is recognized.
 * @module @avantf/dsh-work/claims */
import { defaultNewId } from '@avantf/work-core'

export const CLAIM_ID_PREFIX = 'work-'

const CLAIM_ID = /^work-[0-9a-f]{8}$/

export function newClaimId(): string {
  return `${CLAIM_ID_PREFIX}${defaultNewId()}`
}

export function isWorkerClaimId(sessionId: string): boolean {
  return CLAIM_ID.test(sessionId)
}
