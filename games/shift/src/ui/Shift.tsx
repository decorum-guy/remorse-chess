import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { getArena, worldPosition } from '../core/index';
import type { ArenaId, PilotInput, Role, RoomId, ShiftSettings, ShiftView } from '../core/types';
import { ShiftRenderer } from '../render/index';
import { arenaCopy, eventCopy, rejectCopy, roleName, teamName, text } from './copy';
import type { Language } from './copy';
import { hasLesson, hasPractice, useLocalSession, useOnlineSession } from './session';
import type { ClientSession, LocalGameConfig } from './session';
import { keyLabel, readPreferences, writePreferences } from './preferences';
import type { Preferences } from './preferences';
import { Options, ShiftModal } from './Options';
import { RoundRecap } from './RoundRecap';
import { TouchControls } from './TouchControls';
import { lessonCopy } from './lesson';
import { unlockAudio, useShiftAudio } from './audio';
import './shift.css';

export function usePreferences(initialLanguage?: Language) {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences(initialLanguage));
  useEffect(() => { writePreferences(preferences); }, [preferences]);
  return [preferences, setPreferences] as const;
}
function Logo({ lang }: { lang: Language }) { return <span className="shift-logo"><span className="shift-logo-mark" aria-hidden="true"><i /><i /><i /></span>{text(lang, 'СДВИГ', 'SHIFT')}</span>; }
function FrameHeader({ preferences, change, onSettings, back = '/games' }: { preferences: Preferences; change: (p: Preferences) => void; onSettings: () => void; back?: string }) {
  return <header className="shift-header"><a href={back} className="shift-platform-link">‹ IVA GAMES</a><Logo lang={preferences.lang} /><nav><button className="shift-icon-button shift-language" onClick={() => change({ ...preferences, lang: preferences.lang === 'ru' ? 'en' : 'ru' })}>{preferences.lang === 'ru' ? 'EN' : 'RU'}</button><button className="shift-icon-button" onClick={onSettings} aria-label={text(preferences.lang, 'Настройки', 'Settings')}>⚙</button></nav></header>;
}
export function ArenaPicker({ lang, value, change, disabled = false }: { lang: Language; value: ArenaId; change: (value: ArenaId) => void; disabled?: boolean }) {
  const languageIndex = lang === 'ru' ? 0 : 1;
  return <div className="shift-arena-picker" role="group" aria-label={text(lang, 'Арена', 'Arena')}>{(['foundry', 'calibration', 'depot'] as const).map((arena, i) => <button key={arena} aria-pressed={value === arena} disabled={disabled} className={value === arena ? 'selected' : ''} onClick={() => change(arena)}><img src={`/shift-assets/art/arena-${arena}.svg`} alt="" /><div><small>0{i + 1} <span>{value === arena ? '●' : '○'}</span></small><strong>{arenaCopy[arena].title[languageIndex]}</strong><p>{arenaCopy[arena].subtitle[languageIndex]}</p></div></button>)}</div>;
}
export function ShiftHome() {
  const [p, setP] = usePreferences(); const l = p.lang, t = (ru: string, en: string) => text(l, ru, en);
  const [settings, setSettings] = useState<ShiftSettings>({ arena: 'foundry', teamSize: 2, rotateRoles: true, difficulty: 'normal' });
  const [role, setRole] = useState<Role>('pilot'); const [game, setGame] = useState<LocalGameConfig | null>(null);
  const [modal, setModal] = useState<'settings' | 'help' | null>(null); const [saved, setSaved] = useState(hasPractice);
  const closeModal = useCallback(() => setModal(null), []);
  const start = (lesson?: Role, resume = false) => { unlockAudio(); setGame({ settings, role, seed: crypto.getRandomValues(new Uint32Array(1))[0], lesson, resume }); };
  if (game) return <LocalMatch key={`${game.seed}-${game.lesson || 'match'}`} config={game} preferences={p} change={setP} exit={() => { setGame(null); setSaved(hasPractice()); }} rematch={() => start(game.lesson)} />;
  return <div className="shift-root shift-home" style={{ '--shift-text-scale': p.textScale } as CSSProperties}>
    <FrameHeader preferences={p} change={setP} onSettings={() => setModal('settings')} />
    <main className="shift-home-main">
      <section className="shift-hero"><div className="shift-hero-copy"><p className="shift-eyebrow">{t('КОМАНДНАЯ ТАКТИКА · 2×2 / 3×3', 'TEAM TACTICS · 2×2 / 3×3')}</p><h1>{t('Двигай этаж.', 'Move the floor.')}<br /><span>{t('Меняй исход.', 'Change the outcome.')}</span></h1><p className="shift-lead">{t('Пилот ведёт бой и доставляет батарею. Штурман передвигает комнаты — вместе со всеми, кто внутри.', 'Pilots fight and deliver the battery. Navigators shift the rooms — and everyone inside them.')}</p><a className="shift-button primary shift-online-link" href="/rooms?game=shift">{t('Собрать команду', 'Gather your team')} <span>↗</span></a><button className="shift-text-button" onClick={() => setModal('help')}>{t('Как устроен матч', 'How the match works')} ↗</button></div><div className="shift-hero-art"><img src="/shift-assets/art/cover.svg" alt={t('Восемь модулей, одна шахта. Комната перевозит дронов и батарею.', 'Eight modules and one shaft. A room carries drones and the battery.')} /><div className="shift-art-note"><span>O → □</span><small>{t('ВНУТРИ КОМНАТЫ — ВНУТРИ ПЛАНА', 'YOUR ROOM. YOUR NEXT MOVE.')}</small></div></div></section>
      <section className="shift-practice-setup"><div className="shift-section-title"><div><p className="shift-eyebrow">{t('ВЫЛЕТ С БОТАМИ', 'PRACTICE FLIGHT')}</p><h2>{t('Выберите свой подход', 'Choose your approach')}</h2></div><span className="shift-muted">{t('Все три арены доступны сразу', 'All three arenas are ready')}</span></div>
        <ArenaPicker lang={l} value={settings.arena} change={arena => setSettings({ ...settings, arena })} />
        <div className="shift-launch-grid"><div className="shift-role-picker" role="group" aria-label={t('Первая роль', 'First role')}>{(['pilot', 'navigator'] as const).map(r => <button className={role === r ? 'selected' : ''} aria-pressed={role === r} onClick={() => setRole(r)} key={r}><img src={`/shift-assets/art/role-${r}.svg`} alt="" /><div><strong>{roleName(l, r)}</strong><span>{r === 'pilot' ? t('Движение · огонь · батарея', 'Movement · fire · battery') : t('Комнаты · стыки · метки', 'Rooms · doors · pings')}</span></div></button>)}</div>
          <div className="shift-practice-options"><div className="shift-segment" aria-label={t('Формат команды', 'Team format')}>{([2, 3] as const).map(size => <button key={size} aria-pressed={settings.teamSize === size} onClick={() => setSettings({ ...settings, teamSize: size })}>{size}×{size}</button>)}</div><label>{t('Боты', 'Bots')}<select value={settings.difficulty} onChange={e => setSettings({ ...settings, difficulty: e.target.value as ShiftSettings['difficulty'] })}><option value="easy">{t('Лёгкие', 'Easy')}</option><option value="normal">{t('Обычные', 'Normal')}</option><option value="hard">{t('Сложные', 'Hard')}</option></select></label><label className="shift-check"><input type="checkbox" checked={settings.rotateRoles} onChange={e => setSettings({ ...settings, rotateRoles: e.target.checked })} />{t('Смена ролей по раундам', 'Rotate roles each round')}</label></div>
          <div className="shift-launch-buttons"><button className="shift-button primary" onClick={() => start()}>{t('Начать практику', 'Start practice')} <span>→</span></button>{saved && <button className="shift-button subtle" onClick={() => start(undefined, true)}>{t('Продолжить практику', 'Continue practice')}</button>}<small>{t('Один игрок и команда ботов. Полные правила матча.', 'One player with bots. The complete match rules.')}</small></div>
        </div>
      </section>
      <section className="shift-lessons"><div><p className="shift-eyebrow">{t('ПЕРВЫЙ ВЫЛЕТ', 'FIRST FLIGHT')}</p><h2>{t('Две роли. Два коротких урока.', 'Two roles. Two short lessons.')}</h2></div><button onClick={() => start('pilot', hasLesson('pilot'))}><span>01</span><div><strong>{hasLesson('pilot') ? t('Продолжить урок пилота', 'Continue pilot lesson') : t('Урок пилота', 'Pilot lesson')}</strong><small>{t('Дверь, выстрел, батарея и первая доставка', 'A door, a shot, a battery and your first delivery')}</small></div><b>↗</b></button><button onClick={() => start('navigator', hasLesson('navigator'))}><span>02</span><div><strong>{hasLesson('navigator') ? t('Продолжить урок штурмана', 'Continue navigator lesson') : t('Урок штурмана', 'Navigator lesson')}</strong><small>{t('Перевезите пилота и откройте ему путь', 'Carry a pilot and open their route')}</small></div><b>↗</b></button></section>
    </main><footer className="shift-footer"><span>IVA GAMES / {t('СДВИГ', 'SHIFT')}</span><span>{t('ОДНА БАТАРЕЯ. ОБЩИЙ ПЛАН.', 'ONE BATTERY. A SHARED PLAN.')}</span></footer>
    {modal === 'settings' && <Options preferences={p} change={setP} close={closeModal} />}{modal === 'help' && <Help lang={l} close={closeModal} />}
  </div>;
}
function Help({ lang, close }: { lang: Language; close: () => void }) {
  const t = (ru: string, en: string) => text(lang, ru, en);
  return <ShiftModal title={t('План на победу', 'The plan to win')} close={close}><div className="shift-help"><p><b>01 / {t('Заберите батарею', 'Take the battery')}</b>{t('Она начинает раунд в комнате O. Пилот подходит и нажимает E. Он продолжает стрелять с батареей.', 'It starts in room O. Approach as a pilot and press E. You can still fire while carrying it.')}</p><p><b>02 / {t('Измените маршрут', 'Change the route')}</b>{t('Штурман двигает соседнюю с шахтой комнату. Все внутри переезжают вместе с ней. Пока комната едет, двери закрыты. Новый ход — через 6 секунд.', 'The navigator slides a room next to the shaft. Everyone inside moves with it. Doors seal in transit. Your drive recharges in 6 seconds.')}</p><p><b>03 / {t('Доставьте груз', 'Deliver it')}</b>{t('Удержите батарею на своих воротах 0,65 секунды. Первая доставка заканчивает раунд. Три очка приносят победу; максимум пять раундов и один решающий.', 'Hold the battery on your gate for 0.65 seconds. The first delivery ends the round. Three points win; at most five rounds and one tiebreak.')}</p><p>{t('План этажа открыт, враги — только когда их видит ваша команда. Исчезнувший враг оставляет неподвижный маркер на две секунды.', 'The floor plan is public. Enemies appear only when your team sees them. A lost enemy leaves a stationary marker for two seconds.')}</p></div></ShiftModal>;
}
function LocalMatch({ config, preferences, change, exit, rematch }: { config: LocalGameConfig; preferences: Preferences; change: (p: Preferences) => void; exit: () => void; rematch: () => void }) {
  const session = useLocalSession(config);
  return <MatchShell session={session} preferences={preferences} change={change} exit={exit} rematch={rematch} local />;
}
export function ShiftOnlineMatch({ roomId, matchId, language, exit, rematch, rematchReady }: { roomId: string; matchId: string; language?: Language; exit: () => void; rematch?: () => void; rematchReady: boolean }) {
  const [p, setP] = usePreferences(language); const session = useOnlineSession(roomId, matchId);
  return <MatchShell session={session} preferences={p} change={setP} exit={exit} rematch={rematch} rematchReady={rematchReady} />;
}
function MatchShell({ session, preferences: p, change, exit, rematch, rematchReady = true, local = false }: { session: ClientSession; preferences: Preferences; change: (p: Preferences) => void; exit: () => void; rematch?: () => void; rematchReady?: boolean; local?: boolean }) {
  const { view } = session; const l = p.lang, t = (ru: string, en: string) => text(l, ru, en);
  const [selected, setSelected] = useState<RoomId | null>(null); const selectedRef = useRef(selected); selectedRef.current = selected;
  const [modal, setModal] = useState<'settings' | 'help' | null>(null); const closeModal = useCallback(() => setModal(null), []);
  const [paused, setPaused] = useState(false); const [notice, setNotice] = useState(''); const [mapExpanded, setMapExpanded] = useState(false);
  const sceneFocus = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<string>()), touch = useRef({ x: 0, z: 0 }), aiming = useRef(0), fire = useRef(false);
  const latest = useRef({ session, view, p, blocked: false }); latest.current = { session, view, p, blocked: !!modal || paused || !session.connected || view?.phase === 'finished' };
  const input = useCallback(() => {
    const state = latest.current; const k = state.p.keys;
    const value: PilotInput = { moveX: (keys.current.has(k.right) || keys.current.has('ArrowRight') ? 1 : 0) - (keys.current.has(k.left) || keys.current.has('ArrowLeft') ? 1 : 0) + touch.current.x, moveZ: (keys.current.has(k.down) || keys.current.has('ArrowDown') ? 1 : 0) - (keys.current.has(k.up) || keys.current.has('ArrowUp') ? 1 : 0) + touch.current.z, aim: aiming.current, fireHeld: fire.current };
    value.moveX = Math.max(-1, Math.min(1, value.moveX)); value.moveZ = Math.max(-1, Math.min(1, value.moveZ));
    state.session.setInput(state.blocked ? { moveX: 0, moveZ: 0, aim: aiming.current, fireHeld: false } : value);
  }, []);
  const action = useCallback((kind: 'shift' | 'interact' | 'ping') => {
    const { view: v, session: s, blocked } = latest.current; if (!v || blocked) return;
    const scope = { actionId: crypto.randomUUID(), roundId: v.round, controllerEpoch: v.self.controllerEpoch };
    if (kind === 'shift' && selectedRef.current) s.send({ ...scope, type: 'shift', roomId: selectedRef.current, expectedBoardRevision: v.boardRevision });
    if (kind === 'interact') s.send({ ...scope, type: 'interact' });
    if (kind === 'ping') {
      const actor = v.actors.find(a => a.seatId === v.self.seatId);
      if (selectedRef.current) s.send({ ...scope, type: 'ping', kind: 'shift', roomId: selectedRef.current });
      else if (actor) s.send({ ...scope, type: 'ping', kind: 'look', pose: { spaceId: actor.spaceId, x: actor.x, z: actor.z } });
    }
  }, []);
  const choose = useCallback((roomId: RoomId) => {
    const v = latest.current.view; if (!v) return;
    setSelected(roomId); selectedRef.current = roomId;
    const option = v.shiftOptions.find(o => o.roomId === roomId);
    latest.current.session.selectLessonRoom(roomId, !!option?.allowed);
    if (v.self.role === 'navigator' && option && !option.allowed) setNotice(rejectCopy(latest.current.p.lang, option.reason));
  }, []);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,select,textarea,summary,[role="dialog"]')) return;
      const { view: v, blocked, p: prefs } = latest.current; if (!v || blocked) return;
      if (v.self.role === 'navigator') {
        const shaft = v.board.indexOf(null); let index = -1;
        if (e.code === 'ArrowUp' && shaft >= 3) index = shaft - 3;
        if (e.code === 'ArrowDown' && shaft < 6) index = shaft + 3;
        if (e.code === 'ArrowLeft' && shaft % 3 > 0) index = shaft - 1;
        if (e.code === 'ArrowRight' && shaft % 3 < 2) index = shaft + 1;
        if (index >= 0 && v.board[index]) { e.preventDefault(); choose(v.board[index]!); sceneFocus.current?.focus({ preventScroll: true }); }
        if (e.code === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); action('shift'); }
        if (e.code === 'Escape') { setSelected(null); selectedRef.current = null; }
      } else if ([prefs.keys.up, prefs.keys.down, prefs.keys.left, prefs.keys.right, 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) { e.preventDefault(); keys.current.add(e.code); input(); }
      if (e.repeat) return;
      if (e.code === prefs.keys.interact) { e.preventDefault(); action('interact'); }
      if (e.code === prefs.keys.ping) { e.preventDefault(); action('ping'); }
      if (e.code === 'Space' && v.self.role === 'pilot' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); fire.current = true; input(); }
    };
    const up = (e: KeyboardEvent) => { keys.current.delete(e.code); if (e.code === 'Space') fire.current = false; input(); };
    const stop = () => { keys.current.clear(); touch.current = { x: 0, z: 0 }; fire.current = false; input(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', stop); document.addEventListener('visibilitychange', stop);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', stop); stop(); };
  }, [action, choose, input]);
  useEffect(() => { session.setPaused(local && (paused || !!modal)); input(); }, [paused, modal, session.setPaused, local, input]);
  useEffect(() => { setSelected(null); selectedRef.current = null; keys.current.clear(); fire.current = false; input(); }, [view?.round, view?.self.role, input]);
  useEffect(() => { if (session.receipt && !session.receipt.accepted) setNotice(rejectCopy(p.lang, session.receipt.reason)); }, [session.receipt, p.lang]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3300); return () => clearTimeout(timer); }, [notice]);
  useShiftAudio(view, p);
  if (!view) return <div className="shift-root shift-loading"><Logo lang={l} /><span className="shift-loading-mark" /><p>{t('Подключаемся к этажу…', 'Connecting to the floor…')}</p><button className="shift-button subtle" onClick={exit}>{t('К комнатам', 'Back to rooms')}</button></div>;
  const self = view.actors.find(a => a.seatId === view.self.seatId), navigator = view.self.role === 'navigator';
  const seconds = Math.max(0, Math.ceil((view.phaseEndsAtTick - view.tick) / 30));
  const cooldown = Math.max(0, (view.cooldownUntilTick[view.self.team] - view.tick) / 30);
  const option = view.shiftOptions.find(o => o.roomId === selected);
  const names = Object.fromEntries(view.seats.map(s => [s.seatId, s.seatId === 'self' ? t('Вы', 'You') : s.displayName]));
  const events = view.events.filter(e => ['shift-start', 'shift-end', 'pickup', 'drop', 'return', 'delivered', 'down', 'ping', 'recovery'].includes(e.kind));
  const goal = view.goalSpace === 'west' ? t('запад', 'west') : t('восток', 'east');
  const lesson = session.lesson ? lessonCopy(l, session.lesson) : null;
  const batterySpace = view.battery.spaceId === 'west' ? t('западном шлюзе', 'west airlock') : view.battery.spaceId === 'east' ? t('восточном шлюзе', 'east airlock') : view.battery.spaceId || 'O';
  const batteryStatus = view.battery.mode === 'carried' ? `${t('Батарея у команды', 'Team carrying')}: ${view.battery.team ? teamName(l, view.battery.team) : '—'}` : `${t('Батарея в', 'Battery in')} ${batterySpace}`;
  const overview: ShiftView = { ...view, self: { ...view.self, role: 'navigator' } };
  const render = (mini = false) => <ShiftRenderer getPredictedSelf={session.predictSelf} onModeFallback={mini ? undefined : () => { change({ ...p, mode: '2d' }); setNotice(t('Включён 2D-вид. Управление и матч сохранены.', '2D view enabled. Your controls and match are kept.')); }} view={mini ? overview : view} mode={mini ? '2d' : p.mode} quality={p.quality} reducedMotion={p.reducedMotion} effects={p.effects} lang={l} selectedRoomId={selected || undefined} onRoomSelect={choose} onWorldAim={point => { if (mini || !self) return; const origin = worldPosition(view.board, session.predictSelf?.() || self, view.motion, view.tick); aiming.current = Math.atan2(point.z - origin.z, point.x - origin.x); input(); }} onFireChange={held => { if (mini || navigator) return; fire.current = held; input(); }} />;
  return <div className={`shift-root shift-match ${navigator ? 'navigator' : 'pilot'} team-${view.self.team}`} style={{ '--shift-text-scale': p.textScale } as CSSProperties} onPointerDown={unlockAudio} onKeyDownCapture={event => { if (event.isTrusted) unlockAudio(); }}>
    <header className="shift-match-header"><button className="shift-back" onClick={exit} aria-label={t('В меню', 'Back to menu')}>‹</button><Logo lang={l} /><span className="shift-arena-label">{getArena(view.settings.arena).title[l]}</span><div className="shift-scoreboard"><strong className="teal">{view.score.teal}</strong><div><span>{t('РАУНД', 'ROUND')} {view.round}{view.round === 6 ? t(' · РЕШАЮЩИЙ', ' · TIEBREAK') : ' / 5'}</span><b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</b></div><strong className="amber">{view.score.amber}</strong></div><div className="shift-match-tools"><button onClick={() => change({ ...p, mode: p.mode === '3d' ? '2d' : '3d' })} aria-label={t('Сменить вид', 'Switch view')}>{p.mode === '3d' ? '2D' : '2.5D'}</button><button onClick={() => change({ ...p, lang: l === 'ru' ? 'en' : 'ru' })}>{l === 'ru' ? 'EN' : 'RU'}</button><button onClick={() => setModal('help')} aria-label={t('Правила', 'Rules')}>?</button><button onClick={() => setModal('settings')} aria-label={t('Настройки', 'Settings')}>⚙</button>{local && <button aria-pressed={paused} onClick={() => setPaused(!paused)} aria-label={t('Пауза', 'Pause')}>{paused ? '▶' : 'Ⅱ'}</button>}</div></header>
    <main className="shift-battle-layout"><section className="shift-playfield"><div className="shift-role-strip"><span className={`shift-team-symbol ${view.self.team}`} /><strong>{roleName(l, view.self.role)}</strong><span>{teamName(l, view.self.team)}</span><small>{navigator ? t('ВЕСЬ ЭТАЖ · ОБЩИЙ ОБЗОР КОМАНДЫ', 'FULL FLOOR · SHARED TEAM VISION') : t(`ВАШИ ВОРОТА: ${goal.toUpperCase()}`, `YOUR GATE: ${goal.toUpperCase()}`)}</small></div><div className="shift-scene" ref={sceneFocus} tabIndex={0} aria-label={navigator ? t('Тактический план этажа', 'Tactical floor plan') : t('Управление пилотом', 'Pilot controls')}>{render()}</div>
        {!navigator && <div className="shift-pilot-status"><div className="shift-hp" aria-label={`${self?.hp ?? 0} / 3 HP`}>{[1, 2, 3].map(hp => <i key={hp} className={(self?.hp || 0) >= hp ? 'full' : ''} />)}</div><span>{self?.respawnAtTick ? t(`Возвращение через ${Math.ceil((self.respawnAtTick - view.tick) / 30)} с`, `Returning in ${Math.ceil((self.respawnAtTick - view.tick) / 30)}s`) : self?.carrying ? t('Батарея у вас · к своим воротам', 'You have the battery · reach your gate') : batteryStatus}</span>{self && self.chargeTicks > 0 && <progress max="20" value={self.chargeTicks} aria-label={t('Зарядка ворот', 'Gate charge')} />}</div>}
        {!navigator && <TouchControls lang={l} onMove={(x, z) => { touch.current = { x, z }; input(); }} onAim={(x, z) => { if (Math.hypot(x, z) > 0.15 / p.sensitivity) aiming.current = Math.atan2(z, x); input(); }} onFire={held => { fire.current = held; input(); }} onInteract={() => action('interact')} onPing={() => action('ping')} />}
        {notice && <div className="shift-notice" role="status">{notice}</div>}
        {!session.connected && <div className="shift-connection" role="alert"><strong>{['STALE_EPOCH', 'FORBIDDEN', 'MATCH_CHANGED'].includes(session.status) ? rejectCopy(l, session.status) : t('Связь прервалась. Восстанавливаем…', 'Connection lost. Reconnecting…')}</strong><span>{t('Ваше место и матч сохранены', 'Your seat and match are kept')}</span>{['STALE_EPOCH', 'FORBIDDEN', 'MATCH_CHANGED'].includes(session.status) && <button className="shift-button subtle" onClick={exit}>{t('К комнатам', 'Back to rooms')}</button>}</div>}
        {paused && <div className="shift-phase-overlay"><div><p className="shift-eyebrow">{t('ПРАКТИКА', 'PRACTICE')}</p><h2>{t('Пауза', 'Paused')}</h2><button className="shift-button primary" onClick={() => setPaused(false)}>{t('Продолжить', 'Continue')}</button></div></div>}
        {(view.phase === 'prepare' || view.phase === 'intermission' || view.recoveryTicksRemaining > 0) && !paused && <div className="shift-phase-overlay"><div><p className="shift-eyebrow">{view.recoveryTicksRemaining ? t('СОЕДИНЕНИЕ ВОССТАНОВЛЕНО', 'MATCH RESTORED') : view.phase === 'prepare' ? t('ПРИГОТОВЬТЕСЬ', 'GET READY') : t('РАУНД ЗАВЕРШЁН', 'ROUND COMPLETE')}</p><h2>{view.phase === 'intermission' ? view.rounds.at(-1)?.winner ? t('Доставлено', 'Delivered') : t('Время вышло', 'Time is up') : roleName(l, view.self.role)}</h2><b className="shift-countdown">{view.recoveryTicksRemaining ? Math.ceil(view.recoveryTicksRemaining / 30) : seconds}</b><p>{view.phase === 'intermission' ? `${t('Далее', 'Next')}: ${roleName(l, view.self.nextRole)}` : navigator ? t('Выберите комнату у шахты. Enter — сдвиг.', 'Select a room beside the shaft. Enter to shift.') : t(`${keyLabel(p.keys.up)}${keyLabel(p.keys.left)}${keyLabel(p.keys.down)}${keyLabel(p.keys.right)} — ход. Мышь — прицел. ${keyLabel(p.keys.interact)} — батарея.`, `${keyLabel(p.keys.up)}${keyLabel(p.keys.left)}${keyLabel(p.keys.down)}${keyLabel(p.keys.right)} to move. Mouse to aim. ${keyLabel(p.keys.interact)} for battery.`)}</p>{view.phase === 'intermission' && <RoundRecap view={view} lang={l} compact />}</div></div>}
      </section>
      <aside className="shift-command-panel"><div className="shift-panel-heading"><span>{navigator ? 'NAV / 02' : 'PILOT / 01'}</span><b>{t('КОМАНДА', 'TEAM')} {view.settings.teamSize}×{view.settings.teamSize}</b></div>
        {navigator ? <><div className="shift-drive"><span>{t('Привод комнат', 'Room drive')}</span><strong>{view.motion ? t('В пути', 'In transit') : cooldown > 0 ? `${cooldown.toFixed(1)} ${t('с', 's')}` : t('Готов', 'Ready')}</strong><progress max="6" value={6 - Math.min(6, cooldown)} /></div><div className="shift-room-keys" aria-label={t('Выбор комнаты', 'Room selection')}>{view.board.map((id, i) => id ? <button key={id} aria-pressed={selected === id} onClick={() => choose(id)} className={`${selected === id ? 'selected' : ''} ${view.shiftOptions.find(o => o.roomId === id)?.allowed ? 'available' : ''}`}>{id}</button> : <span key={`shaft${i}`} aria-label={t('Шахта', 'Shaft')}>□</span>)}</div><div className="shift-order"><h3>{selected ? `${t('Комната', 'Room')} ${selected}` : t('Выберите комнату', 'Choose a room')}</h3><p>{selected ? option?.allowed ? t('Можно сдвинуть в шахту', 'Ready to move into the shaft') : rejectCopy(l, option?.reason) : t('Нажмите соседнюю с шахтой плиту', 'Select a tile next to the shaft')}</p>{selected && option?.allowed && <small>{t('Новые выходы', 'New exits')}: {option.doorsAfter.filter(d => d.spaceId === selected && d.open).map(d => ({ north: t('С', 'N'), south: t('Ю', 'S'), west: t('З', 'W'), east: t('В', 'E') })[d.direction]).join(' · ') || '—'}</small>}<button className="shift-button primary" disabled={!selected || !option?.allowed || !session.connected} onClick={() => action('shift')}>{t('Сдвинуть', 'Shift room')} <kbd>↵</kbd></button><button className="shift-button subtle" disabled={!selected || !session.connected} onClick={() => action('ping')}>{t('Попросить сдвиг', 'Ping room')} <kbd>{keyLabel(p.keys.ping)}</kbd></button></div></> : <><button className="shift-map-toggle" aria-expanded={mapExpanded} onClick={() => setMapExpanded(!mapExpanded)}>{t('План этажа', 'Floor plan')} <span>{mapExpanded ? '−' : '+'}</span></button><div className={`shift-minimap ${mapExpanded ? 'expanded' : ''}`}>{render(true)}</div><div className="shift-order"><p>{self?.carrying ? t('Удержитесь на своих воротах до полной зарядки.', 'Hold on your gate until charging completes.') : batteryStatus}</p><button className="shift-button primary" disabled={!self || self.hp <= 0 || view.phase !== 'active'} onClick={() => action('interact')}>{self?.carrying ? t('Сбросить батарею', 'Drop battery') : t('Взять батарею', 'Pick up battery')} <kbd>{keyLabel(p.keys.interact)}</kbd></button><button className="shift-button subtle" onClick={() => action('ping')}>{t('Метка команде', 'Team ping')} <kbd>{keyLabel(p.keys.ping)}</kbd></button></div></>}
        <div className="shift-squad">{view.seats.filter(s => s.team === view.self.team).map(s => <div key={s.seatId}><img src={`/shift-assets/art/role-${s.role}.svg`} alt="" /><span><strong>{names[s.seatId]}{s.seatId === view.self.seatId && s.seatId !== 'self' ? ` · ${t('вы', 'you')}` : ''}</strong><small>{roleName(l, s.role)}{s.bot ? ` · ${t('бот', 'bot')}` : s.substitute ? ` · ${t('Бот замещает', 'Bot covering')}` : ''}</small></span></div>)}</div>
        <div className="shift-battle-events" aria-live="polite"><h3>{t('Общий план', 'Shared plan')}</h3>{events.slice(-3).reverse().map(e => <p key={e.id}>{eventCopy(l, e, names)}</p>)}{!events.length && <p>{t('Найдите батарею. Покажите напарнику маршрут.', 'Find the battery. Mark a route for your teammate.')}</p>}</div>
        <div className="shift-shortcuts">{navigator ? t('↑ ↓ ← → выбор · Enter сдвиг · Esc отмена', '↑ ↓ ← → select · Enter shift · Esc clear') : `${keyLabel(p.keys.up)}${keyLabel(p.keys.left)}${keyLabel(p.keys.down)}${keyLabel(p.keys.right)} · ${t('мышь / пробел — огонь', 'mouse / space — fire')}`}</div>
      </aside>
    </main>
    {lesson && <section className={`shift-lesson ${session.lesson!.step >= 5 ? 'complete' : ''}`}><div className="shift-lesson-number">{Math.min(5, session.lesson!.step + 1)}<small>/ 5</small></div><div><p>{roleName(l, session.lesson!.role)} · {t('ОБУЧЕНИЕ', 'TRAINING')}</p><h2>{lesson.title}</h2><span>{lesson.body}</span></div><button className="shift-button subtle" onClick={exit}>{session.lesson!.step >= 5 ? t('К практике', 'To practice') : t('Пропустить урок', 'Skip lesson')}</button>{session.lesson!.step >= 5 && <button className="shift-button primary" onClick={rematch}>{t('Повторить', 'Replay')}</button>}</section>}
    {view.phase === 'finished' && !session.lesson && <Result view={view} lang={l} rematch={rematch} rematchReady={rematchReady} exit={exit} />}
    {modal === 'settings' && <Options preferences={p} change={change} close={closeModal} />}{modal === 'help' && <Help lang={l} close={closeModal} />}
  </div>;
}
function Result({ view, lang, rematch, rematchReady, exit }: { view: ShiftView; lang: Language; rematch?: () => void; rematchReady: boolean; exit: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const t = (ru: string, en: string) => text(lang, ru, en);
  const names = Object.fromEntries(view.seats.map(s => [s.seatId, s.seatId === 'self' ? t('Вы', 'You') : s.displayName]));
  const recap = (view.journal || view.events).filter(e => ['shift-start', 'pickup', 'drop', 'return', 'delivered'].includes(e.kind));
  useEffect(() => { panel.current?.focus(); }, []);
  return <div className="shift-result-backdrop"><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" className={`shift-result ${view.winner || 'draw'}`} aria-label={t('Результат матча', 'Match result')} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('button,a,summary,[tabindex="0"]') || [])];
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <p className="shift-eyebrow">{t('ЗАДАНИЕ ЗАВЕРШЕНО', 'MISSION COMPLETE')}</p>
    <h1>{view.winner ? `${teamName(lang, view.winner)} · ${t('победа', 'victory')}` : t('Ничья', 'Draw')}</h1>
    <div className="shift-result-score"><b className="teal">{view.score.teal}</b><span>:</span><b className="amber">{view.score.amber}</b></div>
    <div className="shift-rounds">{view.rounds.map(r => <div key={r.round} className={r.winner || 'draw'}><small>{r.round === 6 ? t('РЕШАЮЩИЙ', 'TIEBREAK') : `${t('РАУНД', 'ROUND')} ${r.round}`}</small><strong>{r.winner ? teamName(lang, r.winner) : '—'}</strong><span>{r.reason === 'delivery' ? t('ϟ Доставлено', 'ϟ Delivered') : t('Время вышло', 'Time expired')}</span></div>)}</div>
    <h2>{t('Каждый изменил этаж', 'Everyone shaped the floor')}</h2>
    <div className="shift-contributions">{view.seats.map(s => {
      const stats = view.stats[s.seatId];
      const counters: [string, number][] = [
        [t('Доставки', 'Deliveries'), stats?.deliveries || 0], [t('Перехваты', 'Interceptions'), stats?.interceptions || 0],
        [t('Попадания', 'Hits'), stats?.hits || 0], [t('Сдвиги', 'Shifts'), stats?.shifts || 0],
        [t('Перевозки союзников', 'Ally rides'), stats?.allyTransfers || 0], [t('Перевозки батареи', 'Battery rides'), stats?.batteryTransfers || 0],
        [t('Новые стыки', 'New connections'), stats?.openedDoors || 0],
      ];
      return <article key={s.seatId}><h3><span className={`shift-team-symbol ${s.team}`} />{names[s.seatId]}</h3><dl>{counters.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></article>;
    })}</div>
    <RoundRecap view={view} lang={lang} />
    <details className="shift-recap"><summary>{t('Тактическая цепочка', 'Tactical recap')}</summary>
      <p>{t('Последние ключевые действия каждого раунда.', 'The latest key actions from each round.')}</p>
      {view.rounds.map(round => <section key={round.round}><h3>{t('Раунд', 'Round')} {round.round}</h3><ol>{recap.filter(e => e.round === round.round).slice(-8).map(e => <li key={e.id}>{eventCopy(lang, e, names)}</li>)}{!recap.some(e => e.round === round.round) && <li>{round.reason === 'timeout' ? t('Время вышло без доставки', 'Time expired without a delivery') : t('Доставлено', 'Delivered')}</li>}</ol></section>)}
    </details>
    {rematch && !rematchReady && <p className="shift-muted" role="status">{t('Подготавливаем комнату к реваншу…', 'Preparing the room for a rematch…')}</p>}
    <div className="shift-result-actions">{rematch ? <button className="shift-button primary" disabled={!rematchReady} onClick={rematch}>{t('Реванш', 'Rematch')} ↗</button> : <p>{t('Реванш может начать хозяин комнаты', 'The host can start a rematch')}</p>}<button className="shift-button subtle" onClick={exit}>{t('В лобби', 'Back to lobby')}</button></div>
  </section></div>;
}
