import { useEffect, useRef, useState } from 'react'
import { WEAPONS } from '../core/constants'
import { getMap } from '../core/maps'
import type { Action, BuildingKind, Point, WorldView } from '../core/types'
import { ForpostAudio, FORPOST_SOUNDS, type ForpostSound } from '../art/audio'
import { clock, errorText, name, seconds, text } from './copy'
import { loadSettings, saveSettings, type Settings } from './settings'
import { abandonPractice, createPractice, OnlineSession, practiceTicket, roomTicket, type ConnectionState, type JoinInfo, type PracticeOptions, type SessionClient } from './transport'
import { TutorialSession, type LessonProgress } from './tutorial-client'
import { Controls, type ToolInputSource } from './controls'
import { commandBlockReason, type CommandState } from './command-state'
import { Dialog, Icon, Meter, SettingsPanel } from './ui'
import { StageView } from './StageView'
import { tutorialInstruction } from './tutorial-copy'
import { MapPreview } from './MapPreview'
import { Menu } from './Menu'
import { Inspector } from './Inspector'

declare const __FORPOST_BUILD__: string
const LAST_MATCH = 'iva.forpost.last-match.v1'
const soundEvents: Record<string, ForpostSound> = { 'reload-finish': 'reload-end', 'build-finish': 'build-complete', 'tool-barrier': 'barrier', 'tool-smoke': 'smoke', 'tool-repair': 'repair', 'unit-destroyed': 'destroy', 'building-destroyed': 'destroy', 'transport-destroyed': 'destroy', 'wall-destroyed': 'destroy', 'transport-ready': 'transport-spawn', delivery: 'unload-success', 'operation-result': 'operation-end', 'drone-ready': 'build-complete' }
const lessonCopy = [
  [['Движение и стрельба', 'Movement and firing'], ['Пройдите к двум отметкам, наведитесь на мишень и попадите в неё. R — перезарядка.', 'Reach both markers, aim at the target and hit it. R reloads.']],
  [['Укрытие и защита', 'Cover and protection'], ['Спрячьтесь за стеной. Выстрелите в стену, обойдите её и примените инструмент.', 'Take cover behind the wall. Shoot the wall, go around it and use your tool.']],
  [['Доставка', 'Delivery'], ['Сопроводите транспорт: рядом с вами он быстрее. Устраните учебного противника и удерживайте круг 3 секунды.', 'Escort the transport: it moves faster near you. Remove the training enemy and hold the circle for 3 seconds.']],
  [['Своя инфраструктура', 'Your infrastructure'], ['Выберите площадку, постройте ретранслятор, затем экстрактор. Дождитесь завершения работы строителя.', 'Choose a pad, build a relay, then an extractor. Wait for your builder to finish.']],
  [['Питание', 'Power'], ['Откройте приоритет питания и поднимите нужный модуль. Генератор должен быть связан с базой.', 'Open power priority and move the needed module up. The generator must be connected to base.']],
  [['Свой отряд', 'Your squad'], ['Закажите дрон в доке. В тактике прикажите ему сопровождать транспорт, затем вернитесь к бойцу.', 'Order a drone at the dock. In tactics, order it to escort the transport, then return to your fighter.']],
  [['Первая операция', 'Your first operation'], ['Завершите короткую операцию: доставьте транспорт и удержите комплекс. Затем начните тренировку.', 'Finish the short operation: deliver the transport and hold the complex. Then start practice.']],
]
function initialOptions(): PracticeOptions { return { mapId: 'FP01', teamSize: 1, mode: 'training', displayName: 'Командир', botLevel: 'normal', weapon: 'carbine', tool: 'barrier' } }
function readLast(): { matchId: string; roomId?: string; options?: PracticeOptions } | null { try { return JSON.parse(localStorage.getItem(LAST_MATCH) ?? 'null') } catch { return null } }
function writeLast(value: ReturnType<typeof readLast>): void { try { if (value) localStorage.setItem(LAST_MATCH, JSON.stringify(value)); else localStorage.removeItem(LAST_MATCH) } catch { /* The current session remains playable without browser storage. */ } }
async function discardCreatedPractice(matchId: string): Promise<void> {
  // A cancelled create can already own a real server room. Finish the request
  // and release exactly that result; aborting it would lose the cleanup identity.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await abandonPractice(matchId); return } catch { /* The owned endpoint is idempotent; retry one failed delivery. */ }
  }
  console.warn('forpost: cancelled practice cleanup could not be confirmed')
}
function pinnedRoute(info: JoinInfo, query: Record<string, string>): boolean {
  if (!info.route) return false
  const route = new URL(info.route, location.origin)
  if (route.origin !== location.origin || !/^\/(?:play\/forpost|realtime-assets\/[a-f0-9]{64})\/$/.test(route.pathname)) throw new Error('BAD_TICKET')
  if (route.pathname === location.pathname) return false
  route.search = new URLSearchParams(query).toString(); location.assign(route.href); return true
}

