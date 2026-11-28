import type { MapId } from '../core/types';
export type Language = 'ru' | 'en';
export const MAP_COPY: Record<MapId, { name: [string, string]; description: [string, string]; terrain: [string, string]; number: string }> = {
  valley: { name: ['Мостовая долина', 'Bridge Valley'], description: ['Большой генератор, сломанный мост и дорога вверх.', 'A huge generator, a broken bridge and the road uphill.'], terrain: ['Переправы · брод · подъём', 'Bridges · ford · climb'], number: '01' },
  quarry: { name: ['Затопленный карьер', 'Flooded Quarry'], description: ['Длинная мачта и три пути через воду. Соберите свой паром.', 'A long mast and three routes across the water. Assemble your ferry.'], terrain: ['Вода · паром · наклонная полка', 'Water · ferry · tilted ledge'], number: '02' },
  ridge: { name: ['Ветровой хребет', 'Wind Ridge'], description: ['Высокий груз, порывы ветра и подъёмник над пропастью.', 'Tall cargo, gusting wind and a lift above the ravine.'], terrain: ['Высота · ветер · подъёмник', 'Height · wind · lift'], number: '03' },
  tutorial: { name: ['Учебная площадка', 'Training Grounds'], description: ['Восемь коротких действий — и можно в путь.', 'Eight short challenges, then you are ready to go.'], terrain: ['Ходьба · техника · инструменты', 'Movement · driving · tools'], number: '00' },
};
export function translated(pair: readonly [string, string], language: Language) { return pair[language === 'ru' ? 0 : 1]; }
const errors: Record<string, [string, string]> = {
  NETWORK: ['Связь прервалась. Попробуйте ещё раз.', 'Connection interrupted. Please try again.'],
  NO_CONTROL: ['Сначала верните управление.', 'Take back control first.'],
  WORLD_CHANGED: ['Мир восстановлен. Выберите действие заново.', 'The world was restored. Choose your action again.'],
  STALE_EPOCH: ['Мир обновляется…', 'Updating the world…'],
  STALE_CONTROLLER: ['Управление передано другому устройству.', 'Control moved to another device.'],
  ACTION_TIMEOUT: ['Ответ задерживается. Проверьте состояние предмета.', 'The reply is delayed. Check the object before retrying.'],
  SESSION_REQUIRED: ['Войдите в аккаунт Iva Games.', 'Sign in to your Iva Games account.'],
  UNAUTHENTICATED: ['Войдите в аккаунт Iva Games.', 'Sign in to your Iva Games account.'],
  EMAIL_NOT_VERIFIED: ['Сначала подтвердите аккаунт.', 'Verify your account first.'],
  NOT_READY: ['Все участники должны нажать «Готов».', 'Everyone must choose Ready.'],
  REVISION_CONFLICT: ['Комната обновилась. Попробуйте ещё раз.', 'The room changed. Please try again.'],
  ROOM_FULL: ['Все места уже заняты.', 'All seats are taken.'],
  FORBIDDEN: ['Это действие недоступно вашему участнику.', 'This action is not available to your participant.'],
  NOT_FOUND: ['Комната недоступна. Вернитесь к списку.', 'The room is unavailable. Return to your rooms.'],
  GAME_UNAVAILABLE: ['Сервер игры ещё не готов. Попробуйте позже.', 'The game server is not ready yet. Try later.'],
  RATE_LIMITED: ['Действия отправляются слишком часто. Подождите.', 'Too many actions. Wait a moment.'],
  RATE_LIMIT: ['Команды отправляются слишком часто. Отпустите управление и повторите действие.', 'Commands are arriving too quickly. Release the controls and try again.'],
  VERSION_UNAVAILABLE: ['Версия этой экспедиции временно недоступна. Сохранение остаётся на сервере.', 'This expedition’s version is temporarily unavailable. Its save remains on the server.'],
  CLIENT_CONTENT_UNAVAILABLE: ['Не удалось открыть сохранённую версию игры. Сохранение остаётся на сервере.', 'The retained game version is unavailable. Its save remains on the server.'],
  SERVER_UPDATING: ['Сервер обновляется. Дождитесь восстановления связи.', 'The server is updating. Wait for the connection to return.'],
  INVALID_RESPONSE: ['Не удалось загрузить мир. Переподключитесь.', 'The world could not be loaded. Reconnect.'],
};
export function errorCopy(code: string, language: Language) { return translated(errors[code] ?? errors.NETWORK, language); }
