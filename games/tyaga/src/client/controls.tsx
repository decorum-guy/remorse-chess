import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { TyagaAction, TyagaInput } from '../core/types';
import { NEUTRAL_INPUT } from '../core/config';
import { GameConnection } from './connection';
import { Icon } from './ui';
import type { Language } from './copy';

export type InputMode = 'walk' | 'drive' | 'tool' | 'hold';
interface PreviewKeys { rotate: (direction: -1 | 1) => void; confirm: () => void; cancel: () => void; move: (x: number, z: number) => void }
interface InputOptions { disabled: boolean; mode: InputMode; steerSign: -1 | 1; contextKey: string; preview?: PreviewKeys; action: (a: TyagaAction) => void; interact: () => void; menu: () => void; map: () => void; attachments: () => void }
export function useGameInput(connection: GameConnection, options: InputOptions) {
  const keys = useRef(new Set<string>()), stick = useRef({ x: 0, y: 0 }), brake = useRef(false), tool = useRef(0);
  const latest = useRef(options); latest.current = options;
  const clear = () => { keys.current.clear(); stick.current = { x: 0, y: 0 }; brake.current = false; tool.current = 0; connection.neutral(); };
  useEffect(() => {
    const blur = () => clear();
    const visibility = () => { if (document.hidden) clear(); };
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable) return;
      // Native dialogs own Escape, Enter and focus while open.
      if (document.querySelector('dialog[open]')) return;
      const current = latest.current;
      if (current.preview) {
        if (['Escape', 'KeyQ'].includes(event.code)) { event.preventDefault(); clear(); current.preview.cancel(); }
        else if (event.code === 'KeyR') { event.preventDefault(); if (!event.repeat) current.preview.rotate(event.shiftKey ? -1 : 1); }
        else if (event.code === 'KeyE' || event.code === 'Enter' && !/^(BUTTON|A)$/.test(target.tagName)) { event.preventDefault(); if (!event.repeat) current.preview.confirm(); }
        else if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.code)) {
          event.preventDefault(); const x = ['KeyD', 'ArrowRight'].includes(event.code) ? 1 : ['KeyA', 'ArrowLeft'].includes(event.code) ? -1 : 0;
          const y = ['KeyW', 'ArrowUp'].includes(event.code) ? 1 : ['KeyS', 'ArrowDown'].includes(event.code) ? -1 : 0;
          current.preview.move((x - y) * .3 * Math.SQRT1_2, (-x - y) * .3 * Math.SQRT1_2);
        }
        return;
      }
      if (event.code === 'Escape') { event.preventDefault(); clear(); current.menu(); return; }
      if (current.disabled) return;
      if (['Space', 'Enter'].includes(event.code) && /^(BUTTON|A)$/.test(target.tagName)) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'KeyX', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code)) { event.preventDefault(); keys.current.add(event.code); }
      if (event.repeat) return;
      if (event.code === 'Space' && current.mode === 'walk') current.action({ type: 'jump' });
      if (event.code === 'KeyE') current.interact();
      if (event.code === 'KeyQ') current.action({ type: 'release' });
      if (event.code === 'KeyR') current.action({ type: 'rotate', direction: event.shiftKey ? -1 : 1 });
      if (event.code === 'KeyF') { clear(); current.attachments(); }
      if (event.code === 'KeyM') { clear(); current.map(); }
    };
    const keyup = (event: KeyboardEvent) => { keys.current.delete(event.code); };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur); window.addEventListener('orientationchange', blur); document.addEventListener('visibilitychange', visibility);
    const timer = window.setInterval(() => {
      // The connection owns the 30 Hz send cadence. State changes and blur
      // already send one immediate release; a second timer must not flood
      // the gateway while a dialog remains open.
      if (latest.current.disabled || latest.current.preview || document.hidden) { connection.setInput({ ...NEUTRAL_INPUT }); return; }
      const k = keys.current;
      const x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + stick.current.x;
      const y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - stick.current.y;
      const mode = latest.current.mode, value: TyagaInput = { ...NEUTRAL_INPUT };
      if (mode === 'walk') { value.moveX = (x - y) * Math.SQRT1_2; value.moveZ = (-x - y) * Math.SQRT1_2; const length = Math.max(1, Math.hypot(value.moveX, value.moveZ)); value.moveX /= length; value.moveZ /= length; value.run = k.has('ShiftLeft') || k.has('ShiftRight'); value.tool = Math.max(-1, Math.min(1, tool.current + Number(k.has('KeyX')) - Number(k.has('KeyZ')))); }
      else if (mode === 'drive') { value.throttle = Math.max(-1, Math.min(1, y)); value.steer = Math.max(-1, Math.min(1, x)) * latest.current.steerSign; value.brake = brake.current || k.has('Space'); }
      else if (mode === 'tool') value.tool = k.has('Space') ? 0 : Math.max(-1, Math.min(1, tool.current + y));
      connection.setInput(value);
    }, 1000 / 30);
    return () => { clearInterval(timer); clear(); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); window.removeEventListener('orientationchange', blur); document.removeEventListener('visibilitychange', visibility); };
  }, [connection]);
  useEffect(() => { clear(); }, [options.disabled, options.mode, options.contextKey, !!options.preview]);
  return { clear, stick: (x: number, y: number) => { stick.current = { x, y }; }, brake: (held: boolean) => { brake.current = held; }, tool: (value: number) => { tool.current = value; } };
}

