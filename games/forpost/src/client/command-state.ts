import type { Phase } from '../core/types'
import type { ConnectionState } from './transport'

export interface CommandState {
  screen: 'menu' | 'game'
  status: ConnectionState
  phase: Phase | null
  modalOpen: boolean
  confirmationOpen: boolean
}

/** Shared by button availability and dispatch; inspection/navigation remain independent. */
export function commandBlockReason(state: CommandState, fromConfirmation = false): string | null {
  if (state.screen !== 'game' || !state.phase) return 'NOT_RUNNING'
  if (state.status === 'spectating') return 'VIEW_ONLY'
  if (state.status === 'paused') return 'MATCH_PAUSED'
  if (state.status !== 'connected') return 'NETWORK'
  if (state.phase === 'finished') return 'MATCH_FINISHED'
  if (state.phase === 'operationResult') return 'PHASE'
  if (state.modalOpen || state.confirmationOpen && !fromConfirmation) return 'MODAL_OPEN'
  return null
}
