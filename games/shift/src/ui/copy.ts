import type { ArenaId, GameEvent, RejectReason, Role, TeamId } from '../core/types';
export type Language = 'ru' | 'en';
export const text = (lang: Language, ru: string, en: string) => lang === 'ru' ? ru : en;
export const roleName = (lang: Language, role: Role) => role === 'pilot' ? text(lang, 'Пилот', 'Pilot') : text(lang, 'Штурман', 'Navigator');
export const teamName = (lang: Language, team: TeamId) => team === 'teal' ? text(lang, 'Бирюза', 'Teal') : text(lang, 'Янтарь', 'Amber');
export const arenaCopy: Record<ArenaId, { title: [string, string]; subtitle: [string, string]; detail: [string, string] }> = {
  foundry: { title: ['Крановый цех', 'Crane foundry'], subtitle: ['Длинные линии. Быстрый нижний обход.', 'Long sightlines. A fast lower flank.'], detail: ['Уведите батарею вниз и откройте пилоту путь вдоль края.', 'Slide the battery south and open a route along the edge.'] },
  calibration: { title: ['Калибровка', 'Calibration'], subtitle: ['Чистый центр. Меняйте угол атаки.', 'Open centre. Change the angle of attack.'], detail: ['Пилоны прячут подход. Сдвиг меняет сторону, с которой вас ждут.', 'Pillars conceal the approach. A shift changes where you emerge.'] },
  depot: { title: ['Склад модулей', 'Module depot'], subtitle: ['Боковые проходы. Выгодный перехват.', 'Side passages. Timely interceptions.'], detail: ['Обойдите центральные контейнеры или перевезите пилота вместе с ними.', 'Flank the central containers or carry your pilot past them.'] },
};
export function rejectCopy(lang: Language, reason?: string): string {
  const map: Record<RejectReason | string, [string, string]> = {
    PHASE: ['Дождитесь начала раунда', 'Wait for the round to start'], ROLE: ['Сдвиг доступен штурману', 'Only the navigator can shift rooms'],
    STALE_ROUND: ['Начался новый раунд', 'A new round has started'], STALE_EPOCH: ['Управление открыто в другой вкладке', 'Another tab has control'],
    STALE_SEQUENCE: ['Управление обновилось', 'Controls have updated'], INVALID_INPUT: ['Повторите действие', 'Try the action again'],
    INVALID_ACTION: ['Выберите действие ещё раз', 'Choose the action again'], REVISION: ['Этаж изменился — выберите комнату', 'The floor changed — choose a room'],
    MOVING: ['Комната ещё едет', 'A room is still moving'], NOT_ADJACENT: ['Комната должна касаться шахты стороной', 'Choose a room beside the shaft'],
    COOLDOWN: ['Привод перезаряжается', 'The drive is recharging'], REVERSE_LOCK: ['Обратный ход пока заблокирован', 'The reverse move is briefly locked'],
    PRIORITY: ['Соперник начал сдвиг первым', 'The other team shifted first'], DEAD: ['Дождитесь возвращения дрона', 'Wait for your drone to return'],
    OUT_OF_REACH: ['Подойдите к батарее ближе', 'Move closer to the battery'], TAKEN: ['Батарею уже забрали', 'The battery was picked up'],
    PING_LIMIT: ['Немного подождите перед новой меткой', 'Wait a moment before the next ping'], NOT_VISIBLE: ['Сначала найдите цель', 'Find the target first'],
    ACTION_CONFLICT: ['Действие уже обработано', 'The action was already handled'], UNKNOWN_SEAT: ['Переподключитесь к комнате', 'Reconnect to the room'],
    CONNECTION: ['Восстанавливаем соединение…', 'Reconnecting…'], FORBIDDEN: ['Нет доступа к этой комнате', 'You cannot access this room'],
    MATCH_CHANGED: ['Комната вернулась в лобби', 'The room has returned to the lobby'],
  };
  return (map[reason || ''] || ['Не получилось. Повторите действие.', 'Please try the action again.'])[lang === 'ru' ? 0 : 1];
}
export function eventCopy(lang: Language, event: GameEvent, names: Record<string, string>): string {
  const who = event.seatId ? names[event.seatId] || roleName(lang, 'pilot') : '';
  switch (event.kind) {
    case 'shift-start': return text(lang, `${who} передвигает ${event.roomId}`, `${who} is shifting ${event.roomId}`);
    case 'shift-end': return text(lang, `Комната ${event.roomId} на месте`, `Room ${event.roomId} docked`);
    case 'pickup': return text(lang, `Батарея у команды ${event.team ? teamName(lang, event.team) : ''}`, `${event.team ? teamName(lang, event.team) : ''} team carrying`);
    case 'drop': return text(lang, 'Батарея на полу', 'Battery dropped');
    case 'return': return text(lang, 'Батарея вернулась в O', 'Battery returned to O');
    case 'delivered': return who ? text(lang, `${who} доставил батарею`, `${who} delivered the battery`) : text(lang, `Команда ${event.team ? teamName(lang, event.team) : ''} доставила батарею`, `${event.team ? teamName(lang, event.team) : 'A'} team delivered the battery`);
    case 'down': return text(lang, `${who} возвращается на базу`, `${who} is returning to base`);
    case 'respawn': return text(lang, `${who} снова в строю`, `${who} is back`);
    case 'round-end': return text(lang, event.reason === 'timeout' ? 'Время вышло' : 'Доставлено', event.reason === 'timeout' ? 'Time is up' : 'Delivered');
    case 'recovery': return text(lang, 'Матч восстановлен. Приготовьтесь.', 'Match restored. Get ready.');
    case 'ping': return text(lang, `${who} поставил метку`, `${who} marked a position`);
    default: return '';
  }
}