export function App() {
  const [settings, setSettings] = useState(loadSettings), [options, setOptions] = useState<PracticeOptions>(initialOptions)
  const [view, setView] = useState<WorldView | null>(null), [screen, setScreen] = useState<'menu' | 'game'>('menu'), [status, setStatus] = useState<ConnectionState>('connecting')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [settingsOpen, setSettingsOpen] = useState(false), [helpOpen, setHelpOpen] = useState(false), [exitOpen, setExitOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([]), [inspectorOpen, setInspectorOpen] = useState(true), [preview, setPreview] = useState<{ padId: string; kind: BuildingKind } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [orderTarget, setOrderTarget] = useState<'move' | 'guard' | 'attack' | 'battery' | null>(null), [aim, setAim] = useState<Point | null>(null), [cameraTarget, setCameraTarget] = useState<Point | null>(null), [zoom, setZoom] = useState(1)
  const [confirmation, setConfirmation] = useState<{ action: Action; message: string } | null>(null), [lesson, setLesson] = useState<LessonProgress | null>(null), [tutorialChooser, setTutorialChooser] = useState(false)
  const [sessionRoom, setSessionRoom] = useState<string | null>(null), [last, setLast] = useState(readLast)
  const commandState: CommandState = { screen, status, phase: view?.phase ?? null, modalOpen: settingsOpen || helpOpen || exitOpen || tutorialChooser, confirmationOpen: !!confirmation }
  const session = useRef<SessionClient | null>(null), controls = useRef<Controls | null>(null), audio = useRef<ForpostAudio | null>(null), eventCursor = useRef(-1), navigation = useRef(0), current = useRef({ view, selected, settings, preview, screen, commandState })
  current.current = { view, selected, settings, preview, screen, commandState }
  const lang = settings.language, t = (ru: string, en: string) => text(lang, ru, en), me = view?.participants.find(p => p.id === view.you), fighter = view?.units.find(u => u.ownerId === view.you && u.kind === 'fighter')
  const commandReason = commandBlockReason(commandState), uiBlocked = commandReason !== null, commandDisabled = busy || uiBlocked
  const commandTitle = commandReason ? errorText(commandReason, lang) : busy ? t('Ожидаем подтверждение', 'Waiting for confirmation') : undefined

  useEffect(() => { saveSettings(settings); document.documentElement.lang = lang; document.documentElement.style.setProperty('--fp-text-scale', String(settings.textScale)); audio.current?.configure({ master: settings.master, effects: settings.effects, ui: settings.interfaceVolume, muted: settings.muted }) }, [settings, lang])
  const notify = (value: string) => { setMessage(value) }
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 5500); return () => clearTimeout(timer) }, [message])
  useEffect(() => {
    audio.current = new ForpostAudio(import.meta.env.BASE_URL)
    const saved = current.current.settings
    audio.current.configure({ master: saved.master, effects: saved.effects, ui: saved.interfaceVolume, muted: saved.muted })
    const controller = new Controls(key => {
      const { view: v, selected: ids } = current.current; if (!v) return
      const own = v.participants.find(p => p.id === v.you)
      if (key === 'tab') { void act({ type: 'mode', mode: own?.mode === 'tactics' ? 'fighter' : 'tactics' }); return }
      if (key === 'r') { void act({ type: 'reload' }); return }
      if (key === ' ') { useTool(); return }
      if (key === 'escape') { setPreview(null); setOrderTarget(null); setInspectorOpen(false); return }
      if (key === 'b') { setInspectorOpen(true); const pad = getMap(v.mapId).pads.find(p => p.id === ids[0]); if (!pad) { const first = getMap(v.mapId).pads.find(p => p.side === v.teams[v.yourTeam].side && (v.buildOptions[p.id] ?? []).some(o => o.ok)); if (first) setSelected([first.id]) }; return }
      if (/^[1-4]$/.test(key)) { const list = v.units.filter(u => u.ownerId === v.you).sort((a, b) => ({ fighter: 0, builder: 1, drone: 2 }[a.kind] - { fighter: 0, builder: 1, drone: 2 }[b.kind])); const unit = list[Number(key) - 1]; if (unit) selectUnit(unit.id); return }
      if (key === 'delete') setInspectorOpen(true)
    })
    controls.current = controller
    const timer = setInterval(() => { controller.value.assist = current.current.settings.assist; session.current?.input({ ...controller.value }) }, 1000 / 30)
    return () => { navigation.current++; clearInterval(timer); controller.destroy(); const previous = session.current; session.current = null; previous?.close(); void audio.current?.dispose() }
  }, [])
  useEffect(() => { controls.current?.setDisabled(uiBlocked || screen !== 'game'); if (uiBlocked) session.current?.input({ moveX: 0, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: controls.current?.value.firePressSeq ?? 0 }) }, [uiBlocked, screen, status])
  useEffect(() => { const query = new URLSearchParams(location.search), roomId = query.get('room'), resumeId = query.get('resume'); if (roomId) void joinRoom(roomId); else if (resumeId) void resume(resumeId, null) }, [])

  async function unlockAudio() { try { await audio.current?.unlock() } catch { notify(t('Не удалось загрузить звук. Игра остаётся доступной.', 'Audio could not load. You can keep playing.')) } }
  function receive(next: WorldView) {
    setView(next)
    if (eventCursor.current < 0) { eventCursor.current = next.events.at(-1)?.seq ?? 0; return }
    for (const event of next.events) if (event.seq > eventCursor.current) {
      const source = event.type.replace(/^sound:/, '')
      const weapon = source.startsWith('weapon:') ? source.slice(7) : null
      const sound = weapon ? (['drone', 'turret', 'battery'].includes(weapon) ? `${weapon}-fire` : weapon) : soundEvents[source] ?? source
      if (sound && (FORPOST_SOUNDS as readonly string[]).includes(sound)) audio.current?.play(sound as ForpostSound, { sector: event.sector, proximity: event.proximity, occluded: event.muffled })
      eventCursor.current = Math.max(eventCursor.current, event.seq)
    }
  }
  function connection(next: ConnectionState, code?: string) { setStatus(next); if (next === 'reconnecting' || next === 'paused') { controls.current?.neutral(); eventCursor.current = -1; audio.current?.clear() }; if (code) notify(errorText(code, current.current.settings.language)) }
  function resetControlInput() { controls.current?.neutral(); if (controls.current) controls.current.value.firePressSeq = 0 }
  function resetGameUi() { resetControlInput(); setBusy(false); setSelected([]); setPreview(null); setOrderTarget(null); setCameraTarget(null); setZoom(1); setAim(null); setInspectorOpen(window.innerWidth >= 1024); setMessage(''); eventCursor.current = -1; setLesson(null) }
  async function startPractice() {
    if (busy) return
    const intent = ++navigation.current, active = () => navigation.current === intent
    setBusy(true); void unlockAudio()
    try {
      if (last && !last.roomId) {
        session.current?.close(); session.current = null
        await abandonPractice(last.matchId).catch((error: Error) => { if (!['NOT_FOUND', 'AUTH_REQUIRED', 'MATCH_NOT_FOUND', 'MATCH_UNAVAILABLE'].includes(error.message)) throw error })
        if (!active()) return
        writeLast(null); setLast(null)
      }
      const info = await createPractice({ ...options, displayName: options.displayName.trim() || t('Командир', 'Commander') })
      if (!active()) { await discardCreatedPractice(info.matchId); return }
      const next = { matchId: info.matchId, options }; writeLast(next); setLast(next)
      if (pinnedRoute(info, { resume: info.matchId })) return
      session.current?.close(); resetGameUi(); setSessionRoom(null); setView(null); setScreen('game')
      session.current = new OnlineSession(info, () => practiceTicket(info.matchId), next => { if (active()) receive(next) }, (next, code) => { if (active()) connection(next, code) }, () => { if (active()) resetControlInput() })
    } catch (error) { if (active()) notify(errorText(error instanceof Error ? error.message : 'NETWORK', lang)) }
    finally { if (active()) setBusy(false) }
  }
  async function joinRoom(roomId: string) {
    const intent = ++navigation.current, active = () => navigation.current === intent
    setBusy(true)
    try {
      const info = await roomTicket(roomId)
      if (!active()) return
      const next = { matchId: info.matchId, roomId }; writeLast(next); setLast(next)
      if (pinnedRoute(info, { room: roomId })) return
      session.current?.close(); resetGameUi(); setSessionRoom(roomId); setView(null); setScreen('game')
      session.current = new OnlineSession(info, () => roomTicket(roomId), next => { if (active()) receive(next) }, (next, code) => { if (active()) connection(next, code) }, () => { if (active()) resetControlInput() })
    } catch (error) { if (active()) notify(errorText(error instanceof Error ? error.message : 'NETWORK', lang)) }
    finally { if (active()) setBusy(false) }
  }
  async function resume(matchId = last?.matchId, roomId: string | null | undefined = last?.roomId) {
    if (!matchId) return
    void unlockAudio(); if (roomId) { await joinRoom(roomId); return }
    const intent = ++navigation.current, active = () => navigation.current === intent
    setBusy(true)
    try {
      const info = await practiceTicket(matchId)
      if (!active()) return
      const next = { matchId, ...(last?.matchId === matchId && last.options ? { options: last.options } : {}) }; writeLast(next); setLast(next)
      if (pinnedRoute(info, { resume: matchId })) return
      session.current?.close(); resetGameUi(); setSessionRoom(null); if (next.options) setOptions(next.options); setView(null); setScreen('game')
      session.current = new OnlineSession(info, () => practiceTicket(matchId), next => { if (active()) receive(next) }, (next, code) => { if (active()) connection(next, code) }, () => { if (active()) resetControlInput() })
    } catch (error) { if (active()) notify(errorText(error instanceof Error ? error.message : 'NETWORK', lang)) }
    finally { if (active()) setBusy(false) }
  }
  function startLesson(index: number, resumeLesson = false) {
    const intent = ++navigation.current, active = () => navigation.current === intent
    void unlockAudio(); session.current?.close(); resetGameUi(); setSessionRoom(null); setView(null); setScreen('game'); setTutorialChooser(false); setStatus('connecting')
    const unavailable = () => { if (active()) { menu(); notify(t('Не удалось запустить обучение. Сохранённый прогресс можно открыть повторно.', 'Training could not start. You can reopen your saved progress.')) } }
    try { session.current = new TutorialSession(index, next => { if (active()) { setStatus('connected'); receive(next) } }, progress => { if (active()) setLesson(progress) }, resumeLesson, unavailable) } catch { unavailable() }
  }
  function menu() { navigation.current++; controls.current?.neutral(); session.current?.close(); session.current = null; audio.current?.clear(); setBusy(false); setScreen('menu'); setView(null); setLesson(null); setExitOpen(false); setOrderTarget(null); setPreview(null); if (location.search) history.replaceState(null, '', location.pathname) }
  async function act(action: Action, fromConfirmation = false): Promise<boolean> {
    if (!session.current || commandBlockReason(current.current.commandState, fromConfirmation)) return false
    const actingSession = session.current
    if (action.type === 'mode') controls.current?.neutral()
    setBusy(true); void unlockAudio()
    try { const result = await actingSession.action(action); if (session.current !== actingSession) return false; if (!result.ok) { audio.current?.play('error'); notify(errorText(result.code, current.current.settings.language)); throw new Error(result.code) }; if (action.type !== 'reload') audio.current?.play('order'); if (result.refund) notify(`${text(current.current.settings.language, action.type === 'sell' || action.type === 'cancelBuild' && !!view?.buildOrders.find(o => o.id === action.orderId)?.buildingId ? 'Расчётный возврат после продажи' : 'Зачислено', action.type === 'sell' || action.type === 'cancelBuild' && !!view?.buildOrders.find(o => o.id === action.orderId)?.buildingId ? 'Estimated sale refund' : 'Credited')}: ${result.refund.credited} ¤`); setConfirmation(null); return true }
    catch (error) { if (session.current === actingSession && error instanceof Error) notify(errorText(error.message, current.current.settings.language)); return false }
    finally { if (session.current === actingSession) setBusy(false) }
  }
  function selectUnit(id: string) { const v = current.current.view; if (!v) return; setSelected([id]); setInspectorOpen(true); const unit = v.units.find(u => u.id === id); if (unit?.kind !== 'fighter' && unit?.ownerId === v.you && v.participants.find(p => p.id === v.you)?.mode !== 'tactics') void act({ type: 'mode', mode: 'tactics' }) }
  function useTool(source?: ToolInputSource) {
    const v = current.current.view; if (!v) return; const unit = v.units.find(u => u.ownerId === v.you && u.kind === 'fighter'); if (!unit) return
    const input = controls.current?.value; const selectedId = current.current.selected[0]; const tool = v.participants.find(p => p.id === v.you)?.tool
    controls.current?.tool(true, source)
    const point = { x: unit.x + (input?.aimX ?? 1) * 5, z: unit.z + (input?.aimZ ?? 0) * 5 }
    if (tool === 'repair') { const target = [...v.buildings, ...v.transports, ...v.units.filter(u => u.kind === 'drone')].filter(e => e.team === v.yourTeam && e.hp < e.maxHp && Math.hypot(e.x - unit.x, e.z - unit.z) <= 3).sort((a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : Math.hypot(a.x - unit.x, a.z - unit.z) - Math.hypot(b.x - unit.x, b.z - unit.z)))[0]; void act({ type: 'tool', targetId: target?.id }) }
    else void act({ type: 'tool', point })
  }
  function pointMove(point: Point) { const v = current.current.view, unit = v?.units.find(u => u.ownerId === v.you && u.kind === 'fighter'); if (!v || uiBlocked) return; const predicted = session.current?.getPrediction?.(); const origin = predicted?.id === unit?.id ? predicted : unit; if (origin) { controls.current?.aim({ x: point.x - origin.x, z: point.z - origin.z }); setAim(point) }; const hovered = [...v.units, ...v.buildings, ...v.transports, ...v.memories].find(object => Math.hypot(object.x - point.x, object.z - point.z) < 1.3) ?? getMap(v.mapId).pads.find(p => Math.abs(p.x - point.x) < 1 && Math.abs(p.z - point.z) < 1); setHover(hovered?.id ?? null) }
  function worldDown(point: Point, button: number, shift: boolean) {
    if (!view || uiBlocked || preview) return
    const objects = [...view.units, ...view.buildings, ...view.transports, ...view.memories].filter(o => Math.hypot(o.x - point.x, o.z - point.z) < (o.id.includes('transport') ? 1.8 : 1.3)).sort((a, b) => Math.hypot(a.x - point.x, a.z - point.z) - Math.hypot(b.x - point.x, b.z - point.z)); const object = objects[0]
    const unitIds = view.units.filter(u => selected.includes(u.id) && u.ownerId === view.you).map(u => u.id)
    if (orderTarget || button === 2 && me?.mode === 'tactics') {
      const order = orderTarget ?? (object && object.team !== view.yourTeam ? 'attack' : 'move')
      if (order === 'battery') { const building = view.buildings.find(b => b.id === selected[0]); if (building) void act({ type: 'batteryAim', buildingId: building.id, direction: { x: point.x - building.x, z: point.z - building.z } }) }
      else if (order === 'attack') { if (object && object.team !== view.yourTeam && !('stale' in object)) void act({ type: 'order', unitIds, order: { type: 'attack', targetId: object.id } }); else notify(t('Выберите видимую цель.', 'Select a visible target.')) }
      else void act({ type: 'order', unitIds, order: { type: order, point } })
      setOrderTarget(null); return
    }
    if (button === 0 && me?.mode !== 'tactics' && !settings.touch) { pointMove(point); controls.current?.fire(true, 'mouse'); void unlockAudio(); return }
    if (object) { setSelected(shift && object && 'ownerId' in object && object.ownerId === view.you ? [...new Set([...selected, object.id])] : [object.id]); setInspectorOpen(true); return }
    const pad = getMap(view.mapId).pads.find(p => Math.abs(p.x - point.x) < Math.max(1.2, (p.rect.x2 - p.rect.x1) / 2) && Math.abs(p.z - point.z) < Math.max(1.2, (p.rect.z2 - p.rect.z1) / 2))
    if (pad) { setSelected([pad.id]); setInspectorOpen(true) }
  }
  function pan(delta: Point, factor: number) { if (!view) return; const map = getMap(view.mapId); setCameraTarget(previous => ({ x: Math.max(0, Math.min(map.width, (previous?.x ?? map.width / 2) + delta.x)), z: Math.max(0, Math.min(map.height, (previous?.z ?? map.height / 2) + delta.z)) })); setZoom(value => Math.max(.7, Math.min(3, value * factor))) }
  const chooseTactics = () => { controls.current?.neutral(); void act({ type: 'mode', mode: me?.mode === 'tactics' ? 'fighter' : 'tactics' }); setCameraTarget(null); setZoom(1) }
  const ownUnits = view?.units.filter(u => u.ownerId === view.you).sort((a, b) => ({ fighter: 0, builder: 1, drone: 2 }[a.kind] - { fighter: 0, builder: 1, drone: 2 }[b.kind])) ?? []
  const roundFinished = view?.phase === 'finished', operationResult = view?.phase === 'operationResult'

  return <div className={`fp-app ${settings.reducedMotion ? 'reduced-motion' : ''} ${settings.touch ? 'touch-mode' : ''}`}>
    {screen === 'menu' ? <Menu lang={lang} options={options} setOptions={setOptions} busy={busy} resume={!!last} onResume={() => void resume()} onPlay={() => void startPractice()} onTutorial={() => setTutorialChooser(true)} onSettings={() => setSettingsOpen(true)} onLanguage={() => setSettings({ ...settings, language: lang === 'ru' ? 'en' : 'ru' })} /> : !view ? <div className="fp-loading"><span className="fp-loading-mark" /><h1>{t('Связываемся с отрядом', 'Connecting to your squad')}</h1><p>{t('Загружаем операцию…', 'Loading the operation…')}</p><button className="fp-button secondary" onClick={menu}>{t('В меню', 'Back to menu')}</button></div> : <div className={`fp-game ${inspectorOpen ? 'inspector-open' : ''}`}>
      <header className="fp-game-header"><button className="fp-icon-button" onClick={() => setExitOpen(true)} aria-label={t('Меню партии', 'Game menu')}><Icon name="menu" /></button><div className="fp-game-name"><strong>{t('ФОРПОСТ', 'FORPOST')}</strong><small>{getMap(view.mapId).name[lang]}</small></div><div className="fp-score"><span className="team-a">A <b>{view.teams.A.wins}</b></span><i>:</i><span className="team-b"><b>{view.teams.B.wins}</b> B</span><small>{t('операции', 'operations')}</small></div><div className="fp-operation-clock"><strong>{clock(view.phaseRemainingTicks)}</strong><small>{name(view.phase, lang)} {view.operation}/{view.mode === 'match' ? 3 : 1}</small></div><div className="fp-deliveries"><span className="team-a">▲ {view.teams.A.deliveries}</span><Icon name="transport" /><span className="team-b">⬢ {view.teams.B.deliveries}</span></div><div className={`fp-network ${status}`} title={t('Состояние соединения', 'Connection status')}>{status === 'connected' ? t('На связи', 'Connected') : status === 'paused' ? t('Пауза', 'Paused') : status === 'spectating' ? t('Просмотр', 'Viewing') : status === 'error' ? t('Нет связи', 'Disconnected') : t('Соединяемся…', 'Connecting…')}</div><button className="fp-icon-button" onClick={() => setSettingsOpen(true)} aria-label={t('Настройки', 'Settings')}><Icon name="settings" /></button></header>
      <section className="fp-field"><StageView getPrediction={() => session.current?.getPrediction?.() ?? null} view={view} settings={settings} state={{ selected, hover, preview, zoom, target: cameraTarget, aim, focus: lesson?.completed ? [] : lesson?.focus ?? [] }} onFallback={() => { controls.current?.neutral(); setSettings(s => ({ ...s, renderer: '2d' })); notify(t('Включён 2D-режим. Партия продолжается.', '2D mode is active. Your game continues.')) }} onLoadError={() => notify(t('Модель не загрузилась. Можно продолжить в 2D через настройки.', 'A model could not load. You can switch to 2D in settings.'))} onMove={pointMove} onLeave={() => setHover(null)} onDown={worldDown} onUp={() => controls.current?.fire(false, 'mouse')} onPan={pan} onSelectRect={(a, b, add) => { const ids = view.units.filter(u => u.ownerId === view.you && u.x >= Math.min(a.x, b.x) && u.x <= Math.max(a.x, b.x) && u.z >= Math.min(a.z, b.z) && u.z <= Math.max(a.z, b.z)).map(u => u.id); setSelected(add ? [...new Set([...selected, ...ids])] : ids); if (ids.length) setInspectorOpen(true) }} />
        <div className="fp-minimap"><MapPreview mapId={view.mapId} view={view} onPoint={point => { if (me?.mode !== 'tactics') void act({ type: 'mode', mode: 'tactics' }); setCameraTarget(point); setZoom(1.6) }} /><span>{getMap(view.mapId).name[lang]}</span></div>
        <div className="fp-field-tools"><button className={`fp-tool-toggle ${me?.mode === 'tactics' ? 'selected' : ''}`} onClick={chooseTactics} disabled={commandDisabled} title={commandTitle} aria-pressed={me?.mode === 'tactics'}><Icon name={me?.mode === 'tactics' ? 'target' : 'tactics'} />{me?.mode === 'tactics' ? t('К бойцу', 'Fighter') : t('Тактика', 'Tactics')}</button><button className="fp-icon-button" onClick={() => setInspectorOpen(v => !v)} aria-label={t('Открыть инспектор', 'Toggle inspector')}><Icon name="build" /></button><button className="fp-icon-button" onClick={() => setHelpOpen(true)} aria-label={t('Помощь', 'Help')}><Icon name="book" /></button></div>
        {view.phase === 'preparation' && <div className="fp-phase-banner"><small>{t('ПОДГОТОВКА К ОПЕРАЦИИ', 'PREPARING THE OPERATION')}</small><strong>{t('Выберите маршрут и закажите постройки', 'Choose your route and queue structures')}</strong><span>{t('Бой начнётся через', 'Battle begins in')} {seconds(view.phaseRemainingTicks)} {t('с', 's')}</span></div>}
        {orderTarget && <div className="fp-target-banner"><Icon name="target" /><span>{orderTarget === 'attack' ? t('Выберите видимого противника', 'Choose a visible enemy') : t('Укажите точку на поле', 'Choose a point on the field')}</span><button onClick={() => setOrderTarget(null)}>{t('Отмена', 'Cancel')}</button></div>}
        {status === 'spectating' && <div className="fp-control-banner"><strong>{t('Управление на другом устройстве', 'Another device has control')}</strong><button className="fp-button primary" onClick={() => session.current?.claim()}>{t('Продолжить здесь', 'Continue here')}</button></div>}
        {status === 'error' && <div className="fp-control-banner"><strong>{t('Не удалось восстановить связь', 'Could not restore the connection')}</strong><button className="fp-button primary" disabled={busy} onClick={() => void resume(view.matchId, sessionRoom)}>{t('Повторить подключение', 'Reconnect')}</button><button className="fp-button secondary" onClick={menu}>{t('В меню', 'Back to menu')}</button></div>}
        {status === 'paused' && <div className="fp-control-banner"><strong>{t('Партия сохранена', 'Game saved')}</strong><button className="fp-button primary" disabled={busy} onClick={() => void resume(view.matchId, sessionRoom)}>{t('Возобновить партию', 'Resume match')}</button></div>}
        {!fighter && !roundFinished && <div className="fp-respawn"><Icon name="health" /><strong>{t('Возвращение через', 'Respawning in')} {seconds((me?.respawnAt ?? view.tick) - view.tick)} {t('с', 's')}</strong><button disabled={commandDisabled} title={commandTitle} onClick={() => void act({ type: 'respawn', buildingId: null })}>{t('На базу', 'At base')}</button><button onClick={() => { setSelected([]); setInspectorOpen(true) }}>{t('Сменить оснащение', 'Change loadout')}</button>{view.buildings.filter(b => b.kind === 'post' && b.ownerId === view.you).map(b => <button disabled={commandDisabled || !b.powered || b.suppressed} title={commandTitle} onClick={() => void act({ type: 'respawn', buildingId: b.id })} key={b.id}>{name('post', lang)} · {b.padId}{b.suppressed ? ` (${t('подавлен', 'suppressed')})` : ''}</button>)}</div>}
        {lesson && <div className={`fp-lesson ${lesson.completed ? 'complete' : ''}`}><div><span>{t('ОБУЧЕНИЕ', 'TRAINING')} · {lesson.lesson + 1}/7</span><button onClick={() => setTutorialChooser(true)}>{t('Все уроки', 'All lessons')}</button></div><h2>{lessonCopy[lesson.lesson]?.[0][lang === 'ru' ? 0 : 1]}</h2><p>{tutorialInstruction(lesson, lang)}</p><div className="fp-lesson-actions"><button onClick={() => startLesson(lesson.lesson)}>{t('Повторить', 'Restart')}</button>{lesson.completed ? <button className="primary" onClick={() => lesson.lesson < 6 ? startLesson(lesson.lesson + 1) : void startPractice()}><Icon name="check" />{lesson.lesson < 6 ? t('Следующий урок', 'Next lesson') : t('Начать тренировку', 'Start practice')}</button> : <button onClick={() => lesson.lesson < 6 ? startLesson(lesson.lesson + 1) : menu()}>{t('Пропустить', 'Skip')}</button>}</div></div>}
        {settings.touch && me?.mode !== 'tactics' && !uiBlocked && !roundFinished && <TouchControls controls={controls.current} lang={lang} onTool={useTool} onReload={() => void act({ type: 'reload' })} cooldown={Math.max(0, (me?.toolReadyTick ?? 0) - view.tick)} actionsDisabled={busy || !fighter} toolUnavailable={view.phase === 'preparation'} />}
        {me?.mode === 'tactics' && <div className="fp-camera-controls"><button onClick={() => pan({ x: 0, z: 0 }, .85)} aria-label={t('Отдалить', 'Zoom out')}>−</button><button onClick={() => { setCameraTarget(null); setZoom(1) }}>{t('Вся карта', 'Whole map')}</button><button onClick={() => pan({ x: 0, z: 0 }, 1.15)} aria-label={t('Приблизить', 'Zoom in')}>+</button></div>}
      </section>
      {inspectorOpen && <Inspector view={view} selected={selected} onSelect={setSelected} lang={lang} busy={commandDisabled} preview={preview} setPreview={setPreview} act={act} confirm={(action, value) => setConfirmation({ action, message: value })} targetOrder={type => { setOrderTarget(type); if (window.innerWidth < 1024) setInspectorOpen(false) }} onClose={() => { setInspectorOpen(false); setPreview(null); controls.current?.neutral() }} />}
      <footer className="fp-game-bottom"><div className="fp-personal"><span className="fp-callsign">{me?.name}<small>{t('Команда', 'Team')} {view.yourTeam}{me?.temporaryBot ? ` · ${t('автопилот', 'autopilot')}` : ''}</small></span><div className="fp-wallet"><Icon name="credits" /><strong>{Math.floor(me?.credits ?? 0)}</strong><small>¤</small></div><div className={`fp-power ${me?.powerUsed === me?.power ? 'full' : ''}`}><Icon name="power" /><strong>{me?.powerUsed ?? 0}<small>/{me?.power ?? 6}</small></strong></div></div>
        {me?.mode === 'tactics' ? <div className="fp-unit-bar">{ownUnits.map((unit, i) => <button key={unit.id} className={selected.includes(unit.id) ? 'selected' : ''} onClick={() => selectUnit(unit.id)} aria-pressed={selected.includes(unit.id)}><Icon name={unit.kind === 'fighter' ? 'target' : unit.kind === 'builder' ? 'build' : 'bot'} /><span>{name(unit.kind, lang)}<small>{Math.ceil(unit.hp)} HP</small></span><kbd>{i + 1}</kbd></button>)}</div> : <div className="fp-fighter-bar"><div className="fp-health-block"><span><Icon name="health" />{Math.ceil(fighter?.hp ?? 0)}<small>/ 100</small></span><Meter value={fighter?.hp ?? 0} max={100} label={t('Здоровье', 'Health')} /></div><button className="fp-ammo" title={commandTitle} disabled={commandDisabled || !fighter} onClick={() => void act({ type: 'reload' })}><Icon name="reload" /><span><strong>{fighter?.magazine ?? 0}<small>/{WEAPONS[me?.weapon ?? 'carbine'].magazine}</small></strong><small>{(fighter?.reloadUntil ?? 0) > view.tick ? `${t('Заряжаем', 'Reloading')} ${seconds(fighter!.reloadUntil! - view.tick)} ${t('с', 's')}` : name(me?.weapon ?? 'carbine', lang)}</small></span><kbd>R</kbd></button><button className="fp-tool-button" title={commandTitle} disabled={commandDisabled || !fighter || (me?.toolReadyTick ?? 0) > view.tick || view.phase === 'preparation'} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); useTool(e.pointerId) }} onPointerUp={e => controls.current?.tool(false, e.pointerId)} onPointerCancel={e => controls.current?.tool(false, e.pointerId)} onLostPointerCapture={e => controls.current?.tool(false, e.pointerId)} onKeyDown={e => { if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); useTool(e.key) } }} onKeyUp={e => { if (e.key === 'Enter' || e.key === ' ') controls.current?.tool(false, e.key) }}><Icon name={me?.tool === 'repair' ? 'build' : 'shield'} /><span>{name(me?.tool ?? 'barrier', lang)}<small>{(me?.toolReadyTick ?? 0) > view.tick ? `${seconds(me!.toolReadyTick! - view.tick)} ${t('с', 's')}` : t('Готов', 'Ready')}</small></span><kbd>Space</kbd></button></div>}
        <div className="fp-route-control"><span>{t('Следующий транспорт', 'Next transport')}<small>{Math.floor(view.teams[view.yourTeam].charge ?? 0)} / 120 {t('заряд', 'charge')}</small></span>{(['N', 'S'] as const).map(route => <button key={route} className={(view.teams[view.yourTeam].manualRoute ?? view.teams[view.yourTeam].nextRoute) === route ? 'selected' : ''} title={commandTitle ?? (view.tick - (view.teams[view.yourTeam].routeChangedTick ?? -100) < 90 ? errorText('ROUTE_COOLDOWN', lang) : undefined)} disabled={commandDisabled || view.tick - (view.teams[view.yourTeam].routeChangedTick ?? -100) < 90} onClick={() => void act({ type: 'route', route })}>{name(route, lang)}</button>)}</div>
        <button className="fp-mode-switch" onClick={chooseTactics} disabled={commandDisabled} title={commandTitle} aria-pressed={me?.mode === 'tactics'}><Icon name={me?.mode === 'tactics' ? 'target' : 'tactics'} /><span>{me?.mode === 'tactics' ? t('Боец', 'Fighter') : t('Тактика', 'Tactics')}</span><kbd>Tab</kbd></button>
      </footer>
      <div className="fp-quick-pings" aria-label={t('Сигналы команде', 'Team signals')}>{(['escort', 'help', 'build', 'north', 'south'] as const).map(ping => <button key={ping} disabled={commandDisabled} title={commandTitle} onClick={() => void act({ type: 'ping', ping, ...(fighter ? { point: { x: fighter.x, z: fighter.z } } : {}) })}>{({ escort: t('Сопровождаю', 'Escorting'), help: t('Нужна помощь', 'Need help'), build: t('Строю здесь', 'Building here'), north: t('Север', 'North'), south: t('Юг', 'South') })[ping]}</button>)}</div>
      {(roundFinished || operationResult) && !lesson && <div className="fp-result-backdrop"><section className="fp-result" aria-label={t('Результат', 'Result')}><div className="fp-eyebrow">{roundFinished ? t('ОПЕРАЦИИ ЗАВЕРШЕНЫ', 'OPERATIONS COMPLETE') : t('ИТОГ ОПЕРАЦИИ', 'OPERATION RESULT')}</div><h1>{(roundFinished ? view.winner : view.operations.at(-1)?.winner) === null ? t('Ничья', 'Draw') : (roundFinished ? view.winner : view.operations.at(-1)?.winner) === view.yourTeam ? t('Победа', 'Victory') : t('Поражение', 'Defeat')}</h1><div className="fp-result-score"><span className="team-a">A {view.teams.A.wins}</span><i>:</i><span className="team-b">{view.teams.B.wins} B</span></div><div className="fp-result-operations">{view.operations.map(operation => <div key={operation.operation}><span>{t('Операция', 'Operation')} {operation.operation}</span><strong>{operation.deliveries.A} : {operation.deliveries.B}</strong><small>{name(operation.reason, lang)}{operation.reason === 'progress' ? ` · ${(operation.progress.A / 100).toFixed(1)}% / ${(operation.progress.B / 100).toFixed(1)}%` : ''}</small></div>)}</div>{roundFinished && me?.statistics && <div className="fp-result-stats"><span>{t('Расходы', 'Spent')}<b>{Math.floor(me.statistics.spent)} ¤</b></span><span>{t('Доход', 'Income')}<b>{Math.floor(me.statistics.income)} ¤</b></span><span>{t('Нанесённый урон', 'Damage dealt')}<b>{Math.floor(me.statistics.damage)}</b></span></div>}{roundFinished ? <div className="fp-result-actions">{sessionRoom ? <a className="fp-button primary" href={`/rooms/${encodeURIComponent(sessionRoom)}`}>{t('В комнату', 'Return to room')}</a> : <button className="fp-button primary" disabled={busy} onClick={() => void startPractice()}>{t('Сыграть ещё', 'Play again')}</button>}<button className="fp-button secondary" onClick={menu}>{t('В меню', 'Back to menu')}</button></div> : <p>{t('Следующая операция через', 'Next operation in')} {seconds(view.phaseRemainingTicks)} {t('с. Стороны поменяются.', 's. Teams will switch sides.')}</p>}</section></div>}
    </div>}
    {message && <div className="fp-toast" role="status"><span>{message}</span><button aria-label={t('Закрыть сообщение', 'Dismiss message')} onClick={() => setMessage('')}><Icon name="close" size={16} /></button></div>}
    {settingsOpen && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />}
    {helpOpen && <Dialog title={t('Как играть', 'How to play')} lang={lang} onClose={() => setHelpOpen(false)}><div className="fp-help"><h3>{t('Доставка решает исход', 'Delivery decides the outcome')}</h3><p>{t('Сопровождайте транспорт в пределах 4 метров. В круге комплекса должен остаться ваш боец или боевой дрон без противников на 3 секунды. Три доставки дают победу в операции; две победы — в матче.', 'Stay within 4 metres to escort a transport. Hold the complex circle with your fighter or combat drone and no enemies for 3 seconds. Three deliveries win an operation; two wins take the match.')}</p><p>{t('Транспорты видны обеим командам на радаре. Это не раскрывает их сопровождение.', 'Transports are visible on both teams’ radar. Their escorts remain hidden unless spotted.')}</p><h3>{t('Бой и тактика', 'Fighting and tactics')}</h3><p>{t('WASD / стрелки — движение. Мышь — прицел, удержание — огонь. R — перезарядить, Space — инструмент. Tab — тактика. 1–4 — свой отряд. В тактике выберите объект, затем приказ и цель; правая кнопка отдаёт контекстный приказ.', 'WASD / arrows move. Mouse aims; hold to fire. R reloads, Space uses the tool. Tab switches tactics. 1–4 select your squad. In tactics, choose a unit, order and destination; right-click issues a context order.')}</p><h3>{t('Строительство и питание', 'Construction and power')}</h3><p>{t('Площадки находятся на вашей стороне. Ретрансляторы продлевают сеть команды. Мощность и кредиты — личные. Строитель выполняет очередь физически; выключенные здания остаются на карте, но не работают.', 'Build pads are on your side. Relays extend the team network. Power and credits are personal. Your builder travels to complete orders; unpowered buildings remain on the map but do not operate.')}</p><button className="fp-button secondary" onClick={() => { setHelpOpen(false); setTutorialChooser(true) }}>{t('Открыть обучение', 'Open tutorial')}</button></div></Dialog>}
    {exitOpen && <Dialog title={t('Меню партии', 'Game menu')} lang={lang} onClose={() => setExitOpen(false)}><p>{lesson ? t('Урок сохраняется отдельно. Обычная партия останется на месте.', 'Lessons are saved separately. Your regular game stays intact.') : t('После выхода управление примет бот. Когда уйдут все люди, партия сохранится на 24 часа.', 'A bot will take control after you leave. When everyone leaves, the game is saved for 24 hours.')}</p><button className="fp-button primary wide" onClick={() => setExitOpen(false)}>{t('Продолжить', 'Continue')}</button><button className="fp-button secondary wide" onClick={() => { setExitOpen(false); setSettingsOpen(true) }}>{t('Настройки', 'Settings')}</button><button className="fp-button secondary wide" onClick={menu}>{t('В главное меню', 'Main menu')}</button></Dialog>}
    {confirmation && <Dialog title={t('Подтверждение', 'Confirm action')} lang={lang} onClose={() => setConfirmation(null)}><p>{confirmation.message}</p><div className="fp-confirm-actions"><button className="fp-button secondary" onClick={() => setConfirmation(null)}>{t('Отмена', 'Cancel')}</button><button className="fp-button primary" disabled={busy || commandBlockReason(commandState, true) !== null} title={commandBlockReason(commandState, true) ? errorText(commandBlockReason(commandState, true)!, lang) : undefined} onClick={() => void act(confirmation.action, true)}>{busy ? t('Выполняем…', 'Working…') : t('Подтвердить', 'Confirm')}</button></div></Dialog>}
    {tutorialChooser && <Dialog title={t('Обучение', 'Tutorial')} lang={lang} onClose={() => setTutorialChooser(false)}><p>{t('Каждый урок — отдельное упражнение. Вы можете начать с любого.', 'Each lesson is a separate exercise. Start with any of them.')}</p><div className="fp-lesson-list">{lessonCopy.map((copy, i) => <button key={i} onClick={() => startLesson(i)}><span>{i + 1}</span><strong>{copy[0][lang === 'ru' ? 0 : 1]}</strong><Icon name="chevron" /></button>)}</div><button className="fp-button secondary wide" onClick={() => startLesson(0, true)}>{t('Продолжить сохранённый урок', 'Resume saved lesson')}</button></Dialog>}
    <span className="fp-build-id" data-build={__FORPOST_BUILD__} aria-hidden="true" />
  </div>
}

