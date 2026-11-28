import { useEffect, useRef, useState } from 'react';
import type { ConnectionView, EntityView, SocketView, TyagaAction, TyagaView, Vec3 } from '../core/types';
import { PHYSICS } from '../core/config';
import type { Language } from './copy';
import { Dialog, Icon } from './ui';
import { ActionButton, inventoryOrdinal } from './action-ui';

type Kind = 'strap' | 'rope' | 'deck' | 'ferry-lock';
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function sourceAllowed(kind: Kind, object: EntityView, socket: SocketView) {
  if (kind === 'rope') return object.kind === 'truck' && socket.id === 'front-winch' || object.kind === 'winch' && socket.id === 'drum';
  if (kind === 'ferry-lock') return object.kind === 'ferry-deck' && socket.role === 'lock';
  return socket.role === 'ring' && (kind !== 'deck' || object.kind === 'deck');
}
function targetAllowed(kind: Kind, object: EntityView, socket: SocketView) {
  if (kind === 'rope') return ['ring', 'lock', 'handle'].includes(socket.role);
  if (kind === 'ferry-lock') return object.kind === 'pontoon' && socket.role === 'lock';
  return socket.role === 'ring' && (kind !== 'deck' || object.kind === 'ring' || object.kind === 'anchor' && object.state === 'anchored');
}

