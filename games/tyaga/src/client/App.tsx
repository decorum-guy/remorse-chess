import { useEffect, useRef, useState } from 'react';
import type { MapId } from '../core/types';
import { api, loadSession } from './api';
import type { Room, Session } from './api';
import type { Language } from './copy';
import { MAP_COPY, errorCopy, translated } from './copy';
import { Icon, Dialog, MapSketch } from './ui';
import { makeMenuScene } from './scene';
import { Lobby } from './Lobby';
import { Game } from './Game';

export interface Preferences { muted: boolean; volume: number; reducedMotion: boolean; flashes: boolean; shake: number; textScale: number; quality: 'high' | 'low'; hints: boolean }
const defaultPrefs: Preferences = { muted: false, volume: .6, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, flashes: true, shake: .4, textScale: 1, quality: 'high', hints: true };
function savedPrefs(): Preferences { try { return { ...defaultPrefs, ...JSON.parse(localStorage.getItem('iva.tyaga.preferences.v1') ?? '{}') }; } catch { return defaultPrefs; } }
function MenuIllustration({ reducedMotion }: { reducedMotion: boolean }) { const ref = useRef<HTMLDivElement>(null), reduced = useRef(reducedMotion); reduced.current = reducedMotion; useEffect(() => { if (!ref.current) return; try { return makeMenuScene(ref.current, () => reduced.current); } catch { return; } }, []); return <div className="ty-menu-illustration" ref={ref} aria-label="Тягач с грузом / Hauler with cargo"/>; }

