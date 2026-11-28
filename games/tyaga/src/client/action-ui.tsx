import { useId, useState } from 'react';
import type { BotTaskKind, EntityView, InteractionView, InventoryView, TyagaAction, TyagaView, Vec3 } from '../core/types';
import type { Language } from './copy';
import { Icon } from './ui';

export function actionApplies(view: TyagaView, interaction: InteractionView, id: string) {
  const action = interaction.action;
  if (interaction.targetId === id || ('itemId' in action && action.itemId === id)) return true;
  if ('targetId' in action && action.targetId) {
    if (action.targetId === id) return true;
    const link = view.connections.find(connection => connection.id === action.targetId);
    if (link?.fromId === id) return true;
  }
  const self = view.participants.find(participant => participant.participantId === view.participantId);
  return ['release', 'rotate'].includes(action.type) && (self?.holding === id || self?.controlling === id);
}

export function inventoryOrdinal(view: TyagaView, item: InventoryView) { return view.inventory.filter(candidate => candidate.kind === item.kind).findIndex(candidate => candidate.id === item.id) + 1; }
export function unpackInteraction(view: TyagaView, item: InventoryView) {
  return view.interactions.find(interaction => { const action = interaction.action; return action.type === 'unpack' && view.inventory.find(candidate => candidate.id === action.itemId)?.kind === item.kind; });
}

const targetedActions = new Set<TyagaAction['type']>(['jack', 'repair', 'install-drive', 'remove-drive']);
const groupLabels: Record<string, [string, string]> = {
  jack: ['Поднять домкратом', 'Lift with the jack'], repair: ['Ремонтировать', 'Repair'],
  'install-drive': ['Установить привод', 'Install drive'], 'remove-drive': ['Снять привод', 'Remove drive'],
};
export function ActionButton({ interaction, lang, blocked, onAction }: { interaction: InteractionView; lang: Language; blocked?: string; onAction: (action: TyagaAction) => void }) {
  const id = useId(), reason = blocked || (!interaction.enabled ? interaction.reason?.[lang] || (lang === 'ru' ? 'Действие сейчас недоступно' : 'This action is unavailable right now') : '');
  return <div className="ty-action-option"><button className="ty-button secondary" disabled={!!reason} aria-describedby={reason ? id : undefined} onClick={() => onAction(interaction.action)}>{interaction.label[lang]}</button>{reason && <small id={id}>{reason}</small>}</div>;
}
function TargetAction({ type, choices, view, lang, blocked, onAction }: { type: string; choices: InteractionView[]; view: TyagaView; lang: Language; blocked?: string; onAction: (action: TyagaAction) => void }) {
  const id = useId(), [choiceId, setChoiceId] = useState('');
  const chosen = choices.find(choice => choice.id === choiceId) ?? choices.find(choice => choice.enabled) ?? choices[0];
  const reason = blocked || (!chosen.enabled ? chosen.reason?.[lang] || (lang === 'ru' ? 'Подготовьте предметы' : 'Prepare the objects') : '');
  const action = chosen.action, item = 'itemId' in action ? view.inventory.find(candidate => candidate.id === action.itemId) : undefined;
  return <div className="ty-target-action">
    <label htmlFor={id}>{groupLabels[type]?.[lang === 'ru' ? 0 : 1] ?? chosen.label[lang]}</label>
    <select id={id} value={chosen.id} onChange={event => setChoiceId(event.target.value)}>{choices.map(choice => <option value={choice.id} key={choice.id}>{choice.label[lang]}{!choice.enabled ? lang === 'ru' ? ' — недоступно' : ' — unavailable' : ''}</option>)}</select>
    {item && type === 'repair' && <small>{lang === 'ru' ? 'Ремонтный заряд' : 'Repair charge'} №{inventoryOrdinal(view, item)} · {item.state === 'stored' ? lang === 'ru' ? 'в ящике' : 'in the locker' : lang === 'ru' ? 'рядом' : 'nearby'}</small>}
    <button className="ty-button secondary" disabled={!!reason} aria-describedby={reason ? `${id}-reason` : undefined} onClick={() => onAction(action)}>{groupLabels[type]?.[lang === 'ru' ? 0 : 1] ?? chosen.label[lang]}<Icon name="tool" size={18}/></button>
    {reason && <small id={`${id}-reason`}>{reason}</small>}
  </div>;
}
export function ObjectActions({ view, selected, lang, blocked, onAction }: { view: TyagaView; selected: EntityView; lang: Language; blocked?: string; onAction: (action: TyagaAction) => void }) {
  const choices = view.interactions.filter(interaction => actionApplies(view, interaction, selected.id));
  const ordinary = choices.filter(choice => !targetedActions.has(choice.action.type));
  const groups = [...new Set(choices.filter(choice => targetedActions.has(choice.action.type)).map(choice => choice.action.type))];
  return <>
    {ordinary.map(interaction => <ActionButton key={interaction.id} interaction={interaction} lang={lang} blocked={blocked} onAction={onAction}/>)}
    {groups.map(type => <TargetAction key={`${selected.id}:${type}`} type={type} choices={choices.filter(choice => choice.action.type === type)} view={view} lang={lang} blocked={blocked} onAction={onAction}/>)}
    {!choices.length && <p className="ty-note">{lang === 'ru' ? 'Подойдите к ручке или пульту выбранного предмета.' : 'Move closer to a handle or control on the selected object.'}</p>}
  </>;
}

