import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Language } from './copy';
import { text } from './copy';
function Stick({ label, onChange }: { label: string; onChange: (x: number, z: number) => void }) {
  const [position, setPosition] = useState({ x: 0, z: 0 });
  const pointer = useRef<number | null>(null);
  const update = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(); const radius = Math.min(rect.width, rect.height) / 2;
    let x = (event.clientX - rect.x - radius) / (radius * 0.75), z = (event.clientY - rect.y - radius) / (radius * 0.75);
    const length = Math.hypot(x, z); if (length > 1) { x /= length; z /= length; }
    if (length < 0.12) { x = 0; z = 0; }
    setPosition({ x, z }); onChange(x, z);
  };
  const release = () => { pointer.current = null; setPosition({ x: 0, z: 0 }); onChange(0, 0); };
  return <div className="shift-stick" aria-label={label} role="group" onPointerDown={e => { pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); update(e); }} onPointerMove={e => { if (pointer.current === e.pointerId) update(e); }} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}><span style={{ transform: `translate(${position.x * 28}px,${position.z * 28}px)` }} /><small>{label}</small></div>;
}
export function TouchControls({ lang, onMove, onAim, onFire, onInteract, onPing }: { lang: Language; onMove: (x: number, z: number) => void; onAim: (x: number, z: number) => void; onFire: (held: boolean) => void; onInteract: () => void; onPing: () => void }) {
  return <div className="shift-touch-controls"><Stick label={text(lang, 'Ход', 'Move')} onChange={onMove} /><div className="shift-touch-buttons"><button onClick={onPing} aria-label={text(lang, 'Поставить метку', 'Place ping')}>◎</button><button onClick={onInteract} aria-label={text(lang, 'Взять или сбросить батарею', 'Pick up or drop battery')}>ϟ</button><button className="fire" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); onFire(true); }} onPointerUp={() => onFire(false)} onPointerCancel={() => onFire(false)} onLostPointerCapture={() => onFire(false)} aria-label={text(lang, 'Выстрел', 'Fire')}>⊕</button></div><Stick label={text(lang, 'Прицел', 'Aim')} onChange={onAim} /></div>;
}
