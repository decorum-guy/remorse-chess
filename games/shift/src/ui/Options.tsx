import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { text } from './copy';
import type { Language } from './copy';
import type { Preferences } from './preferences';
import { defaultPreferences, keyLabel } from './preferences';
export function ShiftModal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const list = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href],[tabindex="0"]') || [])];
        if (!list.length) return;
        if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list.at(-1)?.focus(); }
        if (!e.shiftKey && document.activeElement === list.at(-1)) { e.preventDefault(); list[0].focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [close]);
  return <div className="shift-modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}><div className="shift-modal" ref={dialog} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="shift-icon-button" onClick={close} aria-label="Close / Закрыть">×</button></header>{children}</div></div>;
}
export function Options({ preferences: p, change, close }: { preferences: Preferences; change: (p: Preferences) => void; close: () => void }) {
  const l = p.lang, t = (ru: string, en: string) => text(l, ru, en);
  const [binding, setBinding] = useState<keyof Preferences['keys'] | null>(null);
  return <ShiftModal title={t('Настройки', 'Settings')} close={close}>
    <div className="shift-options">
      <label>{t('Язык', 'Language')}<select value={p.lang} onChange={e => change({ ...p, lang: e.target.value as Language })}><option value="ru">Русский</option><option value="en">English</option></select></label>
      <label>{t('Вид этажа', 'Floor view')}<select value={p.mode} onChange={e => change({ ...p, mode: e.target.value as Preferences['mode'] })}><option value="3d">2.5D</option><option value="2d">2D</option></select></label>
      <label>{t('Качество', 'Quality')}<select value={p.quality} onChange={e => change({ ...p, quality: e.target.value as Preferences['quality'] })}><option value="high">{t('Высокое', 'High')}</option><option value="low">{t('Лёгкое', 'Low')}</option></select></label>
      <label>{t('Размер текста', 'Text size')}<select value={p.textScale} onChange={e => change({ ...p, textScale: Number(e.target.value) })}><option value="1">100%</option><option value="1.15">115%</option><option value="1.3">130%</option></select></label>
      <label>{t('Сигналы', 'Game sounds')}<input aria-label={t('Громкость сигналов', 'Game sound volume')} type="range" min="0" max="1" step="0.05" value={p.volume} onChange={e => change({ ...p, volume: Number(e.target.value) })} /></label>
      <label>{t('Фон арены', 'Arena ambience')}<input aria-label={t('Громкость фона', 'Ambience volume')} type="range" min="0" max="1" step="0.05" value={p.ambience} onChange={e => change({ ...p, ambience: Number(e.target.value) })} /></label>
      <label>{t('Чувствительность стика', 'Aim stick sensitivity')}<input type="range" min="0.5" max="2" step="0.1" value={p.sensitivity} onChange={e => change({ ...p, sensitivity: Number(e.target.value) })} /></label>
      <label className="shift-check"><input type="checkbox" checked={p.reducedMotion} onChange={e => change({ ...p, reducedMotion: e.target.checked })} />{t('Меньше движения камеры', 'Reduce camera motion')}</label>
      <label className="shift-check"><input type="checkbox" checked={!p.effects} onChange={e => change({ ...p, effects: !e.target.checked })} />{t('Меньше эффектов', 'Reduce effects')}</label>
    </div>
    <h3>{t('Клавиши', 'Key bindings')}</h3><p className="shift-muted">{t('Выберите действие и нажмите новую клавишу.', 'Select an action and press its new key.')}</p>
    <div className="shift-bindings">{(Object.keys(p.keys) as (keyof Preferences['keys'])[]).map(key => <button key={key} className={binding === key ? 'selected' : ''} onClick={() => setBinding(key)} onKeyDown={e => { if (binding !== key) return; e.preventDefault(); e.stopPropagation(); if (e.code === 'Escape') { setBinding(null); return; } if (['Tab', 'MetaLeft', 'ControlLeft', 'AltLeft'].includes(e.code)) return; const keys = { ...p.keys }; const duplicate = (Object.keys(keys) as (keyof typeof keys)[]).find(k => k !== key && keys[k] === e.code); if (duplicate) keys[duplicate] = keys[key]; keys[key] = e.code; change({ ...p, keys }); setBinding(null); }}>
      <span>{({ up: t('Вперёд', 'Forward'), down: t('Назад', 'Back'), left: t('Влево', 'Left'), right: t('Вправо', 'Right'), interact: t('Батарея', 'Battery'), ping: t('Метка', 'Ping') })[key]}</span><kbd>{binding === key ? '…' : keyLabel(p.keys[key])}</kbd>
    </button>)}</div>
    <button className="shift-button subtle" onClick={() => change({ ...defaultPreferences, lang: p.lang, keys: { ...defaultPreferences.keys } })}>{t('Вернуть настройки', 'Reset settings')}</button>
  </ShiftModal>;
}