function TouchControls({ controls, lang, onTool, onReload, cooldown, actionsDisabled, toolUnavailable }: { controls: Controls | null; lang: Settings['language']; onTool: (source?: ToolInputSource) => void; onReload: () => void; cooldown: number; actionsDisabled: boolean; toolUnavailable: boolean }) {
  const [stick, setStick] = useState({ x: 0, y: 0 }), [aimStick, setAimStick] = useState({ x: 0, y: 0 })
  useEffect(() => {
    const clear = () => { setStick({ x: 0, y: 0 }); setAimStick({ x: 0, y: 0 }) }
    const hidden = () => { if (document.hidden) clear() }
    window.addEventListener('blur', clear); window.addEventListener('orientationchange', clear); document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('blur', clear); window.removeEventListener('orientationchange', clear); document.removeEventListener('visibilitychange', hidden); controls?.neutral() }
  }, [controls])
  const update = (event: React.PointerEvent<HTMLButtonElement>, aiming: boolean) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rect = event.currentTarget.getBoundingClientRect(), x = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2), y = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2), length = Math.max(1, Math.hypot(x, y)), value = { x: x / length, y: y / length }
    if (aiming) { setAimStick(value); controls?.aim({ x: value.x, z: value.y / .866 }); controls?.fire(Math.hypot(x, y) > .35, 'touch-aim') } else { setStick(value); controls?.touchMove({ x: value.x, z: value.y / .866 }) }
  }
  const reset = (aiming: boolean) => { if (aiming) { setAimStick({ x: 0, y: 0 }); controls?.fire(false, 'touch-aim') } else { setStick({ x: 0, y: 0 }); controls?.touchMove({ x: 0, z: 0 }) } }
  return <div className="fp-touch-controls"><button className="fp-joystick move-stick" aria-label={text(lang, 'Джойстик движения', 'Movement joystick')} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); update(e, false) }} onPointerMove={e => update(e, false)} onPointerUp={() => reset(false)} onPointerCancel={() => reset(false)} onLostPointerCapture={() => reset(false)}><span style={{ transform: `translate(${stick.x * 25}px, ${stick.y * 25}px)` }} /><small>{text(lang, 'ДВИЖЕНИЕ', 'MOVE')}</small></button><div className="fp-touch-right"><button className="fp-touch-reload" disabled={actionsDisabled} onClick={onReload} aria-label={text(lang, 'Перезарядить', 'Reload')}><Icon name="reload" /></button><button className="fp-touch-tool" disabled={actionsDisabled || toolUnavailable || cooldown > 0} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); onTool(e.pointerId) }} onPointerUp={e => controls?.tool(false, e.pointerId)} onPointerCancel={e => controls?.tool(false, e.pointerId)} onLostPointerCapture={e => controls?.tool(false, e.pointerId)} onKeyDown={e => { if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onTool(e.key) } }} onKeyUp={e => { if (e.key === 'Enter' || e.key === ' ') controls?.tool(false, e.key) }} aria-label={text(lang, 'Применить инструмент', 'Use tool')}>{cooldown > 0 ? seconds(cooldown) : <Icon name="shield" />}</button><button className="fp-joystick aim-stick" aria-label={text(lang, 'Прицеливание и огонь', 'Aim and fire')} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); update(e, true) }} onPointerMove={e => update(e, true)} onPointerUp={() => reset(true)} onPointerCancel={() => reset(true)} onLostPointerCapture={() => reset(true)}><span style={{ transform: `translate(${aimStick.x * 23}px, ${aimStick.y * 23}px)` }}><Icon name="target" /></span></button><button className="fp-touch-fire" aria-label={text(lang, 'Огонь', 'Fire')} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); controls?.fire(true, 'touch') }} onPointerUp={() => controls?.fire(false, 'touch')} onPointerCancel={() => controls?.fire(false, 'touch')} onLostPointerCapture={() => controls?.fire(false, 'touch')}><Icon name="target" size={30} /><small>{text(lang, 'ОГОНЬ', 'FIRE')}</small></button></div></div>
}
