import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export type IconName = 'arrow' | 'truck' | 'mountain' | 'water' | 'wind' | 'rope' | 'hand' | 'tool' | 'close' | 'menu' | 'map' | 'crew' | 'sound' | 'mute' | 'check' | 'flag' | 'pause' | 'retry' | 'jump' | 'brake' | 'help' | 'sun' | 'settings' | 'plus' | 'minus' | 'box' | 'link' | 'exit';
const paths: Record<IconName, ReactNode> = {
  arrow: <><path d="M4 12h15m-6-6 6 6-6 6" /></>,
  truck: <><path d="M3 7h10v10H3zm10 4h4l4 4v2h-8M15 11V8h3l3 7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></>,
  mountain: <><path d="m2 20 8-15 5 9 3-6 5 12H2Zm5-10 3 3 3-3"/></>,
  water: <><path d="M2 9q3-4 6 0t6 0 6 0M2 15q3-4 6 0t6 0 6 0"/></>,
  wind: <><path d="M3 8h13a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h6"/></>,
  rope: <><path d="M7 3v11a4 4 0 1 0 8 0v-3M4 3h6m2 8h6"/><circle cx="15" cy="5" r="3"/></>,
  hand: <><path d="M6 13V8a2 2 0 0 1 3 0V4a2 2 0 0 1 3 0v5-4a2 2 0 0 1 3 0v5-3a2 2 0 0 1 3 0v7l-2 6H9l-5-6a2 2 0 0 1 2-2Z"/></>,
  tool: <><path d="m3 20 9-9a6 6 0 0 1 7-8l-4 4 2 2 4-4a6 6 0 0 1-8 7l-9 9Z"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  map: <><path d="m3 5 6-2 6 3 6-2v15l-6 2-6-3-6 2Zm6-2v15m6-12v15"/></>,
  crew: <><circle cx="9" cy="7" r="3"/><path d="M3 21v-4a6 6 0 0 1 12 0v4M16 4a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v3"/></>,
  sound: <><path d="M4 9h4l5-5v16l-5-5H4Zm12-2a7 7 0 0 1 0 10m3-13a11 11 0 0 1 0 16"/></>,
  mute: <><path d="M4 9h4l5-5v16l-5-5H4Zm12 0 5 6m-5 0 5-6"/></>,
  check: <path d="m4 12 5 5L20 6"/>,
  flag: <><path d="M5 22V3h13l-3 5 3 5H5"/></>,
  pause: <><path d="M7 5v14M17 5v14"/></>,
  retry: <><path d="M4 9a8 8 0 1 1 0 7M4 3v6h6"/></>,
  jump: <><path d="M12 20V4m-6 6 6-6 6 6M4 21h16"/></>,
  brake: <><circle cx="12" cy="12" r="7"/><path d="M3 4a12 12 0 0 0 0 16m18-16a12 12 0 0 1 0 16M12 8v5m0 3v.1"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5m0 3v.1"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="7" cy="18" r="2"/></>,
  plus: <path d="M4 12h16M12 4v16"/>, minus: <path d="M4 12h16"/>,
  box: <><path d="m3 7 9-4 9 4v11l-9 4-9-4Zm0 0 9 4 9-4m-9 4v11"/></>,
  link: <><path d="m9 15 6-6m-7 4-2 2a3 3 0 0 0 4 4l3-3m-2-8 3-3a3 3 0 0 1 4 4l-2 2"/></>,
  exit: <><path d="M11 4H4v16h7m-1-8h12m-4-4 4 4-4 4"/></>,
};
export function Icon({ name, size = 22 }: { name: IconName; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }
export const DialogNoticeContext = createContext<{ message: string; error: boolean; closeLabel: string; onClose: () => void } | null>(null);
export function Dialog({ title, children, onClose, closeLabel = 'Закрыть / Close', className = '' }: { title: string; children: ReactNode; onClose: () => void; closeLabel?: string; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const notice = useContext(DialogNoticeContext);
  useEffect(() => { const dialog = ref.current!; const focus = document.activeElement as HTMLElement | null; dialog.showModal(); return () => { dialog.close(); focus?.focus(); }; }, []);
  return <dialog ref={ref} className={'ty-dialog ' + className} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <header><h2>{title}</h2><button className="ty-icon-button" aria-label={closeLabel} onClick={onClose}><Icon name="close"/></button>{notice && <div className={'ty-dialog-notice ' + (notice.error ? 'error' : '')} role={notice.error ? 'alert' : 'status'}><span>{notice.message}</span><button className="ty-icon-button" aria-label={notice.closeLabel} onClick={notice.onClose}><Icon name="close" size={18}/></button></div>}</header>
    <div className="ty-dialog-body">{children}</div>
  </dialog>;
}
export function MapSketch({ map, className = '' }: { map: string; className?: string }) {
  const bg = map === 'ridge' ? '#cedbda' : map === 'quarry' ? '#c4d9d6' : '#d5e1c9';
  return <svg className={'ty-map-sketch ' + className} viewBox="0 0 340 180" role="img" aria-label={map === 'ridge' ? 'Горный маршрут / Mountain route' : map === 'quarry' ? 'Маршрут через карьер / Quarry route' : 'Маршрут через долину / Valley route'}>
    <rect width="340" height="180" rx="16" fill={bg}/>
    <path d="M-20 149Q68 11 150 79T370 33M-20 170Q65 31 146 99T360 60M-20 127Q76-8 157 54T370 11" fill="none" stroke="#8ba793" strokeWidth="1" opacity=".45"/>
    {map === 'quarry' ? <><path d="M70 26q65-34 92 36t-7 104q-75 31-88-34T70 26Z" fill="#73b7bd"/><path d="m115 66 33 0 10 40-34 0Z" fill="#f1e8cc" stroke="#5b7c7b" strokeWidth="2"/></> : map === 'ridge' ? <><path d="m72 132 40-91 37 64 34-82 65 129Z" fill="#95aaa7"/><path d="m101 66 11-25 16 28-14-7-6 8Z" fill="#f1f4e9"/><path d="m170 55 13-32 24 39-23-10-4 10Z" fill="#f1f4e9"/></> : <><path d="M145-10q-20 64 11 104t-1 98" fill="none" stroke="#79b9bd" strokeWidth="27"/><path d="m129 81 48-10 3 15-48 10Z" fill="#a78458" stroke="#5c6b59" strokeWidth="2"/></>}
    <path d={map === 'ridge' ? 'M22 139 58 137 90 99 125 128 168 116 205 83 253 103 287 44 317 42' : map === 'quarry' ? 'M24 127 58 121 73 42 174 37 194 111 244 126 275 70 315 58' : 'M22 132Q81 146 112 109L155 82Q190 63 218 105T316 60'} fill="none" stroke="#f4eedb" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round"/>
    <path d={map === 'ridge' ? 'M22 139 58 137 90 99 125 128 168 116 205 83 253 103 287 44 317 42' : map === 'quarry' ? 'M24 127 58 121 73 42 174 37 194 111 244 126 275 70 315 58' : 'M22 132Q81 146 112 109L155 82Q190 63 218 105T316 60'} fill="none" stroke="#9b8e6e" strokeWidth="1.5" strokeDasharray="4 6"/>
    <circle cx="25" cy="132" r="8" fill="#D97736" stroke="#fff6df" strokeWidth="3"/>
    <circle cx="315" cy={map === 'ridge' ? '42' : '59'} r="8" fill="#397D68" stroke="#fff6df" strokeWidth="3"/>
    <path d="M294 150h25m-6-5 6 5-6 5" fill="none" stroke="#397D68" strokeWidth="2"/>
  </svg>;
}
