import type { BuildingKind, MapId, Tool, Weapon } from '../core/types'

export type Language = 'ru' | 'en'
export const text = (lang: Language, ru: string, en: string): string => lang === 'ru' ? ru : en
export const labels: Record<string, [string, string]> = {
  fighter: ['Боец', 'Fighter'], builder: ['Строитель', 'Builder'], drone: ['Боевой дрон', 'Combat drone'],
  transport: ['Транспорт', 'Transport'], relay: ['Ретранслятор', 'Relay'], generator: ['Генератор', 'Generator'],
  extractor: ['Экстрактор', 'Extractor'], turret: ['Турель', 'Turret'], dock: ['Док дронов', 'Drone dock'],
  battery: ['Лучевая батарея', 'Beam battery'], post: ['Полевой пункт', 'Field post'], bridge: ['Мост', 'Bridge'],
  carbine: ['Карабин', 'Carbine'], shotgun: ['Дробовик', 'Shotgun'], rifle: ['Винтовка', 'Rifle'],
  barrier: ['Барьер', 'Barrier'], smoke: ['Дым', 'Smoke'], repair: ['Ремонтный луч', 'Repair beam'],
  preparation: ['Подготовка', 'Preparation'], battle: ['Операция', 'Operation'], overtime: ['Дополнительное время', 'Overtime'],
  operationResult: ['Итог операции', 'Operation result'], finished: ['Матч завершён', 'Match finished'],
  novice: ['Новичок', 'Beginner'], normal: ['Обычный', 'Normal'], strong: ['Сильный', 'Strong'],
  move: ['Идти', 'Move'], guard: ['Охранять', 'Guard'], attack: ['Атаковать', 'Attack'], capture: ['Захватить', 'Capture'],
  escort: ['Сопровождать', 'Escort'], return: ['На базу', 'Return to base'], stop: ['Остановиться', 'Stop'],
  deliveries: ['По доставкам', 'More deliveries'], progress: ['По продвижению транспорта', 'Transport progress'],
  equal: ['Равные доставки и продвижение', 'Equal deliveries and progress'], limit: ['Лимит времени', 'Time limit'],
  construction: ['Строится', 'Under construction'], network: ['Нет связи с базой', 'Outside base network'],
  power: ['Не хватает мощности', 'Not enough power'], N: ['Север', 'North'], S: ['Юг', 'South'],
}
export const name = (key: string, lang: Language): string => labels[key]?.[lang === 'ru' ? 0 : 1] ?? key
export const buildingDescription: Record<BuildingKind, [string, string]> = {
  relay: ['Продлевает общую сеть на 12 м.', 'Extends the team network by 12 m.'],
  generator: ['Даёт вам 4 единицы мощности.', 'Adds 4 power to your supply.'],
  extractor: ['Приносит вам 0,75 кредита в секунду.', 'Earns you 0.75 credits per second.'],
  turret: ['Защищает подходы автоматическим огнём.', 'Automatically defends nearby approaches.'],
  dock: ['Производит до двух ваших боевых дронов.', 'Produces up to two of your combat drones.'],
  battery: ['Дальний огонь по технике и постройкам.', 'Long-range fire against vehicles and structures.'],
  post: ['Позволяет вашему бойцу вернуться ближе к бою.', 'Lets your fighter respawn closer to the action.'],
  bridge: ['Открывает короткий проход для подразделений.', 'Opens a shortcut for your units.'],
}
export const weaponDescription: Record<Weapon, [string, string]> = {
  carbine: ['Точный непрерывный огонь', 'Precise sustained fire'], shotgun: ['Шесть лучей на близкой дистанции', 'Six pellets at close range'], rifle: ['Дальние прицельные выстрелы', 'Long-range precision shots'],
}
export const toolDescription: Record<Tool, [string, string]> = {
  barrier: ['На 4 секунды останавливает выстрелы.', 'Stops shots for 4 seconds.'],
  smoke: ['На 6 секунд перекрывает обзор.', 'Blocks vision for 6 seconds.'],
  repair: ['Чинит союзную технику вблизи.', 'Repairs nearby allied machines.'],
}
export const mapDescription: Record<MapId, [string, string]> = {
  FP01: ['Открытый двор и два равных пути. Начните здесь.', 'An open yard and two equal routes. Start here.'],
  FP02: ['Контролируйте обходы или постройте мост через канал.', 'Control the detours or bridge the canal.'],
  FP03: ['Выбирайте защищённый север или короткий южный путь.', 'Choose the sheltered north or the shorter south route.'],
}
const errors: Record<string, [string, string]> = {
  CREDITS: ['Не хватает кредитов.', 'Not enough credits.'],
  PHASE: ['Действие недоступно на этом этапе операции.', 'This action is unavailable in this operation phase.'],
  OWN_SIDE_ONLY: ['Строить можно только на площадках своей стороны.', 'Build only on pads on your side.'],
  PAD_TYPE: ['Этот модуль не подходит для выбранной площадки.', 'This module does not fit the selected pad.'],
  BUILDING_LIMIT: ['Лимит: пять построек, включая заказы. Отмените заказ или продайте модуль.', 'Limit: five buildings including orders. Cancel an order or sell a module.'],
  TYPE_LIMIT: ['Достигнут лимит этого типа построек.', 'You have reached the limit for this building type.'],
  NETWORK: ['Связь прервалась. Попробуйте ещё раз.', 'Connection interrupted. Please try again.'],
  FIGHTER_DEAD: ['Дождитесь возвращения бойца. Тактика остаётся доступной.', 'Wait for your fighter to respawn. Tactics remain available.'],
  RELOADING: ['Перезарядка уже идёт.', 'Reloading is already in progress.'],
  MAGAZINE_FULL: ['Магазин уже полный.', 'Your magazine is already full.'],
  PROTECTED_BASE: ['На защищённой базе инструменты недоступны. Выйдите из круга.', 'Tools are unavailable inside the protected base. Leave its circle.'],
  TOOL_COOLDOWN: ['Дождитесь восстановления инструмента.', 'Wait for your tool to recharge.'],
  TOOL_POSITION: ['Здесь инструмент не поместится или путь перекрыт.', 'The tool does not fit here or its path is blocked.'],
  BASE_ONLY: ['Оснащение меняется на своей базе или перед возрождением.', 'Change loadout at your base or before respawning.'],
  BUILDING_IN_PROGRESS: ['Начатый заказ остаётся первым. Остальные можно переставлять.', 'The active order stays first. You can reorder the others.'],
  QUEUE_EMPTY: ['В очереди нет заказов.', 'There are no queued orders.'],
  SELLING: ['Продажа уже началась. Её можно отменить.', 'The sale has started. You can cancel it.'],
  DRONE_LIMIT: ['Лимит: два боевых дрона, включая производство.', 'Limit: two combat drones, including production.'],
  ROUTE_COOLDOWN: ['Маршрут можно менять раз в три секунды.', 'Change the route at most once every three seconds.'],
  MATCH_FINISHED: ['Матч завершён. Начните следующую партию.', 'The match has ended. Start another game.'],
  MATCH_PAUSED: ['Партия сохранена. Сначала возобновите её.', 'The game is saved. Resume it first.'],
  MODAL_OPEN: ['Сначала закройте открытое окно.', 'Close the open dialog first.'],
  VIEW_ONLY: ['Вы просматриваете партию. Сначала верните управление.', 'You are viewing the match. Take control first.'],
  INVALID_ACTION: ['Команда не принята. Обновите страницу и повторите действие.', 'The command was rejected. Reload and try again.'],
  ACTION_ID_CONFLICT: ['Эта команда уже была использована с другими параметрами. Повторите действие.', 'This command ID was already used with different data. Try the action again.'],
  AUTH_REQUIRED: ['Войдите в Iva Games и откройте свою комнату.', 'Sign in to Iva Games and open your room.'],
  NO_CREDITS: ['Не хватает кредитов.', 'Not enough credits.'],
  INSUFFICIENT_CREDITS: ['Не хватает кредитов.', 'Not enough credits.'],
  PAD_OCCUPIED: ['Площадка уже занята.', 'The pad is already occupied.'],
  NO_NETWORK: ['Площадка вне сети. Сначала постройте ретранслятор.', 'Outside the network. Build a relay first.'],
  NOT_OWNER: ['Выберите собственное подразделение.', 'Select one of your own units.'],
  LIMIT: ['Достигнут лимит объектов.', 'Object limit reached.'],
  QUEUE_FULL: ['Очередь заполнена.', 'The queue is full.'],
  COOLDOWN: ['Дождитесь восстановления.', 'Wait for the cooldown.'],
  DAMAGED: ['Продажа доступна через 5 секунд без урона.', 'Selling requires 5 seconds without damage.'],
  RECENT_DAMAGE: ['Продажа доступна через 5 секунд без урона.', 'Selling requires 5 seconds without damage.'],
  UNKNOWN_TARGET: ['Цель больше не видна. Выберите другую.', 'The target is no longer visible. Select another.'],
  INVALID_TARGET: ['Здесь действие недоступно.', 'This action is unavailable here.'],
  NOT_RUNNING: ['Дождитесь начала операции.', 'Wait for the operation to begin.'],
  STALE_CONTROLLER: ['Управление находится на другом устройстве.', 'Another device has control.'],
  CAPACITY: ['Все места сервера заняты. Попробуйте позже.', 'The server is full. Please try again later.'],
  RATE_LIMITED: ['Слишком много действий. Подождите немного.', 'Too many actions. Please wait a moment.'],
  BAD_TICKET: ['Нужно заново подключиться к комнате.', 'Reconnect to the room.'],
  EXPIRED: ['Срок возвращения в эту партию истёк.', 'The time to resume this game has expired.'],
}
export function errorText(code: string, lang: Language): string {
  if (code === 'network') return text(lang, 'Площадка вне сети. Сначала продлите её ретранслятором.', 'The pad is outside the network. Extend it with a relay first.')
  const normalized = code.replace(/^forpost:/, '').replaceAll('-', '_').toUpperCase()
  return errors[normalized]?.[lang === 'ru' ? 0 : 1] ?? text(lang, 'Действие недоступно. Проверьте выбранный объект и его условия.', 'Action unavailable. Check the selected object and its requirements.')
}
export const seconds = (ticks: number): string => `${Math.max(0, Math.ceil(ticks / 30))}`
export function clock(ticks: number): string { const value = Math.max(0, Math.ceil(ticks / 30)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` }
