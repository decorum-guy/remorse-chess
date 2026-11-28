import { launchUrls } from '@iva-games/game-registry';
import { useLanguage } from './ui';
import type { Room } from './types';

export const forpostLaunchUrl = launchUrls({ development: import.meta.env.DEV, overrides: import.meta.env }).forpost;
export function ForpostStartWaiting({ waiting }: { waiting: NonNullable<Room['startWaiting']> }) {
  const { t } = useLanguage();
  const messages = {
    capacity: t('Ждём свободное место на сервере. Запуск повторится автоматически.', 'Waiting for server capacity. Your game will start automatically.'),
    updating: t('Сервис обновляется. Запуск продолжится автоматически.', 'The service is updating. Your game will start automatically.'),
    another_start: t('Сначала дождитесь запуска вашей другой комнаты.', 'Wait for your other room to start first.'),
    service: t('Восстанавливаем связь с игровым сервером. Повторим запуск автоматически.', 'Reconnecting to the game server. We will retry your start automatically.'),
  };
  return <span className="forpost-start-waiting" role="status">{messages[waiting.reason]}
    {Number.isInteger(waiting.queuePosition) && waiting.queuePosition! > 0 && <small style={{ display: 'block', marginTop: 8 }}>{t('Место в очереди', 'Queue position')}: {waiting.queuePosition}</small>}
  </span>;
}
export const forpostMaps = [
  { id: 'FP01', ru: 'Литейный двор', en: 'Foundry Yard' },
  { id: 'FP02', ru: 'Каналы', en: 'Canals' },
  { id: 'FP03', ru: 'Длинный обход', en: 'Long Way Around' },
];
export function ForpostMapSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t, lang } = useLanguage();
  return <div className="forpost-lobby-map">
    <label>{t('Карта операции', 'Operation map')}<select value={value} onChange={event => onChange(event.target.value)}>
      {forpostMaps.map(map => <option value={map.id} key={map.id}>{map.id} · {map[lang]}</option>)}
      <option value="random">{t('Случайная карта', 'Random map')}</option>
    </select></label>
    {value !== 'random' && <img src={`${forpostLaunchUrl}assets/forpost/${value.toLowerCase()}.svg`} alt={t('План выбранной карты', 'Selected map layout')} style={{ width: '100%', maxHeight: 170, objectFit: 'contain', background: '#101c24' }} />}
    <p className="form-note">{t('Две равные команды. Все места нужно занять людьми или явными ботами до старта.', 'Two equal teams. Fill every seat with a person or a labelled bot before starting.')}</p>
  </div>;
}
export function ForpostRoomMap({ mapId }: { mapId: unknown }) {
  const { t, lang } = useLanguage(), map = forpostMaps.find(item => item.id === mapId);
  if (!map) return null;
  return <div className="forpost-room-map" style={{ display: 'flex', gap: 20, alignItems: 'center', marginBottom: 20, padding: 16, background: '#f0f4f2', borderRadius: 12 }}>
    <img src={`${forpostLaunchUrl}assets/forpost/${map.id.toLowerCase()}.svg`} alt={t('План операции', 'Operation layout')} style={{ width: 150, maxWidth: '42%', height: 95, objectFit: 'contain' }} />
    <div><strong>{map.id} · {map[lang]}</strong><p style={{ margin: '6px 0 0' }}>{t('До трёх операций. Побеждает команда, выигравшая две. После операции стороны меняются.', 'Up to three operations. Win two to take the match. Teams switch sides after each operation.')}</p></div>
  </div>;
}
interface Setup { team: 'A' | 'B'; weapon: string; tool: string; botLevel: string }
export function forpostSetupFor(room: Room, member: Room['members'][number]): Setup {
  const settings = room.settings.loadouts as Record<string, Partial<Setup>> | undefined;
  return { team: member.seatIndex % 2 ? 'B' : 'A', weapon: 'carbine', tool: 'barrier', botLevel: member.controller.kind === 'bot' ? { easy: 'novice', normal: 'normal', hard: 'strong' }[member.controller.difficulty] : 'normal', ...settings?.[member.participantId] };
}
export function ForpostSetupFields({ room, member, userId, host, busy, mutate }: {
  room: Room; member: Room['members'][number]; userId: string; host: boolean; busy: boolean;
  mutate: (path: string, body?: unknown) => Promise<boolean>;
}) {
  const { t } = useLanguage(), setup = forpostSetupFor(room, member);
  const bot = member.controller.kind === 'bot', owns = bot ? host : member.playerId === userId;
  const editable = owns && room.state === 'lobby' && (bot || !member.ready);
  const update = (key: keyof Setup, value: string) => void mutate(`/rooms/${room.roomId}/forpost-setup`, { expectedRevision: room.revision, participantId: member.participantId, [key]: value });
  return <div className="forpost-seat-setup" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 10px 14px', borderBottom: '1px solid #dfe8e4', marginBottom: 8 }}>
    <label style={{ flex: '1 0 72px', fontSize: 12 }}>{t('Команда', 'Team')}<select aria-label={`${t('Команда', 'Team')} · ${member.displayName}`} value={setup.team} disabled={busy || !editable} onChange={event => update('team', event.target.value)}><option value="A">▲ A</option><option value="B">⬢ B</option></select></label>
    <label style={{ flex: '2 0 100px', fontSize: 12 }}>{t('Оружие', 'Weapon')}<select aria-label={`${t('Оружие', 'Weapon')} · ${member.displayName}`} value={setup.weapon} disabled={busy || !editable} onChange={event => update('weapon', event.target.value)}><option value="carbine">{t('Карабин', 'Carbine')}</option><option value="shotgun">{t('Дробовик', 'Shotgun')}</option><option value="rifle">{t('Винтовка', 'Rifle')}</option></select></label>
    <label style={{ flex: '2 0 100px', fontSize: 12 }}>{t('Инструмент', 'Tool')}<select aria-label={`${t('Инструмент', 'Tool')} · ${member.displayName}`} value={setup.tool} disabled={busy || !editable} onChange={event => update('tool', event.target.value)}><option value="barrier">{t('Барьер', 'Barrier')}</option><option value="smoke">{t('Дым', 'Smoke')}</option><option value="repair">{t('Ремонт', 'Repair')}</option></select></label>
    {bot && <label style={{ flex: '1 0 90px', fontSize: 12 }}>{t('Уровень бота', 'Bot level')}<select aria-label={`${t('Уровень бота', 'Bot level')} · ${member.displayName}`} value={setup.botLevel} disabled={busy || !editable} onChange={event => update('botLevel', event.target.value)}><option value="novice">{t('Новичок', 'Novice')}</option><option value="normal">{t('Обычный', 'Normal')}</option><option value="strong">{t('Сильный', 'Strong')}</option></select></label>}
    {owns && member.ready && !bot && room.state === 'lobby' && <small style={{ width: '100%' }}>{t('Снимите готовность, чтобы изменить оснащение или команду.', 'Unready to change your loadout or team.')}</small>}
  </div>;
}