function HoldButton({ disabled, label, className = '', children, onHeld }: { disabled: boolean; label: string; className?: string; children: ReactNode; onHeld: (held: boolean) => void }) {
  const pointer = useRef<number | null>(null), key = useRef(false), latest = useRef(onHeld); latest.current = onHeld;
  const [held, setHeld] = useState(false);
  const update = () => { const active = pointer.current !== null || key.current; setHeld(active); latest.current(active); };
  const reset = () => { pointer.current = null; key.current = false; setHeld(false); latest.current(false); };
  useEffect(() => { if (disabled) reset(); }, [disabled]);
  useEffect(() => { const hidden = () => { if (document.hidden) reset(); }; window.addEventListener('blur', reset); window.addEventListener('orientationchange', reset); document.addEventListener('visibilitychange', hidden); return () => { window.removeEventListener('blur', reset); window.removeEventListener('orientationchange', reset); document.removeEventListener('visibilitychange', hidden); latest.current(false); }; }, []);
  const release = (event: ReactPointerEvent<HTMLButtonElement>) => { if (event.pointerId !== pointer.current) return; pointer.current = null; update(); };
  return <button className={className + (held ? ' held' : '')} aria-label={label} title={label} aria-pressed={held} disabled={disabled}
    onPointerDown={event => { if (pointer.current !== null || disabled) return; event.preventDefault(); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); update(); }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} onBlur={reset}
    onKeyDown={event => { if (!['Space', 'Enter'].includes(event.code)) return; event.preventDefault(); if (!event.repeat) { key.current = true; update(); } }}
    onKeyUp={event => { if (!['Space', 'Enter'].includes(event.code)) return; event.preventDefault(); key.current = false; update(); }}>{children}</button>;
}