export function AttachmentPanel({ view, selected, lang, blocked, onAction, onClose }: { view: TyagaView; selected?: EntityView; lang: Language; blocked?: string; onAction: (action: TyagaAction) => Promise<boolean>; onClose: () => void }) {
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  const person = view.participants.find(participant => participant.participantId === view.participantId);
  const actor = view.entities.find(entity => entity.id === person?.entityId);
  const chest = actor ? { x: actor.position.x, y: actor.position.y + .25, z: actor.position.z } : { x: 0, y: 0, z: 0 };
  const nearby = view.entities.filter(entity => entity.active && entity.sockets.length && entity.kind !== 'character' && !!actor && Math.hypot(entity.position.x - actor.position.x, entity.position.z - actor.position.z) < 20);
  const [fromId, setFromId] = useState(selected?.id ?? nearby[0]?.id ?? ''), [toId, setToId] = useState('');
  const [fromSocket, setFromSocket] = useState(''), [toSocket, setToSocket] = useState(''), [kind, setKind] = useState<Kind>(selected?.kind === 'hook' && view.connections.some(link => link.kind === 'rope' && link.hookId === selected.id) ? 'rope' : 'strap'), [strapId, setStrapId] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null), [holding, setHolding] = useState(false), holdTimer = useRef(0), holdSource = useRef<number | 'key' | null>(null);
  const latest = useRef({ onAction, confirm, blocked }); latest.current = { onAction, confirm, blocked };
  const from = nearby.find(entity => entity.id === fromId);
  const sourceSockets = from?.sockets.slice().sort((a, b) => distance(a.world, chest) - distance(b.world, chest)) ?? [];
  const fromS = sourceSockets.find(socket => socket.id === fromSocket) ?? sourceSockets.find(socket => !!from && sourceAllowed(kind, from, socket)) ?? sourceSockets[0];
  // A selected free hook is the end of its existing cable. The wire action still
  // identifies the original drum; carrying the hook never creates a second rope.
  const hookLink = from?.kind === 'hook' ? view.connections.find(link => link.kind === 'rope' && link.hookId === from.id) : undefined;
  const attachmentFrom = kind === 'rope' && hookLink ? view.entities.find(entity => entity.id === hookLink.fromId && entity.active) : from;
  const attachmentSocket = kind === 'rope' && hookLink ? attachmentFrom?.sockets.find(socket => socket.id === hookLink.fromSocket) : fromS;
  const existingRope = kind === 'rope' ? view.connections.find(link => link.kind === 'rope' && link.fromId === attachmentFrom?.id) : undefined;
  const hook = existingRope?.hookId ? view.entities.find(entity => entity.id === existingRope.hookId && entity.active) : undefined;
  const detachedRope = !!existingRope?.detached;
  const reachPoint = detachedRope ? hook?.sockets.find(socket => socket.id === 'handle-0')?.world ?? hook?.position : attachmentSocket?.world;
  const targetObjects = nearby.filter(entity => entity.id !== from?.id && entity.id !== attachmentFrom?.id && entity.id !== hook?.id && entity.sockets.some(socket => targetAllowed(kind, entity, socket)));
  const to = targetObjects.find(entity => entity.id === toId) ?? targetObjects[0];
  const targetSockets = to?.sockets.filter(socket => targetAllowed(kind, to, socket)).sort((a, b) => distance(a.world, reachPoint ?? chest) - distance(b.world, reachPoint ?? chest)) ?? [];
  const toS = targetSockets.find(socket => socket.id === toSocket) ?? targetSockets[0];
  const locker = view.entities.find(entity => entity.kind === 'crate' && entity.active);
  const nearEntity = (entity?: EntityView) => !!entity && (entity.sockets.length ? Math.min(...entity.sockets.map(socket => distance(socket.world, chest))) : distance(entity.position, chest)) <= PHYSICS.interact;
  const straps = view.inventory.filter(item => item.kind === 'strap' && ['stored', 'world'].includes(item.state));
  const strapReach = (id: string) => { const item = straps.find(candidate => candidate.id === id); return item && (item.state === 'stored' ? nearEntity(locker) : nearEntity(view.entities.find(entity => entity.id === (item.bodyId ?? item.id)))); };
  const strap = straps.find(item => item.id === strapId) ?? straps.find(item => strapReach(item.id)) ?? straps[0];
  const related = view.connections.filter(link => (link.kind === 'rope' || !link.broken) && (link.fromId === fromId || link.toId === fromId || link.hookId === fromId));
  const operate = view.interactions.filter(interaction => interaction.action.type === 'operate' && (interaction.targetId === fromId || view.connections.some(link => interaction.action.type === 'operate' && interaction.action.targetId === link.id && link.fromId === fromId)));
  const handle = sourceSockets.find(socket => socket.id === fromSocket && socket.role === 'handle') ?? sourceSockets.find(socket => socket.role === 'handle' && !socket.occupiedBy) ?? sourceSockets.find(socket => socket.role === 'handle');
  const knownGrab = view.interactions.find(interaction => interaction.action.type === 'grab' && interaction.action.itemId === fromId && interaction.action.handleId === handle?.id);
  const grabReason = blocked || (from?.state === 'anchored' || ['truck', 'ring', 'lift', 'barrier'].includes(from?.kind ?? '') ? t('Закреплённый предмет нельзя переносить', 'This fixed object cannot be carried') : person?.holding ? t('Сначала отпустите предмет', 'Release the held object first') : person?.controlling ? t('Сначала отпустите управление', 'Release the controls first') : !handle ? t('У предмета нет свободной ручки', 'This object has no carrying handle') : handle.occupiedBy ? t('Эту ручку уже держат', 'This handle is occupied') : distance(handle.world, chest) > PHYSICS.interact ? t('Подойдите к выбранной ручке', 'Move closer to the selected handle') : knownGrab && !knownGrab.enabled ? knownGrab.reason?.[lang] || t('Нельзя взять предмет', 'Cannot grab this object') : '');
  const gap = attachmentSocket && toS ? distance(attachmentSocket.world, toS.world) : null;
  const hookGap = detachedRope && hook && toS ? distance(hook.position, toS.world) : null;
  const socketOccupied = attachmentSocket && toS && view.connections.some(link => !link.broken && !link.detached && (link.fromId === attachmentFrom?.id && link.fromSocket === attachmentSocket.id || link.toId === to?.id && link.toSocket === toS.id));
  const operation = view.operations.find(item => item.participantId === view.participantId);
  const attachReason = blocked || (operation ? t('Сначала закончите текущую работу', 'Finish the current operation') : !from || !attachmentFrom || !to || !attachmentSocket || !toS ? t('Выберите два предмета с подходящими точками', 'Choose two objects with suitable attachment points') : !sourceAllowed(kind, attachmentFrom, attachmentSocket) ? kind === 'rope' ? t('Начните с лебёдки или выберите её свободный крюк', 'Start at a winch or select its free hook') : kind === 'ferry-lock' ? t('Выберите замок на палубе парома', 'Select a ferry deck lock') : kind === 'deck' ? t('Начните с проушины разложенного настила', 'Start at a ring on an unfolded deck') : t('Ремень соединяет две проушины', 'Straps connect two rings') : existingRope?.broken ? t('Сначала восстановите оборванный трос', 'Repair the broken cable first') : existingRope && !detachedRope ? t('У этой лебёдки уже закреплён трос', 'This winch already has a connected cable') : !reachPoint || distance(reachPoint, chest) > PHYSICS.interact ? detachedRope ? t('Подойдите к свободному крюку', 'Move closer to the free hook') : t('Подойдите к первой выбранной точке', 'Move closer to the first attachment point') : detachedRope && distance(toS.world, chest) > PHYSICS.interact ? t('Подойдите с крюком к выбранной проушине', 'Move with the hook closer to the selected attachment') : kind === 'strap' && !strap ? t('Свободных ремней нет', 'No free cargo straps') : kind === 'strap' && !strapReach(strap!.id) ? t('Подойдите к выбранному ремню или ящику', 'Move beside the selected strap or equipment locker') : hookGap !== null && hookGap > .3 ? t('Совместите свободный крюк с креплением: не дальше 0,3 м', 'Bring the free hook within 0.3 m of the attachment') : kind === 'deck' && from.state === 'folded' ? t('Сначала разложите настил', 'Unfold the deck first') : (kind === 'deck' || kind === 'ferry-lock') && socketOccupied ? t('Одно из креплений уже занято', 'One of these sockets is already occupied') : gap !== null && (gap > (kind === 'rope' ? 18 : kind === 'strap' ? 2 : .3) || kind === 'rope' && !existingRope && gap < 1.5) ? kind === 'rope' ? detachedRope ? t('Крепление должно быть не дальше 18 м от лебёдки', 'The attachment must be within 18 m of the winch') : t('Длина троса должна быть от 1,5 до 18 м', 'Cable length must be between 1.5 and 18 m') : kind === 'strap' ? t('Сблизьте проушины до 2 м', 'Bring the rings within 2 m') : t('Совместите крепления: не дальше 0,3 м', 'Align the sockets within 0.3 m') : '');
  function objectName(object: EntityView) { const item = view.inventory.find(item => item.id === object.id); return object.name[lang] + (item ? ` №${inventoryOrdinal(view, item)}` : ''); }
  function socketName(socket: SocketView, object: EntityView) {
    if (socket.id === 'front-winch' || socket.id === 'drum') return t('Лебёдка', 'Winch');
    if (socket.id === 'rear-brake') return t('Аварийный тормоз', 'Emergency brake');
    const role = { handle: t('Ручка', 'Handle'), ring: t('Проушина', 'Ring'), cab: t('Кабина', 'Cab'), crate: t('Ящик', 'Locker'), control: t('Пульт', 'Controls'), lock: t('Замок', 'Lock'), drive: t('Привод', 'Drive') }[socket.role];
    return `${role} ${object.sockets.filter(item => item.role === socket.role).findIndex(item => item.id === socket.id) + 1}`;
  }
  function endpointName(id: string, socketId: string) {
    const object = view.entities.find(entity => entity.id === id);
    const socket = object?.sockets.find(candidate => candidate.id === socketId);
    return object ? `${objectName(object)}${socket ? ` · ${socketName(socket, object)}` : ''}` : t('Недоступная точка', 'Unavailable attachment');
  }
  function connectionName(link: ConnectionView) {
    const label = link.kind === 'rope' ? t('Трос', 'Cable') : link.kind === 'strap' ? t('Ремень', 'Strap') : link.fromSocket === 'drive' ? t('Привод', 'Drive') : t('Крепление', 'Attachment');
    const item = link.itemId ? view.inventory.find(candidate => candidate.id === link.itemId) : undefined;
    return label + (item ? ` №${inventoryOrdinal(view, item)}` : '');
  }
  function stopHold() { clearTimeout(holdTimer.current); holdTimer.current = 0; holdSource.current = null; setHolding(false); }
  function cancelConfirm() { stopHold(); setConfirm(null); }
  function beginHold(source: number | 'key') {
    if (holdTimer.current || latest.current.blocked || !latest.current.confirm) return;
    holdSource.current = source; setHolding(true); const id = latest.current.confirm;
    holdTimer.current = window.setTimeout(() => { holdTimer.current = 0; holdSource.current = null; setHolding(false); if (latest.current.confirm !== id || latest.current.blocked) return; setConfirm(null); void latest.current.onAction({ type: 'detach', connectionId: id, confirm: true }); }, 1000);
  }
  useEffect(() => { stopHold(); }, [confirm, blocked, fromId, kind]);
  useEffect(() => { const hidden = () => { if (document.hidden) stopHold(); }; window.addEventListener('blur', stopHold); window.addEventListener('orientationchange', stopHold); document.addEventListener('visibilitychange', hidden); return () => { clearTimeout(holdTimer.current); window.removeEventListener('blur', stopHold); window.removeEventListener('orientationchange', stopHold); document.removeEventListener('visibilitychange', hidden); }; }, []);
  function linkReason(link: ConnectionView) { const a = view.entities.find(entity => entity.id === link.fromId)?.sockets.find(socket => socket.id === link.fromSocket); const b = view.entities.find(entity => entity.id === link.toId)?.sockets.find(socket => socket.id === link.toSocket); return blocked || (operation ? t('Сначала закончите текущую работу', 'Finish the current operation') : !(a && distance(a.world, chest) <= PHYSICS.interact || b && distance(b.world, chest) <= PHYSICS.interact) ? t('Подойдите к любому концу связи', 'Move closer to either end of the connection') : ''); }
  return <Dialog title={t('Ручки и крепления', 'Handles and attachments')} onClose={() => { cancelConfirm(); onClose(); }}>
    <div className="ty-field"><label htmlFor="attach-from">{t('Первый предмет', 'First object')}</label><select id="attach-from" value={from?.id ?? ''} onChange={event => { cancelConfirm(); setFromId(event.target.value); setFromSocket(''); setToSocket(''); if (view.connections.some(link => link.kind === 'rope' && link.hookId === event.target.value)) setKind('rope'); }}>{!nearby.length && <option value="">{t('Подойдите к предметам', 'Move closer to the objects')}</option>}{nearby.map(entity => <option key={entity.id} value={entity.id}>{objectName(entity)}</option>)}</select></div>
    {from && <div className="ty-socket-list">{from.sockets.map(socket => <button key={socket.id} className={'ty-button secondary small ' + (fromS?.id === socket.id ? 'selected' : '')} aria-pressed={fromS?.id === socket.id} onClick={() => { cancelConfirm(); setFromSocket(socket.id); }}>{socketName(socket, from)}{socket.occupiedBy && ` · ${t('занято', 'occupied')}`}</button>)}</div>}
    {from && <div className="ty-attachment-object-actions"><div className="ty-action-option"><button className="ty-button secondary" disabled={!!grabReason} aria-describedby={grabReason ? 'attach-grab-reason' : undefined} onClick={() => { if (handle) void onAction({ type: 'grab', itemId: fromId, handleId: handle.id }).then(ok => { if (ok) onClose(); }); }}><Icon name="hand"/>{t('Взять за ручку', 'Grab handle')}</button>{grabReason && <small id="attach-grab-reason">{grabReason}</small>}</div>{operate.map(interaction => <ActionButton interaction={interaction} key={interaction.id} lang={lang} blocked={blocked} onAction={action => { void onAction(action).then(ok => { if (ok) onClose(); }); }}/>)}</div>}
    <div className="ty-field"><label htmlFor="attach-kind">{t('Соединение', 'Connection')}</label><select id="attach-kind" value={kind} onChange={event => { const next = event.target.value as Kind; cancelConfirm(); setKind(next); setFromSocket(''); setToSocket(''); setToId(''); if (!(next === 'rope' && hookLink) && !from?.sockets.some(socket => sourceAllowed(next, from, socket))) setFromId(nearby.find(entity => entity.sockets.some(socket => sourceAllowed(next, entity, socket)))?.id ?? fromId); }}><option value="strap">{t('Стяжной ремень', 'Cargo strap')}</option><option value="rope">{t('Трос лебёдки', 'Winch cable')}</option><option value="deck">{t('Крепление настила', 'Deck anchor')}</option><option value="ferry-lock">{t('Замок парома', 'Ferry lock')}</option></select></div>
    {detachedRope && attachmentFrom && <p className="ty-note">{t('Свободный конец троса: ', 'Free cable end: ')}{objectName(attachmentFrom)}. {t('Поднесите крюк к новой проушине. Возвращаться к барабану не нужно.', 'Carry the hook to a new attachment point. You can reconnect it from here.')}</p>}
    {kind === 'strap' && <div className="ty-field"><label htmlFor="attach-strap">{t('Ремень из оборудования', 'Equipment strap')}</label><select id="attach-strap" value={strap?.id ?? ''} onChange={event => setStrapId(event.target.value)}>{!straps.length && <option value="">{t('Нет свободных ремней', 'No free straps')}</option>}{straps.map(item => <option key={item.id} value={item.id}>{item.name[lang]} №{inventoryOrdinal(view, item)} · {item.state === 'stored' ? t('в ящике', 'stored') : t('на местности', 'in the world')}</option>)}</select></div>}
    <div className="ty-field"><label htmlFor="attach-to">{t('К чему прикрепить', 'Attach to')}</label><select id="attach-to" value={to?.id ?? ''} onChange={event => { cancelConfirm(); setToId(event.target.value); setToSocket(''); }}>{!targetObjects.length && <option value="">{t('Рядом нет подходящего предмета', 'No suitable object nearby')}</option>}{targetObjects.map(entity => <option key={entity.id} value={entity.id}>{objectName(entity)}</option>)}</select></div>
    {to && <div className="ty-socket-list">{targetSockets.map(socket => <button key={socket.id} className={'ty-button secondary small ' + (toS?.id === socket.id ? 'selected' : '')} aria-pressed={toS?.id === socket.id} onClick={() => { cancelConfirm(); setToSocket(socket.id); }}>{socketName(socket, to)}</button>)}</div>}
    {gap !== null && <p className="ty-attachment-distance">{detachedRope ? t('От лебёдки до крепления', 'Winch to attachment') : t('Между креплениями', 'Between attachment points')}: <strong>{gap.toFixed(2)} {t('м', 'm')}</strong></p>}
    {hookGap !== null && <p className="ty-attachment-distance">{t('От крюка до крепления', 'Hook to attachment')}: <strong>{hookGap.toFixed(2)} {t('м', 'm')}</strong> / 0.30 {t('м', 'm')}</p>}
    <button className="ty-button primary wide" disabled={!!attachReason} aria-describedby={attachReason ? 'attach-reason' : undefined} onClick={() => { if (attachmentFrom && to && attachmentSocket && toS) void onAction({ type: 'attach', fromId: attachmentFrom.id, fromSocket: attachmentSocket.id, toId: to.id, toSocket: toS.id, kind, ...(kind === 'strap' && strap ? { itemId: strap.id } : {}) }); }}><Icon name="link"/>{detachedRope ? t('Закрепить свободный крюк', 'Attach free hook') : t('Закрепить', 'Attach')}</button>
    {operation && <div className="ty-operation"><span>{t('Выполняется…', 'Working…')}</span><progress max="1" value={operation.progress}/><button className="ty-button subtle" disabled={!!blocked} onClick={() => void onAction({ type: 'cancel' })}>{t('Отмена', 'Cancel')}</button></div>}
    {attachReason && <p id="attach-reason" className="ty-action-reason">{attachReason}</p>}<p className="ty-note">{detachedRope ? t('Существующий трос сохраняет своё положение и огибает препятствия. При креплении проверяются доступность крюка и выбранной точки.', 'The existing cable keeps its position around obstacles. The hook and attachment point must both be within reach.') : t('Препятствия и опора проверяются при установке. Трос и ремень должны проходить свободно.', 'Obstacles and support are checked during installation. The cable or strap needs a clear path.')}</p>
    {related.length > 0 && <><h3>{t('Связи предмета', 'Object connections')}</h3>{related.map(link => {
      const removeDrive = link.fromSocket === 'drive' ? view.interactions.find(interaction => interaction.action.type === 'remove-drive' && interaction.action.targetId === link.fromId) : undefined;
      const repair = link.broken ? view.interactions.find(interaction => interaction.action.type === 'repair' && interaction.action.targetId === link.id) : undefined;
      const reason = linkReason(link);
      return <div className="ty-connection-row" key={link.id}><div><strong>{connectionName(link)}</strong><span>{endpointName(link.fromId, link.fromSocket)} → {link.detached ? t('Свободный крюк', 'Free hook') : endpointName(link.toId, link.toSocket)}</span><span>{link.broken ? t('Разрыв троса: верните конец к лебёдке для ремонта', 'Broken cable: return the end to the winch for repair') : link.detached ? t('Можно перенести к другой проушине', 'Can be carried to another attachment') : `${Math.round(link.tension)} / ${link.limit} ${t('Н', 'N')}`}</span>{!link.broken && !link.detached && <meter min="0" max={link.limit} value={link.tension}/>}</div>
        {repair ? <ActionButton interaction={repair} lang={lang} blocked={blocked} onAction={action => void onAction(action)}/> : removeDrive ? <ActionButton interaction={removeDrive} lang={lang} blocked={blocked} onAction={action => void onAction(action)}/> : !link.broken && !link.detached && link.fromSocket !== 'drive' ? <div className="ty-action-option"><button className="ty-button secondary small" disabled={!!reason} onClick={() => { stopHold(); if (link.kind === 'rope' && link.tension > 1500) setConfirm(link.id); else void onAction({ type: 'detach', connectionId: link.id }); }}>{t('Снять', 'Remove')}</button>{reason && <small>{reason}</small>}</div> : null}
      </div>;
    })}</>}
    {confirm && <div className="ty-alert"><p>{t('Трос нагружен. После снятия груз может сдвинуться. Удерживайте кнопку 1 секунду.', 'The cable is under tension. Cargo may move. Hold for one second.')}</p><button className={'ty-button danger ' + (holding ? 'holding' : '')} disabled={!!blocked} onPointerDown={event => { if (holdSource.current !== null) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); beginHold(event.pointerId); }} onPointerUp={event => { if (holdSource.current === event.pointerId) stopHold(); }} onPointerCancel={stopHold} onLostPointerCapture={stopHold} onBlur={stopHold} onKeyDown={event => { if (['Space', 'Enter'].includes(event.code)) { event.preventDefault(); if (!event.repeat) beginHold('key'); } }} onKeyUp={event => { if (['Space', 'Enter'].includes(event.code)) { event.preventDefault(); stopHold(); } }}>{t('Удерживать, чтобы снять', 'Hold to remove')}</button><button className="ty-text-button" onClick={cancelConfirm}>{t('Отмена', 'Cancel')}</button></div>}
  </Dialog>;
}