export function EquipmentList({ view, lang, blocked, onUnpack, onSelect }: { view: TyagaView; lang: Language; blocked?: string; onUnpack: (item: InventoryView) => void; onSelect: (id: string, attachments?: boolean) => void }) {
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  const freeStraps = view.inventory.filter(item => item.kind === 'strap' && ['stored', 'world'].includes(item.state)).length;
  const charges = view.inventory.filter(item => item.kind === 'repair' && ['stored', 'world'].includes(item.state)).length;
  return <><p className="ty-equipment-counts">{t('Свободных ремней', 'Free straps')}: <strong>{freeStraps}</strong> · {t('Ремонтных зарядов', 'Repair charges')}: <strong>{charges}</strong></p><div className="ty-inventory">
    {view.inventory.filter(item => item.state !== 'destroyed').map(item => {
      const unpack = item.state === 'stored' ? unpackInteraction(view, item) : undefined;
      const reason = item.state === 'stored' ? blocked || (!unpack ? t('Подойдите к ящику под кузовом', 'Move beside the locker under the truck') : !unpack.enabled ? unpack.reason?.[lang] || t('Распаковка недоступна', 'Cannot unpack right now') : '') : '';
      const link = item.state === 'attached' ? view.connections.find(connection => !connection.broken && (connection.itemId === item.id || connection.toId === item.id)) : undefined;
      const body = view.entities.find(entity => entity.active && entity.id === (item.bodyId ?? item.id));
      const target = body?.id ?? link?.fromId;
      return <div className="ty-inventory-item" key={item.id}><Icon name={item.kind === 'strap' ? 'link' : item.kind === 'winch' ? 'rope' : item.kind === 'deck' ? 'map' : item.kind === 'beam' ? 'minus' : 'tool'}/><div><strong>{item.name[lang]} <span className="ty-item-number">№{inventoryOrdinal(view, item)}</span></strong><small>{item.mass} {t('кг', 'kg')} · {item.state === 'stored' ? t('В ящике', 'Stored') : item.state === 'attached' ? t('Закреплён', 'Attached') : t('На местности', 'In the world')}</small>{reason && <small className="ty-action-reason">{reason}</small>}</div>
        {item.state === 'stored' ? <button className="ty-button secondary small" disabled={!!reason} onClick={() => onUnpack(item)}>{t('Достать', 'Unpack')}</button> : <button className="ty-icon-button" disabled={!target} title={!target ? t('Связь обновляется', 'Updating the attachment') : undefined} aria-label={item.state === 'attached' ? t('Показать установленную связь', 'Show installed connection') : t('Выбрать предмет', 'Select item')} onClick={() => { if (target) onSelect(target, item.state === 'attached'); }}><Icon name={item.state === 'attached' ? 'link' : 'arrow'}/></button>}
      </div>;
    })}
  </div></>;
}

const botStatuses: Record<string, [string, string]> = {
  accepted: ['Поручение принято', 'Order accepted'], following: ['Следует за командой', 'Following the crew'], working: ['Выполняет поручение', 'Working on the order'], holding: ['Удерживает предмет', 'Holding the object'],
  TOO_FAR: ['Нужно подойти ближе', 'Needs to get closer'], BLOCKED: ['Путь или доступ закрыт', 'The path or reach is blocked'], BUSY: ['Предмет уже занят', 'The object is occupied'], HANDS_BUSY: ['Сначала нужно отпустить предмет', 'Needs to release the held object'],
  NO_SUPPORT: ['Нет устойчивой опоры', 'No stable support'], NO_SPACE: ['Недостаточно свободного места', 'Not enough clear space'], MOVING: ['Нужно остановиться', 'Needs to stop'], ALIGN: ['Нужно совместить крепления', 'The attachments need alignment'],
  HANDLE_BUSY: ['Ручка занята', 'The handle is occupied'], MAX_HANDS: ['За груз уже держатся двое', 'Two people already hold the load'], NO_ITEM: ['Нет нужного инструмента', 'The required tool is missing'], NOT_FOUND: ['Предмет больше недоступен', 'The object is no longer available'],
  ATTACHED: ['Сначала нужно снять крепления', 'Attachments must be removed first'], TOO_LONG: ['Точка крепления слишком далеко', 'The attachment point is too far'], INVALID_ACTION: ['Выберите другое поручение или цель', 'Choose another order or target'],
  BARRIER: ['Барьер открыт', 'A barrier is open'], NO_DRIVE: ['Привод ещё не установлен', 'The drive is not installed'], FERRY_LOCKS: ['Замки парома не закрыты', 'The ferry locks are not closed'], ROPE_BUSY: ['Лебёдка занята', 'The winch is occupied'],
};
export function botStatusText(status: string | undefined, lang: Language) { const text = status ? botStatuses[status] : undefined; return text ? text[lang === 'ru' ? 0 : 1] : lang === 'ru' ? 'Ожидает нового поручения' : 'Waiting for a new order'; }