export function App() {
  const [lang, setLang] = useState<Language>(() => localStorage.getItem('iva.tyaga.language') === 'en' ? 'en' : 'ru');
  const [prefs, setPrefs] = useState<Preferences>(savedPrefs);
  const [session, setSession] = useState<Session | null>(null), [rooms, setRooms] = useState<Room[]>([]), [room, setRoom] = useState<Room | null>(null);
  const [mapId, setMapId] = useState<MapId>('valley'), [mode, setMode] = useState<'expedition' | 'practice'>('expedition'), [bots, setBots] = useState(1);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [settings, setSettings] = useState(false), [rules, setRules] = useState(false);
  const [resumeAfterTutorial, setResumeAfterTutorial] = useState<Room | null>(null);
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  const fetchRooms = () => api<{ rooms: Room[] }>('/rooms').then(r => setRooms(r.rooms.filter(r => r.gameId === 'tyaga' && !['cancelled'].includes(r.state))));
  useEffect(() => {
    void loadSession().then(s => { setSession(s); if (s.user) { void fetchRooms(); const id = new URLSearchParams(location.search).get('room'); if (id) void api<{ room: Room }>(`/rooms/${id}`).then(r => { if (r.room.gameId === 'tyaga') setRoom(r.room); }).catch(e => setError(errorCopy(e.message, lang))); } }).catch(e => setError(errorCopy(e.message, lang)));
  }, []);
  useEffect(() => { localStorage.setItem('iva.tyaga.language', lang); document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { localStorage.setItem('iva.tyaga.preferences.v1', JSON.stringify(prefs)); document.documentElement.style.setProperty('--ty-text-scale', String(prefs.textScale)); }, [prefs]);
  useEffect(() => {
    if (!room || !['lobby', 'starting'].includes(room.state)) return;
    const timer = window.setInterval(() => { void api<{ room: Room }>(`/rooms/${room.roomId}`).then(r => setRoom(r.room)).catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [room?.roomId, room?.state]);
  function enterRoom(next: Room | null) { setRoom(next); const url = new URL(location.href); if (next) url.searchParams.set('room', next.roomId); else url.searchParams.delete('room'); history.replaceState(null, '', url); }
  async function create(map: MapId = mapId, tutorial = false) {
    if (!session?.user) { location.href = '/login?returnTo=' + encodeURIComponent('/play/tyaga/'); return; }
    setBusy(true); setError('');
    try {
      if (tutorial && room && room.settings.mode !== 'tutorial') setResumeAfterTutorial(room);
      let result = await api<{ room: Room }>('/rooms', { gameId: 'tyaga', capacity: 6, title: translated(MAP_COPY[map].name, lang), settings: { mapId: map, mode: tutorial ? 'tutorial' : mode } });
      const count = tutorial ? 1 : bots;
      for (let i = 0; i < count; i++) result = await api<{ room: Room }>(`/rooms/${result.room.roomId}/bots`, { difficulty: 'normal', expectedRevision: result.room.revision });
      enterRoom(result.room);
    } catch (e) { setError(errorCopy(e instanceof Error ? e.message : 'NETWORK', lang)); }
    finally { setBusy(false); }
  }
  const exitGame = () => { if (resumeAfterTutorial) { enterRoom(resumeAfterTutorial); setResumeAfterTutorial(null); } else { enterRoom(null); void fetchRooms(); } };
  if (room?.matchId && ['playing', 'finished'].includes(room.state)) return <Game key={room.matchId} room={room} lang={lang} prefs={prefs} onPrefs={setPrefs} onLanguage={setLang} onExit={exitGame} onRepeat={() => { enterRoom(null); void create((room.settings.mapId as MapId) ?? 'valley', room.settings.mode === 'tutorial'); }} onTutorial={() => void create('tutorial', true)}/>;
  if (room && session?.user) return <div className="ty-app"><Lobby room={room} user={session.user} lang={lang} onUpdate={enterRoom} onExit={() => { enterRoom(null); void fetchRooms(); }}/></div>;
  return <div className="ty-app ty-home">
    <header className="ty-home-nav"><a href="/games" className="ty-back"><Icon name="arrow"/>Iva Games</a><span className="ty-nav-label">{t('Вместе — через всё', 'Together, through it all')}</span><div><button className="ty-language" onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')} aria-label={t('Switch to English', 'Переключить на русский')}>{lang.toUpperCase()}</button><button className="ty-icon-button" aria-label={t('Настройки', 'Settings')} onClick={() => setSettings(true)}><Icon name="settings"/></button></div></header>
    <main className="ty-home-content"><section className="ty-hero"><div className="ty-hero-copy"><span className="ty-eyebrow"><span className="ty-orange-dot"/>{t('Кооперативная экспедиция', 'A cooperative expedition')}</span><h1>{lang === 'ru' ? 'ТЯГА' : 'TYAGA'}<span className="ty-title-mark" aria-hidden="true"><Icon name="arrow" size={75}/></span></h1><p className="ty-hero-line">{t('Большой груз.\nВаша общая дорога.', 'Heavy cargo.\nOne shared journey.')}</p><p className="ty-hero-description">{t('Садитесь за руль, цепляйте тросы и стройте переправы. Самые трудные места проходятся вместе.', 'Take the wheel, hook up cables and build crossings. The hardest stretches are made for a team.')}</p><div className="ty-hero-tags"><span><Icon name="crew" size={18}/>{t('2–6 персонажей', '2–6 characters')}</span><span><Icon name="tool" size={18}/>{t('Можно с ботом', 'Solo with a bot')}</span><button onClick={() => void create('tutorial', true)} disabled={busy}><Icon name="help" size={18}/>{t('Как играть', 'Learn to play')}</button></div></div><MenuIllustration reducedMotion={prefs.reducedMotion}/><div className="ty-hero-stamp"><span>H6</span><small>{t('ТЯГАЧ · ЭКСПЕДИЦИЯ', 'HAULER · EXPEDITION')}</small></div></section>
      <section className="ty-route-section"><div className="ty-section-heading"><div><span className="ty-eyebrow">{t('Следующая остановка', 'Next stop')}</span><h2>{t('Выберите свой маршрут', 'Choose your route')}</h2></div><button className="ty-text-button" onClick={() => setRules(true)}>{t('Перед дорогой', 'Before you set off')}<Icon name="arrow" size={18}/></button></div>
        <div className="ty-route-grid">{(['valley', 'quarry', 'ridge'] as MapId[]).map(id => <button key={id} className={'ty-route-card ' + (mapId === id ? 'selected' : '')} aria-pressed={mapId === id} onClick={() => setMapId(id)}><MapSketch map={id}/><div className="ty-route-body"><div className="ty-route-number">{MAP_COPY[id].number}{mapId === id && <span><Icon name="check" size={16}/>{t('Выбрано', 'Selected')}</span>}</div><h3>{translated(MAP_COPY[id].name, lang)}</h3><p>{translated(MAP_COPY[id].description, lang)}</p><span className="ty-terrain"><Icon name={id === 'valley' ? 'mountain' : id === 'quarry' ? 'water' : 'wind'} size={17}/>{translated(MAP_COPY[id].terrain, lang)}</span></div></button>)}</div>
        <div className="ty-departure"><div className="ty-inline-field"><label htmlFor="mode">{t('Режим', 'Mode')}</label><select id="mode" value={mode} onChange={e => setMode(e.target.value as 'expedition' | 'practice')}><option value="expedition">{t('Экспедиция', 'Expedition')}</option><option value="practice">{t('Практика', 'Practice')}</option></select></div><div className="ty-inline-field"><label htmlFor="bots">{t('Помощники', 'Helpers')}</label><select id="bots" value={bots} onChange={e => setBots(Number(e.target.value))}>{Array.from({ length: 6 }, (_, i) => <option key={i} value={i}>{i === 0 ? t('Только друзья', 'Friends only') : `${i} ${t(i === 1 ? 'бот' : i < 5 ? 'бота' : 'ботов', i === 1 ? 'bot' : 'bots')}`}</option>)}</select></div><button className="ty-button primary ty-depart-button" disabled={busy || !session} onClick={() => void create()}>{busy ? t('Собираем…', 'Preparing…') : !session?.user ? t('Войти и собрать команду', 'Sign in and gather a crew') : t('Собрать команду', 'Gather a crew')}<Icon name="arrow"/></button></div>
        {mode === 'practice' && <p className="ty-note">{t('Практика сохраняет физику, но отключает повреждения машины и грузов.', 'Practice keeps the physics while disabling damage to the truck and cargo.')}</p>}
        {error && <div className="ty-alert" role="alert">{error}<button className="ty-text-button" onClick={() => { void loadSession().then(setSession).catch(() => {}); setError(''); }}>{t('Повторить', 'Retry')}</button></div>}
      </section>
      {rooms.length > 0 && <section className="ty-saved"><h2>{t('Ваши экспедиции', 'Your expeditions')}</h2><div className="ty-saved-list">{rooms.slice(0, 8).map(saved => <button key={saved.roomId} onClick={() => enterRoom(saved)} className="ty-saved-card"><Icon name="truck"/><span><strong>{saved.title}</strong><small>{saved.state === 'lobby' ? t('Сбор команды', 'Gathering crew') : saved.state === 'finished' ? t('Результат', 'Result') : t('Продолжить путь', 'Continue the journey')} · {saved.members.length} {t('участника', 'players')}</small></span><Icon name="arrow"/></button>)}</div></section>}
      <footer className="ty-footer"><span>IVA GAMES / ТЯГА</span><span>{t('Грузы тяжёлые. Компания хорошая.', 'Heavy cargo. Good company.')}</span><button className="ty-text-button" onClick={() => setRules(true)}>{t('Правила и управление', 'Rules and controls')}</button></footer>
    </main>
    {settings && <Settings lang={lang} prefs={prefs} onPrefs={setPrefs} onClose={() => setSettings(false)}/>}
    {rules && <Rules lang={lang} onClose={() => setRules(false)} onTutorial={() => { setRules(false); void create('tutorial', true); }}/>} </div>;
}
export function Settings({ lang, prefs, onPrefs, onClose }: { lang: Language; prefs: Preferences; onPrefs: (v: Preferences) => void; onClose: () => void }) {
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  return <Dialog title={t('Как удобно вам', 'Make yourself comfortable')} onClose={onClose}>
    <label className="ty-setting"><span>{t('Звук', 'Sound')}</span><input type="checkbox" checked={!prefs.muted} onChange={e => onPrefs({ ...prefs, muted: !e.target.checked })}/></label>
    <label className="ty-setting"><span>{t('Громкость', 'Volume')}</span><input type="range" min="0" max="1" step=".05" value={prefs.volume} onChange={e => onPrefs({ ...prefs, volume: Number(e.target.value) })}/></label>
    <label className="ty-setting"><span>{t('Крупнее текст', 'Larger text')}</span><select aria-label={t('Крупнее текст', 'Larger text')} value={prefs.textScale} onChange={e => onPrefs({ ...prefs, textScale: Number(e.target.value) })}><option value="1">100%</option><option value="1.15">115%</option><option value="1.3">130%</option></select></label>
    <label className="ty-setting"><span>{t('Меньше движения', 'Reduced motion')}</span><input type="checkbox" checked={prefs.reducedMotion} onChange={e => onPrefs({ ...prefs, reducedMotion: e.target.checked })}/></label>
    <label className="ty-setting"><span>{t('Вспышки', 'Flashes')}</span><input type="checkbox" checked={prefs.flashes} onChange={e => onPrefs({ ...prefs, flashes: e.target.checked })}/></label>
    <label className="ty-setting"><span>{t('Тряска камеры', 'Camera shake')}</span><input type="range" min="0" max="1" step=".1" value={prefs.shake} onChange={e => onPrefs({ ...prefs, shake: Number(e.target.value) })}/></label>
    <label className="ty-setting"><span>{t('Графика', 'Graphics')}</span><select aria-label={t('Графика', 'Graphics')} value={prefs.quality} onChange={e => onPrefs({ ...prefs, quality: e.target.value as 'high' | 'low' })}><option value="high">{t('Подробная', 'Detailed')}</option><option value="low">{t('Лёгкая', 'Light')}</option></select></label>
    <label className="ty-setting"><span>{t('Подсказки', 'Hints')}</span><input type="checkbox" checked={prefs.hints} onChange={e => onPrefs({ ...prefs, hints: e.target.checked })}/></label>
    <button className="ty-button primary wide" onClick={onClose}>{t('Готово', 'Done')}<Icon name="check"/></button>
  </Dialog>;
}
export function Rules({ lang, onClose, onTutorial }: { lang: Language; onClose: () => void; onTutorial: () => void }) {
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  return <Dialog title={t('Перед дорогой', 'Before you set off')} onClose={onClose}><div className="ty-rules">
    <h3>{t('Одна команда. Три груза.', 'One crew. Three loads.')}</h3><p>{t('Доставьте машину и все три груза на станцию. Внутри зоны остановитесь, отпустите инструменты и подтвердите доставку всей командой.', 'Deliver the truck and all three loads to the station. Stop inside the marked area, release your tools and confirm delivery together.')}</p>
    <h3>{t('Вес имеет значение', 'Weight matters')}</h3><p>{t('Грузы держатся на ремнях. Один человек поднимает до 55 кг, вдвоём можно нести настил. Для тяжёлого груза используйте лебёдку и реальные крепления.', 'Straps secure the cargo. One person can lift up to 55 kg; two can carry a deck. Use winches and attachment points for heavy loads.')}</p>
    <h3>{t('Выбирайте дорогу', 'Choose your route')}</h3><p>{t('Мост или брод, крутой подъём или объезд, паром или верхняя дорога. Осмотрите препятствие и подготовьте машину. Настил должен опираться на настоящую поверхность.', 'Bridge or ford, steep climb or detour, ferry or high road. Inspect the obstacle and prepare the truck. Decks need real support.')}</p>
    <h3>{t('Стоянка и возврат', 'Checkpoint and rewind')}</h3><p>{t('На стоянке соберите машину, грузы и всех персонажей. После трёх секунд покоя можно сохранить весь мир. Возврат требует согласия людей и возвращает всё к последней стоянке.', 'Gather the truck, cargo and every character at a checkpoint. After three seconds at rest, save the entire world. Rewinding requires the human crew’s consent and restores everything to that checkpoint.')}</p>
    <div className="ty-key-grid"><span><kbd>WASD</kbd> / <kbd>↑↓←→</kbd></span><span>{t('Ходить / тяга и руль', 'Walk / throttle and steering')}</span><span><kbd>Space</kbd></span><span>{t('Прыжок / тормоз', 'Jump / brake')}</span><span><kbd>E</kbd> / <kbd>Q</kbd></span><span>{t('Действие / отпустить', 'Interact / release')}</span><span><kbd>F</kbd> / <kbd>R</kbd></span><span>{t('Крепления / повернуть', 'Attachments / rotate')}</span><span><kbd>Z</kbd> / <kbd>X</kbd></span><span>{t('Опустить / поднять предмет в руках', 'Lower / raise the held object')}</span><span><kbd>M</kbd> / <kbd>Esc</kbd></span><span>{t('Карта / меню', 'Map / menu')}</span></div>
    <p>{t('На телефоне слева стик, справа — действие, прыжок и отпускание. Масштаб меняется двумя пальцами.', 'On a phone, use the left stick and the action, jump and release buttons on the right. Pinch to zoom.')}</p>
    <button className="ty-button primary wide" onClick={onTutorial}>{t('Попробовать на площадке', 'Try the training grounds')}<Icon name="arrow"/></button>
  </div></Dialog>;
}
