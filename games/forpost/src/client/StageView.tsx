import { useEffect, useRef, useState } from 'react'
import type { Point, WorldView } from '../core/types'
import { ThreeStage, type Stage, type StageState } from './scene'
import { CanvasStage } from './canvas-stage'
import type { Settings } from './settings'
import type { PredictedFighter } from './prediction'

export function StageView({ view, settings, state, onFallback, onLoadError, onMove, onLeave, onDown, onUp, onPan, onSelectRect, getPrediction }: {
  view: WorldView; settings: Settings; state: StageState; onFallback: () => void; onLoadError: (asset: string) => void
  onMove: (point: Point) => void; onDown: (point: Point, button: number, shift: boolean) => void; onUp: () => void; onPan: (delta: Point, zoom: number) => void
  onSelectRect: (a: Point, b: Point, add: boolean) => void
  getPrediction: () => PredictedFighter | null
  onLeave: () => void
}) {
  const host = useRef<HTMLDivElement>(null), stage = useRef<Stage | null>(null)
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number; moved: boolean; type: 'pan' | 'select' | 'touch'; shift: boolean } | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef(0)
  const mouse = useRef<{ x: number; y: number } | null>(null), lastAim = useRef<Point | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const callbacks = useRef({ onFallback, onLoadError, getPrediction, onMove }); callbacks.current = { onFallback, onLoadError, getPrediction, onMove }
  useEffect(() => {
    if (!host.current) return
    const element = host.current
    const options = { onFallback: () => callbacks.current.onFallback(), onLoadError: (asset: string) => callbacks.current.onLoadError(asset), getPrediction: () => callbacks.current.getPrediction() }
    try { stage.current = settings.renderer === '2d' ? new CanvasStage(host.current, settings, options) : new ThreeStage(host.current, settings, options) }
    catch { callbacks.current.onFallback(); stage.current = new CanvasStage(host.current, settings, options) }
    // Read-only presentation counters; no game state or mutation handle is exposed.
    const publishMetrics = () => { if (stage.current) element.setAttribute('data-render-metrics', JSON.stringify({ backend: stage.current instanceof ThreeStage ? 'webgl' : 'canvas2d', ...stage.current.metrics() })) }
    publishMetrics(); const metricsTimer = setInterval(publishMetrics, 1000)
    return () => { clearInterval(metricsTimer); element.removeAttribute('data-render-metrics'); stage.current?.destroy(); stage.current = null }
  }, [settings.renderer])
  useEffect(() => { stage.current?.setView(view) }, [view, settings.renderer])
  useEffect(() => { stage.current?.setSettings(settings) }, [settings])
  useEffect(() => { stage.current?.setState(state) }, [state, settings.renderer])
  useEffect(() => {
    if (settings.touch) return
    const timer = setInterval(() => {
      if (!stage.current || !mouse.current) return
      const point = stage.current.worldPoint(mouse.current.x, mouse.current.y)
      if (!lastAim.current || Math.hypot(point.x - lastAim.current.x, point.z - lastAim.current.z) > .015) { lastAim.current = point; callbacks.current.onMove(point) }
    }, 1000 / 30)
    return () => clearInterval(timer)
  }, [settings.touch])
  const tactics = view.participants.find(p => p.id === view.you)?.mode === 'tactics'
  const cancel = () => { drag.current = null; pointers.current.clear(); pinch.current = 0; setSelectionBox(null); onUp() }
  return <div className="fp-stage" ref={host} tabIndex={0} role="application" aria-label={settings.language === 'ru' ? 'Поле боя. WASD — движение, мышь — прицел, Tab — тактика.' : 'Battlefield. WASD to move, mouse to aim, Tab for tactics.'}
    onContextMenu={event => event.preventDefault()}
    onPointerMove={event => {
      if (!stage.current) return
      if (event.pointerType !== 'touch') mouse.current = { x: event.clientX, y: event.clientY }
      if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (tactics && pointers.current.size > 1) {
        const [a, b] = [...pointers.current.values()], distance = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch.current > 0) onPan({ x: 0, z: 0 }, distance / pinch.current)
        pinch.current = distance; if (drag.current) drag.current.moved = true; return
      }
      const d = drag.current
      if (d?.id === event.pointerId) {
        if (Math.hypot(event.clientX - d.startX, event.clientY - d.startY) > 6) d.moved = true
        if (d.moved && (d.type === 'pan' || d.type === 'touch')) { const previous = stage.current.worldPoint(d.x, d.y), current = stage.current.worldPoint(event.clientX, event.clientY); onPan({ x: previous.x - current.x, z: previous.z - current.z }, 1) }
        if (d.moved && d.type === 'select') { const rect = event.currentTarget.getBoundingClientRect(); setSelectionBox({ left: Math.min(d.startX, event.clientX) - rect.left, top: Math.min(d.startY, event.clientY) - rect.top, width: Math.abs(event.clientX - d.startX), height: Math.abs(event.clientY - d.startY) }) }
        d.x = event.clientX; d.y = event.clientY
      }
      const point = stage.current.worldPoint(event.clientX, event.clientY); lastAim.current = point; onMove(point)
    }}
    onPointerDown={event => {
      if (!stage.current) return
      event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId)
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (tactics && pointers.current.size > 1) { const [a, b] = [...pointers.current.values()]; pinch.current = Math.hypot(a.x - b.x, a.y - b.y); if (drag.current) drag.current.moved = true; return }
      if (event.button === 1 || tactics && event.button === 0) drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, type: event.button === 1 ? 'pan' : event.pointerType === 'touch' ? 'touch' : 'select', shift: event.shiftKey }
      else onDown(stage.current.worldPoint(event.clientX, event.clientY), event.button, event.shiftKey)
    }}
    onPointerUp={event => {
      const d = drag.current
      if (stage.current && d?.id === event.pointerId && pointers.current.size < 2) {
        if (d.type === 'select' && d.moved) onSelectRect(stage.current.worldPoint(d.startX, d.startY), stage.current.worldPoint(event.clientX, event.clientY), d.shift)
        else if (!d.moved && d.type !== 'pan') onDown(stage.current.worldPoint(event.clientX, event.clientY), 0, d.shift)
      }
      pointers.current.delete(event.pointerId); drag.current = null; pinch.current = 0; setSelectionBox(null); onUp()
    }} onPointerCancel={cancel} onLostPointerCapture={event => { if (pointers.current.has(event.pointerId)) cancel(); else onUp() }}
    onPointerLeave={() => { mouse.current = null; lastAim.current = null; onLeave() }}
    onWheel={event => { if (tactics) onPan({ x: 0, z: 0 }, event.deltaY < 0 ? 1.12 : .9) }}
  >{selectionBox && <div aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none', zIndex: 2, border: '1px solid #47c9e5', background: '#47c9e522', ...selectionBox }} />}</div>
}
