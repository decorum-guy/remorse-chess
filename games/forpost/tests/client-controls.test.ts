import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Controls } from '../src/client/controls'

class FocusElement { constructor(public tagName: string, public isContentEditable = false) {} }
let surface: EventTarget, documentSurface: EventTarget & { hidden: boolean }, controls: Controls
const shortcut = vi.fn<(key: string) => void>()
function dispatch(type: string, fields: Record<string, unknown> = {}, target?: FocusElement): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), fields)
  if (target) Object.defineProperty(event, 'target', { value: target })
  surface.dispatchEvent(event)
  return event
}
function key(type: 'keydown' | 'keyup', value: string, target?: FocusElement, modifiers: Record<string, unknown> = {}): Event {
  return dispatch(type, { key: value, code: /^[wasdrb]$/i.test(value) ? `Key${value.toUpperCase()}` : '', repeat: false, ...modifiers }, target)
}
beforeEach(() => {
  surface = new EventTarget(); documentSurface = Object.assign(new EventTarget(), { hidden: false }); shortcut.mockClear()
  vi.stubGlobal('window', surface); vi.stubGlobal('document', documentSurface); vi.stubGlobal('HTMLElement', FocusElement)
  controls = new Controls(shortcut)
})
afterEach(() => { controls.destroy(); vi.unstubAllGlobals() })

describe('client input ownership and focus', () => {
  it('keeps the tool held when the movement finger releases and stops only for its owning pointer', () => {
    controls.tool(true, 11); controls.touchMove({ x: 1, z: 0 })
    controls.touchMove({ x: 0, z: 0 }); dispatch('pointerup', { pointerId: 22 })
    expect(controls.value.toolHeld).toBe(true)
    dispatch('pointerup', { pointerId: 11 }); expect(controls.value.toolHeld).toBe(false)
  })
  it('tracks keyboard and pointer tool holds independently', () => {
    controls.tool(true); controls.tool(true, 7)
    key('keyup', ' '); expect(controls.value.toolHeld).toBe(true)
    dispatch('pointerup', { pointerId: 7 }); expect(controls.value.toolHeld).toBe(false)
    controls.tool(true); controls.tool(true, 8)
    dispatch('pointerup', { pointerId: 8 }); expect(controls.value.toolHeld).toBe(true)
    key('keyup', ' '); expect(controls.value.toolHeld).toBe(false)
  })
  it('releases an Enter tool hold globally after focus moves to another element', () => {
    controls.tool(true, 'Enter')
    key('keyup', 'Enter', new FocusElement('BUTTON'))
    expect(controls.value.toolHeld).toBe(false)
  })
  it('preserves a simultaneous Space tool hold when Enter releases and vice versa', () => {
    controls.tool(true, 'Enter'); controls.tool(true, ' ')
    key('keyup', 'Enter', new FocusElement('A')); expect(controls.value.toolHeld).toBe(true)
    key('keyup', ' ', new FocusElement('A')); expect(controls.value.toolHeld).toBe(false)
    controls.tool(true, 'Enter'); controls.tool(true, ' ')
    key('keyup', ' ', new FocusElement('BUTTON')); expect(controls.value.toolHeld).toBe(true)
    key('keyup', 'Enter', new FocusElement('BUTTON')); expect(controls.value.toolHeld).toBe(false)
  })
  it.each(['blur', 'pointercancel', 'orientationchange'])('%s clears every held source while preserving the fire-press counter', event => {
    controls.tool(true, 11); controls.tool(true); controls.touchMove({ x: 1, z: 1 }); controls.fire(true, 'touch')
    const press = controls.value.firePressSeq
    dispatch(event, { pointerId: 22 })
    expect(controls.value).toMatchObject({ moveX: 0, moveZ: 0, fireHeld: false, toolHeld: false, firePressSeq: press })
    controls.tool(false, 11); expect(controls.value.toolHeld).toBe(false)
    controls.tool(true, 33); expect(controls.value.toolHeld).toBe(true)
    dispatch('pointerup', { pointerId: 33 }); expect(controls.value.toolHeld).toBe(false)
  })
  it('does not retain pointer holds through a hidden document or disabled controls', () => {
    controls.tool(true, 1); documentSurface.hidden = true; documentSurface.dispatchEvent(new Event('visibilitychange'))
    expect(controls.value.toolHeld).toBe(false)
    documentSurface.hidden = false; controls.tool(true, 2); controls.setDisabled(true); controls.tool(true, 3)
    expect(controls.value.toolHeld).toBe(false)
    controls.setDisabled(false); controls.tool(false, 2); expect(controls.value.toolHeld).toBe(false)
  })
  it.each(['BUTTON', 'A'])('allows movement from a focused %s while preserving native activation and focus keys', tag => {
    const target = new FocusElement(tag)
    expect(key('keydown', 'w', target).defaultPrevented).toBe(true); expect(controls.value.moveZ).toBe(-1)
    key('keyup', 'w', target); expect(controls.value.moveZ).toBe(0)
    for (const value of [' ', 'Tab', 'Enter']) expect(key('keydown', value, target).defaultPrevented).toBe(false)
    expect(shortcut).not.toHaveBeenCalled()
  })
  it.each(['INPUT', 'TEXTAREA', 'SELECT', 'contenteditable'])('leaves %s text entry untouched', tag => {
    const target = new FocusElement(tag === 'contenteditable' ? 'DIV' : tag, tag === 'contenteditable')
    for (const value of ['w', 'r', ' ']) expect(key('keydown', value, target).defaultPrevented).toBe(false)
    expect(controls.value.moveZ).toBe(0); expect(shortcut).not.toHaveBeenCalled()
  })
  it.each(['ctrlKey', 'metaKey', 'altKey'])('does not intercept %s shortcuts or movement', modifier => {
    for (const value of ['w', 'r', ' ']) expect(key('keydown', value, undefined, { [modifier]: true }).defaultPrevented).toBe(false)
    expect(controls.value.moveZ).toBe(0); expect(shortcut).not.toHaveBeenCalled()
  })
})
