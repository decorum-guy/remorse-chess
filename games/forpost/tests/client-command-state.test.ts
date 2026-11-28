import { describe, expect, it } from 'vitest'
import { commandBlockReason, type CommandState } from '../src/client/command-state'

const playable: CommandState = { screen: 'game', status: 'connected', phase: 'battle', modalOpen: false, confirmationOpen: false }

describe('command availability shared by UI and dispatch', () => {
  it.each(['preparation', 'battle', 'overtime'] as const)('permits commands in %s when this device controls the game', phase => {
    expect(commandBlockReason({ ...playable, phase })).toBeNull()
  })
  it.each([
    ['connecting', 'NETWORK'], ['reconnecting', 'NETWORK'], ['error', 'NETWORK'],
    ['paused', 'MATCH_PAUSED'], ['spectating', 'VIEW_ONLY'],
  ] as const)('blocks %s commands with a reason, including already-open confirmations', (status, reason) => {
    expect(commandBlockReason({ ...playable, status })).toBe(reason)
    expect(commandBlockReason({ ...playable, status, confirmationOpen: true }, true)).toBe(reason)
  })
  it.each([['operationResult', 'PHASE'], ['finished', 'MATCH_FINISHED']] as const)('blocks commands in %s even with a connected socket', (phase, reason) => {
    expect(commandBlockReason({ ...playable, phase })).toBe(reason)
    expect(commandBlockReason({ ...playable, phase, confirmationOpen: true }, true)).toBe(reason)
  })
  it('blocks the menu and a loading game without a view', () => {
    expect(commandBlockReason({ ...playable, screen: 'menu' })).toBe('NOT_RUNNING')
    expect(commandBlockReason({ ...playable, phase: null })).toBe('NOT_RUNNING')
  })
  it('allows only the confirmation action through its own modal, without bypassing other dialogs', () => {
    expect(commandBlockReason({ ...playable, confirmationOpen: true })).toBe('MODAL_OPEN')
    expect(commandBlockReason({ ...playable, confirmationOpen: true }, true)).toBeNull()
    expect(commandBlockReason({ ...playable, modalOpen: true }, true)).toBe('MODAL_OPEN')
    expect(commandBlockReason({ ...playable, modalOpen: true, confirmationOpen: true }, true)).toBe('MODAL_OPEN')
  })
})
