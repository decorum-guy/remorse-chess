import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { text, type Language } from './copy'
import type { Settings } from './settings'

const iconPaths: Record<string, ReactNode> = {
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  target: <><circle cx="12" cy="12" r="7" /><path d="M12 2v5m0 10v5M2 12h5m10 0h5" /></>,
  tactics: <><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" /></>,
  reload: <><path d="M19 7a8 8 0 1 0 1 9M19 2v6h-6" /></>,
  power: <path d="m14 2-9 12h7l-2 8 9-12h-7z" />,
  credits: <><path d="m12 2 9 5v10l-9 5-9-5V7z" /><path d="M15 8h-5v8h5" /></>,
  volume: <><path d="M4 9h4l5-4v14l-5-4H4zM17 8c3 2 3 6 0 8m3-12c5 4 5 12 0 16" /></>,
  mute: <><path d="M4 9h4l5-4v14l-5-4H4zM17 9l5 6m0-6-5 6" /></>,
  health: <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" />,
  check: <path d="m4 12 5 5L20 6" />,
  move: <path d="M12 2v20M2 12h20m-15-5-5 5 5 5m10-10 5 5-5 5M7 7l5-5 5 5M7 17l5 5 5-5" />,
  build: <><path d="m4 20 9-9m-4-7 3-2 10 10-3 3zM3 17l4 4" /></>,
  shield: <path d="m12 2 8 4v7c0 5-8 9-8 9S4 18 4 13V6z" />,
  transport: <><path d="M3 7h12v10H3zM15 10h4l3 4v3h-7M6 17v3m12-3v3M1 17h22" /></>,
  bot: <><path d="M4 7h16v13H4zM12 2v5M8 12h1m6 0h1M8 16h8" /></>,
  book: <><path d="M12 5c-4-3-9-2-9-2v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2v16" /></>,
  settings: <><path d="M4 5h16M4 12h16M4 19h16" /><path d="M8 2v6M16 9v6M10 16v6" /></>,
  chevron: <path d="m8 5 7 7-7 7" />,
}
export function Icon({ name, size = 20 }: { name: string; size?: number }) { return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="square" aria-hidden="true">{iconPaths[name] ?? iconPaths.target}</svg> }
export function AssetIcon({ name, size = 36 }: { name: string; size?: number }) { return <img width={size} height={size} className="fp-asset-icon" alt="" src={`${import.meta.env.BASE_URL}assets/forpost/icons/${name}.svg`} onError={event => { event.currentTarget.style.visibility = 'hidden' }} /> }
export function Dialog({ title, lang, onClose, children, className = '' }: { title: string; lang: Language; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.querySelector<HTMLElement>('button, input, select, a[href]')?.focus()
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current() }
      if (event.key === 'Tab') { const elements = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input,select,a[href],[tabindex="0"]') ?? [])]; const first = elements[0], last = elements.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
    }
    window.addEventListener('keydown', handle); return () => { window.removeEventListener('keydown', handle); previous?.focus({ preventScroll: true }) }
  }, [])
  return <div className="fp-modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}><div ref={ref} className={`fp-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="fp-icon-button" onClick={onClose} aria-label={text(lang, 'Закрыть', 'Close')}><Icon name="close" /></button></header>{children}</div></div>
}
export function SettingsPanel({ settings, onChange, onClose }: { settings: Settings; onChange: (value: Settings) => void; onClose: () => void }) {
  const lang = settings.language, t = (ru: string, en: string) => text(lang, ru, en)
  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })
  return <Dialog title={t('Настройки', 'Settings')} lang={lang} onClose={onClose}>
    <div className="fp-settings-grid">
      <label>{t('Язык', 'Language')}<select value={lang} onChange={e => update({ language: e.target.value as Language })}><option value="ru">Русский</option><option value="en">English</option></select></label>
      <label>{t('Размер текста', 'Text size')}<select value={settings.textScale} onChange={e => update({ textScale: Number(e.target.value) })}><option value="1">100%</option><option value="1.15">115%</option><option value="1.3">130%</option></select></label>
      <label>{t('Отображение', 'Display')}<select value={settings.renderer} onChange={e => update({ renderer: e.target.value as '3d' | '2d' })}><option value="3d">3D</option><option value="2d">2D</option></select></label>
      <label>{t('Детализация', 'Quality')}<select value={settings.quality} onChange={e => update({ quality: e.target.value as 'high' | 'low' })}><option value="high">{t('Высокая', 'High')}</option><option value="low">{t('Низкая', 'Low')}</option></select></label>
    </div>
    <div className="fp-sliders">{([['master', t('Общая громкость', 'Master volume')], ['effects', t('Эффекты', 'Effects')], ['interfaceVolume', t('Интерфейс', 'Interface')]] as const).map(([key, label]) => <label key={key}>{label}<span>{Math.round(settings[key] * 100)}%</span><input type="range" min="0" max="1" step=".05" value={settings[key]} onChange={e => update({ [key]: Number(e.target.value) })} /></label>)}</div>
    <label className="fp-check"><input type="checkbox" checked={settings.muted} onChange={e => update({ muted: e.target.checked })} />{t('Без звука', 'Mute all sounds')}</label>
    <label className="fp-check"><input type="checkbox" checked={settings.reducedMotion} onChange={e => update({ reducedMotion: e.target.checked })} />{t('Меньше движения', 'Reduced motion')}</label>
    <label className="fp-check"><input type="checkbox" checked={settings.assist} onChange={e => update({ assist: e.target.checked })} />{t('Мягкая помощь прицеливанию', 'Gentle aim assist')}</label>
    <label className="fp-check"><input type="checkbox" checked={settings.touch} onChange={e => update({ touch: e.target.checked })} />{t('Экранные джойстики', 'On-screen controls')}</label>
    <button className="fp-button primary wide" onClick={onClose}>{t('Готово', 'Done')}</button>
  </Dialog>
}
export function Meter({ value, max, label, tone = 'cyan' }: { value: number; max: number; label: string; tone?: string }) { return <div className={`fp-meter ${tone}`} aria-label={`${label}: ${Math.round(value)} / ${max}`}><div style={{ width: `${Math.max(0, Math.min(100, value / max * 100))}%` }} /></div> }
