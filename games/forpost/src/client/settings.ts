import type { Language } from './copy'
export interface Settings {
  language: Language; master: number; effects: number; interfaceVolume: number; muted: boolean
  reducedMotion: boolean; textScale: number; assist: boolean; renderer: '3d' | '2d'; quality: 'high' | 'low'; touch: boolean
}
export const SETTINGS_KEY = 'iva.forpost.settings.v1'
export function loadSettings(): Settings {
  const touch = window.matchMedia('(pointer: coarse)').matches
  const defaults: Settings = { language: 'ru', master: .7, effects: .8, interfaceVolume: .6, muted: false, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, textScale: 1, assist: touch, renderer: '3d', quality: touch ? 'low' : 'high', touch }
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    if (!value || typeof value !== 'object') return defaults
    const number = (key: 'master' | 'effects' | 'interfaceVolume', fallback: number) => typeof value[key] === 'number' && Number.isFinite(value[key]) ? Math.min(1, Math.max(0, value[key])) : fallback
    const boolean = (key: 'muted' | 'reducedMotion' | 'assist' | 'touch') => typeof value[key] === 'boolean' ? value[key] : defaults[key]
    return { language: value.language === 'en' ? 'en' : 'ru', master: number('master', defaults.master), effects: number('effects', defaults.effects), interfaceVolume: number('interfaceVolume', defaults.interfaceVolume), muted: boolean('muted'), reducedMotion: boolean('reducedMotion'), assist: boolean('assist'), touch: boolean('touch'), renderer: value.renderer === '2d' ? '2d' : '3d', quality: value.quality === 'low' || value.quality === 'high' ? value.quality : defaults.quality, textScale: [1, 1.15, 1.3].includes(value.textScale) ? value.textScale : 1 }
  } catch { return defaults }
}
export function saveSettings(settings: Settings): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* Settings remain usable when browser storage is full. */ } }