interface TouchProps { mode: InputMode; contextKey: string; disabled: boolean; holding: boolean; canInteract: boolean; ferry: boolean; lang: Language; toolLabels: { negative: string; positive: string; neutral: string }; onStick: (x: number, y: number) => void; onBrake: (v: boolean) => void; onTool: (v: number) => void; onJump: () => void; onInteract: () => void; onRelease: () => void; onRotate: (direction: -1 | 1) => void }
export function TouchControls({ mode, contextKey, disabled, holding, canInteract, ferry, lang, toolLabels, onStick, onBrake, onTool, onJump, onInteract, onRelease, onRotate }: TouchProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointer = useRef<number | null>(null), tools = useRef({ negative: false, positive: false });
  const latest = useRef({ onStick, onBrake, onTool }); latest.current = { onStick, onBrake, onTool };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect(); let x = (event.clientX - bounds.left - bounds.width / 2) / 42, y = (event.clientY - bounds.top - bounds.height / 2) / 42;
    const length = Math.max(1, Math.hypot(x, y)); x /= length; y /= length; setOffset({ x: x * 32, y: y * 32 }); onStick(x, y);
  };
  const endStick = (event: ReactPointerEvent<HTMLDivElement>) => { if (pointer.current !== event.pointerId) return; pointer.current = null; setOffset({ x: 0, y: 0 }); onStick(0, 0); };
  const end = () => { pointer.current = null; tools.current = { negative: false, positive: false }; setOffset({ x: 0, y: 0 }); latest.current.onStick(0, 0); latest.current.onBrake(false); latest.current.onTool(0); };
  useEffect(() => { end(); }, [disabled, mode, contextKey]);
  useEffect(() => { const hidden = () => { if (document.hidden) end(); }; window.addEventListener('blur', end); window.addEventListener('orientationchange', end); document.addEventListener('visibilitychange', hidden); return () => { end(); window.removeEventListener('blur', end); window.removeEventListener('orientationchange', end); document.removeEventListener('visibilitychange', hidden); }; }, []);
  const toolHeld = (side: 'negative' | 'positive', held: boolean) => { tools.current[side] = held; onTool(Number(tools.current.positive) - Number(tools.current.negative)); };
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  return <div className={'ty-touch ' + (disabled ? 'disabled' : '')}>
    {mode === 'tool' ? <div className="ty-winch-touch" key={contextKey}>
      <HoldButton disabled={disabled} label={toolLabels.negative} onHeld={held => toolHeld('negative', held)}><Icon name="minus"/><span>{toolLabels.negative}</span></HoldButton>
      <button aria-label={toolLabels.neutral} disabled={disabled} onClick={() => { tools.current = { negative: false, positive: false }; onTool(0); }}><Icon name="pause"/><span>{toolLabels.neutral}</span></button>
      <HoldButton disabled={disabled} label={toolLabels.positive} onHeld={held => toolHeld('positive', held)}><Icon name="plus"/><span>{toolLabels.positive}</span></HoldButton>
    </div> : mode !== 'hold' && <div className="ty-stick" role="group" aria-label={t('Стик движения', 'Movement stick')} onPointerDown={event => { if (disabled || pointer.current !== null) return; event.preventDefault(); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); move(event); }} onPointerMove={move} onPointerUp={endStick} onPointerCancel={endStick} onLostPointerCapture={endStick}><div className="ty-stick-ring"/><div className="ty-stick-knob" style={{ transform: `translate(${offset.x}px,${offset.y}px)` }}/></div>}
    <div className="ty-touch-actions" key={`${mode}:${contextKey}`}>
      {holding && <div className="ty-touch-rotate">
        <HoldButton className="ty-touch-small" disabled={disabled} label={t('Опускать предмет', 'Lower held object')} onHeld={held => toolHeld('negative', held)}><span className="ty-carry-lower"><Icon name="jump" size={19}/></span></HoldButton>
        <HoldButton className="ty-touch-small" disabled={disabled} label={t('Поднимать предмет', 'Raise held object')} onHeld={held => toolHeld('positive', held)}><Icon name="jump" size={19}/></HoldButton>
        <button className="ty-touch-small" aria-label={t('Повернуть предмет влево на 15°', 'Rotate object left by 15°')} disabled={disabled} onClick={() => onRotate(1)}><Icon name="retry" size={19}/><span>15°</span></button><button className="ty-touch-small" aria-label={t('Повернуть предмет вправо на 15°', 'Rotate object right by 15°')} disabled={disabled} onClick={() => onRotate(-1)}><span className="ty-rotate-reverse"><Icon name="retry" size={19}/></span><span>15°</span></button>
      </div>}
      {mode === 'drive' && !ferry && <HoldButton className="ty-touch-small" disabled={disabled} label={t('Удерживать тормоз', 'Hold brake')} onHeld={onBrake}><Icon name="brake"/></HoldButton>}
      {mode === 'walk' && <button className="ty-touch-small" aria-label={t('Прыгнуть', 'Jump')} disabled={disabled} onClick={onJump}><Icon name="jump"/></button>}
      {mode === 'walk' && <button className="ty-touch-primary" aria-label={t('Взаимодействовать', 'Interact')} disabled={disabled || !canInteract} onClick={onInteract}><Icon name="hand" size={30}/></button>}
      <button className="ty-touch-small" aria-label={t('Отпустить или выйти', 'Release or exit')} disabled={disabled || mode === 'walk' && !holding} onClick={onRelease}><Icon name="exit"/></button>
    </div>
  </div>;
}
