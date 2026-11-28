import type { Input, Point } from '../core/types'

export type ToolInputSource = number | ' ' | 'Enter'
export class Controls {
  value: Input = { moveX: 0, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0, toolHeld: false, assist: false }
  private keys = new Set<string>()
  private moveTouch: Point = { x: 0, z: 0 }
  private fireSources = new Set<'mouse' | 'touch' | 'touch-aim'>()
  private toolSources = new Set<ToolInputSource>()
  private disabled = false
  private listeners: [EventTarget, string, EventListener][] = []
  constructor(private shortcut: (key: string) => void) {
    const listen = (target: EventTarget, type: string, listener: EventListener) => { target.addEventListener(type, listener); this.listeners.push([target, type, listener]) }
    listen(window, 'keydown', ((event: KeyboardEvent) => {
      if (this.disabled || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return
      if (target && /^(BUTTON|A)$/.test(target.tagName) && [' ', 'Tab', 'Enter'].includes(event.key)) return
      const key = /^Key[WASDRB]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase(); if (['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'].includes(key)) { event.preventDefault(); if (event.repeat && !this.keys.has(key)) return; this.keys.add(key); this.move() }
      else if (['r', ' ', 'tab', 'escape', 'b', 'delete', '1', '2', '3', '4'].includes(key)) { event.preventDefault(); if (!event.repeat) this.shortcut(key) }
    }) as EventListener)
    listen(window, 'keyup', ((event: KeyboardEvent) => { this.keys.delete(/^Key[WASD]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase()); this.move(); if (event.key === ' ' || event.key === 'Enter') this.tool(false, event.key) }) as EventListener)
    listen(window, 'blur', () => this.neutral())
    listen(document, 'visibilitychange', () => { if (document.hidden) this.neutral() })
    listen(window, 'orientationchange', () => this.neutral())
    listen(window, 'pointerup', ((event: PointerEvent) => { this.fire(false, 'mouse'); if (Number.isFinite(event.pointerId)) this.tool(false, event.pointerId) }) as EventListener)
    listen(window, 'pointercancel', () => this.neutral())
  }
  private move(): void {
    const x = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0) + this.moveTouch.x
    const z = (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0) - (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0) + this.moveTouch.z
    const length = Math.max(1, Math.hypot(x, z)); this.value.moveX = this.disabled ? 0 : x / length; this.value.moveZ = this.disabled ? 0 : z / length
  }
  aim(direction: Point): void { const length = Math.hypot(direction.x, direction.z); if (length > .001) { this.value.aimX = direction.x / length; this.value.aimZ = direction.z / length } }
  fire(held: boolean, source: 'mouse' | 'touch' | 'touch-aim'): void {
    if (this.disabled) { if (!held) this.fireSources.delete(source); this.value.fireHeld = false; return }
    if (held && !this.disabled && !this.value.fireHeld) this.value.firePressSeq++
    if (held) this.fireSources.add(source); else this.fireSources.delete(source)
    this.value.fireHeld = !this.disabled && this.fireSources.size > 0
  }
  tool(held: boolean, source: ToolInputSource = ' '): void {
    if (held && !this.disabled) this.toolSources.add(source); else this.toolSources.delete(source)
    this.value.toolHeld = !this.disabled && this.toolSources.size > 0
  }
  touchMove(point: Point): void { this.moveTouch = point; this.move() }
  setDisabled(value: boolean): void { if (value && !this.disabled) this.neutral(); this.disabled = value }
  neutral(): void { this.keys.clear(); this.moveTouch = { x: 0, z: 0 }; this.fireSources.clear(); this.toolSources.clear(); this.value.moveX = 0; this.value.moveZ = 0; this.value.fireHeld = false; this.value.toolHeld = false }
  destroy(): void { this.neutral(); for (const [target, name, listener] of this.listeners) target.removeEventListener(name, listener) }
}