const taskLabels: Record<BotTaskKind, [string, string]> = { follow: ['Следуй за машиной', 'Follow the truck'], carry: ['Помоги нести', 'Help me carry'], hold: ['Держи здесь', 'Hold here'], winch: ['Работай лебёдкой', 'Operate the winch'], secure: ['Подготовь крепления', 'Secure the cargo'], drive: ['Веди к метке', 'Drive to the marker'] };
export function CrewOrders({ view, selectedId, mark, lang, blocked, onAction }: { view: TyagaView; selectedId: string | null; mark: Vec3 | null; lang: Language; blocked?: string; onAction: (action: TyagaAction) => void }) {
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  const self = view.participants.find(person => person.participantId === view.participantId);
  const held = view.entities.find(entity => entity.active && entity.id === self?.holding);
  const selected = view.entities.find(entity => entity.active && entity.id === selectedId);
  const carryTarget = held ?? selected;
  const rope = view.connections.find(link => link.kind === 'rope' && !link.broken && !link.detached && (link.fromId === selected?.id || link.id === self?.controlling));
  const freeStraps = view.inventory.some(item => item.kind === 'strap' && ['stored', 'world'].includes(item.state));
  return <><p className="ty-note">{t('Бот помогает нести груз в ваших руках или выбранный предмет. Для водителя поставьте метку на карте; для лебёдки выберите её установленный трос.', 'A bot can carry the object in your hands or the selected object. Set a map marker for the driver; select a connected winch to operate its cable.')}</p>
    {carryTarget && <p className="ty-order-target">{t('Предмет для переноски', 'Carry target')}: <strong>{carryTarget.name[lang]}</strong></p>}
    {view.participants.map(person => <section className="ty-bot-card" key={person.participantId}>
      <div className="ty-object-heading"><span className={'ty-person seat-' + person.seatIndex}><Icon name="crew"/></span><div><strong>{person.displayName} {person.controller === 'bot' && <small>· {t('Бот', 'Bot')}</small>}</strong><small>{person.task ? botStatusText(person.task.status, lang) : person.connected ? t('В экспедиции', 'On the expedition') : t('Ожидает связи', 'Waiting for connection')}</small></div></div>
      {person.task && <p className="ty-bot-task">{t('Поручение', 'Order')}: <strong>{taskLabels[person.task.kind][lang === 'ru' ? 0 : 1]}</strong>{person.task.targetId && <> · {view.entities.find(entity => entity.id === person.task?.targetId)?.name[lang] ?? (view.connections.some(link => link.id === person.task?.targetId) ? t('Трос лебёдки', 'Winch cable') : t('Предмет недоступен', 'Object unavailable'))}</>}</p>}
      {person.controller === 'bot' && <div className="ty-bot-orders">{(Object.keys(taskLabels) as BotTaskKind[]).map(task => {
        const hands = carryTarget?.sockets.filter(socket => socket.role === 'handle') ?? [];
        const busyHands = hands.filter(socket => !!socket.occupiedBy && socket.occupiedBy !== person.participantId).length;
        const reason = blocked || (task === 'drive' && !mark ? t('Сначала поставьте метку на карте', 'Set a map marker first') : ['carry', 'hold'].includes(task) && !carryTarget ? t('Возьмите или выберите предмет', 'Hold or select an object') : ['carry', 'hold'].includes(task) && !hands.length ? t('У этого предмета нет ручек', 'This object has no carrying handles') : ['carry', 'hold'].includes(task) && (busyHands >= 2 || !hands.some(socket => !socket.occupiedBy || socket.occupiedBy === person.participantId)) ? t('Все доступные ручки заняты', 'The available handles are occupied') : task === 'winch' && !rope ? t('Выберите лебёдку с закреплённым тросом', 'Select a winch with a connected cable') : task === 'secure' && !freeStraps ? t('Нет свободного стяжного ремня', 'No free cargo strap') : '');
        const targetId = task === 'winch' ? rope?.id : ['carry', 'hold'].includes(task) ? carryTarget?.id : undefined;
        const active = person.task?.kind === task && (!targetId || person.task.targetId === targetId);
        return <div className="ty-bot-order" key={task}><button className={'ty-button secondary small ' + (active ? 'selected' : '')} disabled={!!reason} aria-pressed={active} aria-describedby={reason ? `order-${person.seatIndex}-${task}` : undefined} onClick={() => onAction({ type: 'bot-order', participantId: person.participantId, task, ...(targetId ? { targetId } : {}), ...(task === 'drive' && mark ? { point: mark } : {}) })}>{taskLabels[task][lang === 'ru' ? 0 : 1]}</button>{reason && <small id={`order-${person.seatIndex}-${task}`}>{reason}</small>}</div>;
      })}</div>}
    </section>)}
  </>;
}
