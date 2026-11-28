import { useEffect, useState } from 'react';
import type { MapId } from '../core/types';
import type { Player, Room } from './api';
import { api } from './api';
import type { Language } from './copy';
import { MAP_COPY, translated, errorCopy } from './copy';
import { Icon, MapSketch, Dialog } from './ui';
import { defaultAppearance, pendingAppearance, rememberAppearance } from './appearance';
import type { AppearanceChoice } from './appearance';

export function Lobby({ room, user, lang, onUpdate, onExit }: { room: Room; user: Player; lang: Language; onUpdate: (room: Room) => void; onExit: () => void }) {
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [friendDialog, setFriendDialog] = useState(false);
  const [friends, setFriends] = useState<Player[]>([]), [inviteState, setInviteState] = useState('');
  const host = room.hostPlayerId === user.playerId, self = room.members.find(m => m.playerId === user.playerId);
  const map = (room.settings.mapId as MapId) ?? 'valley', info = MAP_COPY[map] ?? MAP_COPY.valley;
  const lobby = room.state === 'lobby';
  const [appearance, setAppearance] = useState<AppearanceChoice>(() => pendingAppearance(room.roomId, user.playerId) ?? defaultAppearance(user.playerId));
  useEffect(() => {
    const choice = pendingAppearance(room.roomId, user.playerId) ?? defaultAppearance(user.playerId);
    setAppearance(choice); if (lobby) rememberAppearance(room.roomId, user.playerId, choice);
  }, [room.roomId, user.playerId, lobby]);
  const chooseAppearance = (choice: AppearanceChoice) => { setAppearance(choice); rememberAppearance(room.roomId, user.playerId, choice); };
  async function mutate(path: string, body: unknown) {
    setBusy(true); setError('');
    try { const result = await api<{ room: Room }>(`/rooms/${room.roomId}/${path}`, body); onUpdate(result.room); }
    catch (e) { setError(errorCopy(e instanceof Error ? e.message : 'NETWORK', lang)); const current = await api<{ room: Room }>(`/rooms/${room.roomId}`).catch(() => null); if (current) onUpdate(current.room); }
    finally { setBusy(false); }
  }
  const ready = room.members.length >= 2 && room.members.every(m => m.ready) && room.reservedSeats === 0;
  const readyReason = room.members.length < 2 ? t('Нужен ещё один человек или бот.', 'Add one friend or bot.') : room.reservedSeats ? t('Приглашённый участник ещё не вошёл.', 'An invited player has not joined yet.') : t('Ждём готовности всех участников.', 'Waiting for everyone to be ready.');
  return <main className="ty-lobby ty-page">
    <header className="ty-page-header"><button className="ty-back" onClick={onExit}><Icon name="arrow"/>{t('Экспедиции', 'Expeditions')}</button><span className="ty-eyebrow">{t('Собираем команду', 'Assembling the crew')}</span><span className="ty-brand-mini">ТЯГА</span></header>
    <div className="ty-lobby-grid">
      <section className="ty-lobby-map"><MapSketch map={map}/><span className="ty-eyebrow">{t('Маршрут', 'Route')} {info.number}</span><h1>{translated(info.name, lang)}</h1><p>{translated(info.description, lang)}</p>
        <div className="ty-field"><label htmlFor="ty-lobby-map">{t('Карта', 'Map')}</label><select id="ty-lobby-map" disabled={!host || !lobby || busy} value={map} onChange={e => void mutate('settings', { expectedRevision: room.revision, settings: { ...room.settings, mapId: e.target.value, mode: e.target.value === 'tutorial' ? 'tutorial' : room.settings.mode === 'tutorial' ? 'expedition' : room.settings.mode } })}>{Object.entries(MAP_COPY).map(([id, value]) => <option key={id} value={id}>{translated(value.name, lang)}</option>)}</select></div>
        <div className="ty-field"><label htmlFor="ty-lobby-mode">{t('Режим', 'Mode')}</label><select id="ty-lobby-mode" disabled={!host || !lobby || busy || map === 'tutorial'} value={String(room.settings.mode ?? 'expedition')} onChange={e => void mutate('settings', { expectedRevision: room.revision, settings: { ...room.settings, mode: e.target.value } })}><option value="expedition">{t('Экспедиция', 'Expedition')}</option><option value="practice">{t('Практика — без повреждений', 'Practice — no damage')}</option>{map === 'tutorial' && <option value="tutorial">{t('Обучение', 'Training')}</option>}</select></div>
        {room.settings.mode === 'practice' && <p className="ty-note">{t('Машина и грузы не теряют целостность. Падения, вес и разрыв креплений остаются.', 'The truck and cargo take no damage. Weight, falling and broken attachments still matter.')}</p>}
        {!host && <p className="ty-note">{t('Маршрут выбирает создатель комнаты.', 'The room owner chooses the route.')}</p>}
      </section>
      <section className="ty-crew-card"><div className="ty-section-heading"><div><span className="ty-eyebrow">{room.title}</span><h2>{t('Ваша команда', 'Your crew')}</h2></div><span className="ty-count">{room.members.length} / {room.capacity}</span></div>
        <div className="ty-seats">{Array.from({ length: room.capacity }, (_, i) => {
          const member = room.members.find(m => m.seatIndex === i);
          return member ? <div className="ty-seat" key={i}><span className={'ty-person seat-' + i}><Icon name={member.controller.kind === 'bot' ? 'tool' : 'crew'} size={22}/></span><div><strong>{member.controller.kind === 'bot' ? `${t('Бот', 'Bot')} · ${member.controller.difficulty === 'hard' ? t('Осторожный водитель', 'Careful driver') : t('Помощник', 'Helper')}` : member.displayName}{member.playerId === user.playerId && <small> {t('(вы)', '(you)')}</small>}</strong><span>{member.ready ? t('Готов к дороге', 'Ready for the road') : t('Собирается', 'Getting ready')}</span></div>{member.ready && <span className="ty-ready-check"><Icon name="check"/></span>}{host && lobby && member.controller.kind === 'bot' && <button className="ty-icon-button" aria-label={t('Убрать бота', 'Remove bot')} disabled={busy} onClick={() => void mutate(`bots/${member.participantId}/remove`, { expectedRevision: room.revision })}><Icon name="minus"/></button>}</div>
            : <div className="ty-seat empty" key={i}><span className="ty-person"><Icon name="plus"/></span><span>{t('Свободное место', 'Open seat')}</span></div>;
        })}</div>
        {host && lobby && <div className="ty-crew-tools"><button className="ty-button secondary" disabled={busy || room.members.length + room.reservedSeats >= room.capacity} onClick={() => void mutate('bots', { difficulty: 'normal', expectedRevision: room.revision })}><Icon name="plus"/>{t('Помощник', 'Helper')}</button><button className="ty-button secondary" disabled={busy || room.members.length + room.reservedSeats >= room.capacity} onClick={() => void mutate('bots', { difficulty: 'hard', expectedRevision: room.revision })}><Icon name="truck"/>{t('Водитель', 'Driver')}</button>
          <button className="ty-button subtle" disabled={busy || room.members.length + room.reservedSeats >= room.capacity} onClick={() => { setFriendDialog(true); void api<{ social?: { friends: Player[] }; friends?: Player[] }>('/social').then(r => setFriends(r.social?.friends ?? r.friends ?? [])).catch(() => setError(t('Не удалось загрузить друзей.', 'Could not load your friends.'))); }}><Icon name="crew"/>{t('Позвать друга', 'Invite a friend')}</button></div>}
        <p className="ty-note">{t('Все умеют водить и работать с инструментами. Занятия можно менять прямо в пути.', 'Everyone can drive and use every tool. Switch jobs whenever you need.')}</p>
        {lobby && self && <section aria-label={t('Ваш персонаж', 'Your character')}>
          <h3>{t('Ваш персонаж', 'Your character')}</h3>
          <div className="ty-field"><label htmlFor="ty-lobby-head">{t('Головной убор', 'Headwear')}</label><select id="ty-lobby-head" value={appearance.head} onChange={event => chooseAppearance({ ...appearance, head: Number(event.target.value) as 0 | 1 })}><option value="0">{t('Каска и гарнитура', 'Helmet and headset')}</option><option value="1">{t('Шапка и очки', 'Beanie and goggles')}</option></select></div>
          <div className="ty-field"><label htmlFor="ty-lobby-backpack">{t('Рюкзак', 'Backpack')}</label><select id="ty-lobby-backpack" value={appearance.backpack} onChange={event => chooseAppearance({ ...appearance, backpack: Number(event.target.value) as 0 | 1 })}><option value="0">{t('Походный', 'Field pack')}</option><option value="1">{t('Технический', 'Technical pack')}</option></select></div>
          <p className="ty-note">{t('Внешность не меняет силу и возможности. В пути её можно изменить в меню.', 'Appearance does not change strength or abilities. Change it from the menu during an expedition.')}</p>
        </section>}
        {error && <p className="ty-alert" role="alert">{error}</p>}
        <div className="ty-start-block">
          {lobby && self && <button className={'ty-button ' + (self.ready ? 'secondary selected' : 'primary')} disabled={busy} onClick={() => void mutate('ready', { ready: !self.ready, expectedRevision: room.revision })}><Icon name="check"/>{self.ready ? t('Я готов', 'I am ready') : t('Готов к дороге', 'Ready for the road')}</button>}
          {host && lobby && <button className="ty-button primary" disabled={busy || !ready} title={!ready ? readyReason : undefined} onClick={() => void mutate('start', { expectedRevision: room.revision })}>{busy ? t('Подготовка…', 'Preparing…') : t('Отправиться', 'Set off')}<Icon name="arrow"/></button>}
          {!ready && lobby && <p className="ty-note">{readyReason}</p>}
          {room.state === 'starting' && <p className="ty-note" role="status">{room.startStatus?.state === 'queued' ? <>{t('Ожидаем свободный сервер', 'Waiting for a free server')}{room.startStatus.position ? ` · ${t('место', 'position')} ${room.startStatus.position}` : ''}. {t('Команда сохранена. Экспедиция начнётся автоматически.', 'Your crew is saved. The expedition will start automatically.')}</> : t('Готовим машину и маршрут…', 'Preparing the truck and route…')}</p>}
        </div>
      </section>
    </div>
    {friendDialog && <Dialog title={t('Позвать друга', 'Invite a friend')} onClose={() => setFriendDialog(false)}>
      <p className="ty-note">{t('Приглашение появится в Iva Games. Если у друга включены уведомления, он получит его и в Telegram.', 'The invitation appears in Iva Games. Friends with notifications enabled may also receive it in Telegram.')}</p>
      {friends.length ? friends.map(friend => <button className="ty-button secondary wide" key={friend.playerId} disabled={busy || room.members.some(m => m.playerId === friend.playerId)} onClick={() => { setBusy(true); void api(`/rooms/${room.roomId}/invitations`, { playerId: friend.playerId }).then(() => setInviteState(t('Приглашение отправлено', 'Invitation sent'))).catch(e => setInviteState(errorCopy(e.message, lang))).finally(() => setBusy(false)); }}>{friend.displayName}<Icon name="arrow"/></button>) : <p>{t('Сначала добавьте друга в Iva Games.', 'Add friends in Iva Games first.')}</p>}
      {inviteState && <p role="status">{inviteState}</p>}<a className="ty-text-link" href="/friends">{t('Открыть друзей', 'Open friends')}</a>
    </Dialog>}
  </main>;
}
