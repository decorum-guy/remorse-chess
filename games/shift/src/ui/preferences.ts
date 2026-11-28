import type { Language } from './copy';
export interface Preferences { lang: Language; mode: '3d' | '2d'; quality: 'low' | 'high'; reducedMotion: boolean; effects: boolean; volume: number; ambience: number; sensitivity: number; textScale: number; keys: Record<'up' | 'left' | 'down' | 'right' | 'interact' | 'ping', string>; }
export const defaultPreferences: Preferences = { lang: 'ru', mode: '3d', quality: 'high', reducedMotion: false, effects: true, volume: 0.5, ambience: 0.12, sensitivity: 1, textScale: 1, keys: { up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD', interact: 'KeyE', ping: 'KeyQ' } };
export function readPreferences(initialLanguage?: Language): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem('iva-shift.preferences.v1') || 'null') as Partial<Preferences> | null;
    return { ...defaultPreferences, lang: initialLanguage || defaultPreferences.lang, quality: typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 'low' : 'high', reducedMotion: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches, ...saved, keys: { ...defaultPreferences.keys, ...saved?.keys } };
  } catch { return { ...defaultPreferences, lang: initialLanguage || defaultPreferences.lang, keys: { ...defaultPreferences.keys } }; }
}
export function writePreferences(value: Preferences) { try { localStorage.setItem('iva-shift.preferences.v1', JSON.stringify(value)); } catch { /* Private storage can be disabled. */ } }
export function keyLabel(code: string) { return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', ''); }
