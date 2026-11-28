import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ROOM_IDS } from '../core/arenas';
import { roomOrigin } from '../core/geometry';
import type { ShiftView, Vec2 } from '../core/types';
import { drawOverlay, drawPlan, interpolatedActors } from './draw';
import { canonicalAimPoint, presentationTick } from './presentation';
import { ShiftThreeScene } from './three-scene';
import type { ShiftRendererProps } from './types';

/** Public-view renderer; changing mode never creates a match or reconnects transport. */
export function ShiftRenderer(props: ShiftRendererProps) {
  const hostRef = useRef<HTMLDivElement>(null), sceneCanvasRef = useRef<HTMLCanvasElement>(null), overlayRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props), previousRef = useRef<ShiftView | null>(null), receivedRef = useRef(performance.now());
  const [failed, setFailed] = useState(false);
  const sceneRef = useRef<ShiftThreeScene | null>(null), projectionRef = useRef({ width: 1, height: 1, scale: 1, centerX: 8, centerZ: 8 });
  const tickRef = useRef(props.view.tick), draggingRef = useRef(false);
  const mouseRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const actualMode = props.mode === '2d' || failed ? '2d' : '3d';

  useEffect(() => {
    if (propsRef.current.view !== props.view) { previousRef.current = propsRef.current.view; receivedRef.current = performance.now(); }
    propsRef.current = props;
  }, [props]);

  useEffect(() => {
    if (props.mode === '3d') setFailed(false);
  }, [props.mode]);

  useEffect(() => {
    if (actualMode === '2d') propsRef.current.onViewportReady?.();
  }, [actualMode]);

  useEffect(() => {
    const clear = () => { mouseRef.current = null; };
    const pointer = (event: PointerEvent) => { if (event.pointerType === 'touch') clear(); };
    window.addEventListener('pointerdown', pointer, true); window.addEventListener('blur', clear);
    return () => { window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('blur', clear); };
  }, []);

  useEffect(() => {
    const canvas = sceneCanvasRef.current;
    if (!canvas || actualMode !== '3d') return;
    const fallBack = () => { setFailed(true); propsRef.current.onModeFallback?.(); };
    const lost = (event: Event) => { event.preventDefault(); fallBack(); };
    canvas.addEventListener('webglcontextlost', lost);
    try { sceneRef.current = new ShiftThreeScene(canvas, () => propsRef.current.onViewportReady?.(), fallBack); }
    catch { fallBack(); }
    return () => { canvas.removeEventListener('webglcontextlost', lost); sceneRef.current?.dispose(); sceneRef.current = null; };
  }, [actualMode]);

  useEffect(() => {
    const host = hostRef.current, overlay = overlayRef.current;
    if (!host || !overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    let raf = 0, running = true, frames = 0, frameStart = performance.now();
    let width = 1, height = 1, dpr = 1;
    const size = () => {
      const rect = host.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2); overlay.width = Math.round(width * dpr); overlay.height = Math.round(height * dpr);
    };
    const resize = new ResizeObserver(size); resize.observe(host); size();
    function frame(now: number) {
      if (!running || !ctx) return;
      const p = propsRef.current, v = p.view, elapsed = Math.max(0, now - receivedRef.current);
      // Visual interpolation is capped; a missing snapshot cannot keep a drone running.
      const tick = presentationTick(v, elapsed, p.reducedMotion);
      const effectTick = v.tick + elapsed * .03;
      tickRef.current = tick;
      const predicted = p.getPredictedSelf?.();
      const actors = interpolatedActors(v, previousRef.current, Math.min(1, elapsed / 66.667)).map(actor =>
        predicted && actor.seatId === v.self.seatId && predicted.seatId === actor.seatId
          ? { ...actor, spaceId: predicted.spaceId, x: predicted.x, z: predicted.z, aim: predicted.aim }
          : actor);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      const scene = sceneRef.current;
      if (actualMode === '3d' && scene) {
        scene.resize(width, height, p.quality === 'high'); scene.render(p, tick, actors);
        drawOverlay(ctx, p, tick, scene.project, actors, false, effectTick);
      } else {
        ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, width, height);
        const scale = Math.min((width - 20) / 33, (height - 20) / 25);
        projectionRef.current = { width, height, scale, centerX: 8, centerZ: 8 };
        const project = (x: number, z: number) => ({ x: width / 2 + (x - 8) * scale, y: height / 2 + (z - 8) * scale });
        ctx.strokeStyle = '#20313a'; ctx.lineWidth = .6;
        for (let x = -10; x <= 26; x++) { const a = project(x, -5), b = project(x, 21); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        for (let z = -5; z <= 21; z++) { const a = project(-10, z), b = project(26, z); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        drawPlan(ctx, p, tick, project, actors); drawOverlay(ctx, p, tick, project, actors, true, effectTick);
      }
      // With a fixed/2D camera, a stationary cursor is still a new direction when
      // the pilot moves. Reproject after this frame's camera update. A touch
      // gesture clears mouse ownership, so a stick is never overwritten here.
      if (p.view.self.role === 'pilot' && mouseRef.current) {
        const point = worldPoint(mouseRef.current);
        if (point) p.onWorldAim?.(point);
      }
      frames++;
      if (now - frameStart >= 1000) { host!.dataset.fps = (frames * 1000 / (now - frameStart)).toFixed(1); frames = 0; frameStart = now; }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => { running = false; cancelAnimationFrame(raf); resize.disconnect(); };
  }, [actualMode]);

  function worldPoint(event: { clientX: number; clientY: number }): Vec2 | null {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const projection = projectionRef.current;
    const point = actualMode === '3d' && sceneRef.current ? sceneRef.current.unproject(x, y)
      : { x: projection.centerX + (x - projection.width / 2) / projection.scale, z: projection.centerZ + (y - projection.height / 2) / projection.scale };
    return canonicalAimPoint(propsRef.current.view, point, tickRef.current);
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const point = worldPoint(event);
    if (!point) return;
    const view = propsRef.current.view;
    event.currentTarget.focus({ preventScroll: true });
    if (view.self.role === 'navigator') {
      const room = ROOM_IDS.find(id => { const o = roomOrigin(view.board, id, view.motion, tickRef.current); return Math.abs(point.x - o.x) <= 3.95 && Math.abs(point.z - o.z) <= 3.95; });
      if (room) propsRef.current.onRoomSelect?.(room);
    } else if (event.button === 0 && event.pointerType !== 'touch') {
      mouseRef.current = { clientX: event.clientX, clientY: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId); draggingRef.current = true;
      propsRef.current.onWorldAim?.(point); propsRef.current.onFireChange?.(true);
    }
  }
  function pointerUp() {
    if (draggingRef.current) { draggingRef.current = false; propsRef.current.onFireChange?.(false); }
    const mouse = mouseRef.current, rect = hostRef.current?.getBoundingClientRect();
    if (mouse && rect && (mouse.clientX < rect.left || mouse.clientX > rect.right || mouse.clientY < rect.top || mouse.clientY > rect.bottom)) mouseRef.current = null;
  }
  const label = (props.lang ?? 'ru') === 'ru' ? 'Тактический этаж. Север сверху. Выберите комнату или управляйте пилотом.' : 'Tactical floor. North is up. Select a room or control your pilot.';
  return <div ref={hostRef} className={props.className ?? 'shift-renderer'} data-shift-renderer={actualMode} data-testid="shift-scene"
    tabIndex={0} role="application" aria-label={label}
    onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp}
    onPointerMove={event => { if (propsRef.current.view.self.role === 'pilot' && event.pointerType !== 'touch') { mouseRef.current = { clientX: event.clientX, clientY: event.clientY }; const point = worldPoint(event); if (point) propsRef.current.onWorldAim?.(point); } }}
    onPointerLeave={() => { if (!draggingRef.current) mouseRef.current = null; }}
    onContextMenu={event => event.preventDefault()} onBlur={() => { mouseRef.current = null; pointerUp(); }}
    style={{ position: 'relative', width: '100%', height: '100%', minHeight: 180, overflow: 'hidden', background: '#101820', touchAction: 'none' }}>
    {actualMode === '3d' && <canvas ref={sceneCanvasRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />}
    <canvas ref={overlayRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
  </div>;
}
