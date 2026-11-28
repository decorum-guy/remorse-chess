import { useCallback, useState } from 'react';
import { ShiftLobby, ShiftModal } from '@iva-games/shift/lobby';
import type { LobbyMember } from '@iva-games/shift/lobby';
import { ShiftOnlineMatch } from '@iva-games/shift/ui';
import { request } from './api';
import { go } from './navigation';
import { useLanguage } from './ui';
import type { Room, User, PublicPlayer, Invitation } from './types';
import type { Perform } from './Auth';
export function ShiftRoom({ room, user, friends, invitations, busy, perform, refresh }: { room: Room; user: User; friends: PublicPlayer[]; invitations: Invitation[]; busy: boolean; perform: Perform; refresh: () => Promise<void> }) {
  const { lang, t } = useLanguage(); const [invite, setInvite] = useState(false);
  const host = room.hostPlayerId === user.playerId;
  const closeInvite = useCallback(() => setInvite(false), []);
  const call = (suffix: string, body: Record<string, unknown> = {}) => { void perform(async () => { const latest = await request<{ room: Room }>(`/rooms/${room.roomId}`); await request(`/rooms/${room.roomId}${suffix}`, { ...body, expectedRevision: latest.room.revision }); await refresh(); }); };
  const remove = (member: LobbyMember) => call(member.controller.kind === 'bot' ? `/bots/${member.participantId}/remove` : '/kick', member.controller.kind === 'bot' ? {} : { participantId: member.participantId });
  return <div className="shift-portal-stage">{room.matchId && ['playing', 'finished'].includes(room.state) ? <ShiftOnlineMatch key={room.matchId} roomId={room.roomId} matchId={room.matchId} language={lang} exit={() => go('rooms')} rematch={host ? () => call('/rematch') : undefined} rematchReady={room.state === 'finished' && !busy} /> : <ShiftLobby room={room} playerId={user.playerId} language={lang} busy={busy} actions={{
    update: (settings, capacity) => call('/settings', { settings, ...(capacity ? { capacity } : {}) }), ready: () => call('/ready', { ready: !room.members.find(m => m.playerId === user.playerId)?.ready }), start: () => call('/start'),
    fillBots: difficulty => { void perform(async () => { for (let i = 0; i < 6; i++) { const latest = (await request<{ room: Room }>(`/rooms/${room.roomId}`)).room; if (latest.members.length + latest.reservedSeats >= latest.capacity) break; await request(`/rooms/${room.roomId}/bots`, { difficulty, expectedRevision: latest.revision }); } await refresh(); }); },
    remove, invite: () => setInvite(true), leave: () => { void perform(async () => { await request(`/rooms/${room.roomId}/${host ? 'cancel' : 'leave'}`, {}); go('rooms'); await refresh(); }); }, back: () => go('rooms'),
  }} />}{invite && <div className="shift-root"><Invite room={room} friends={friends} invitations={invitations} close={closeInvite} busy={busy} send={playerId => { void perform(async () => { await request(`/rooms/${room.roomId}/invitations`, { playerId }); await refresh(); }); }} text={t} /></div>}</div>;
}
// The shared invitation API retains its established in-site and opt-in delivery rules.
function Invite({ room, friends, invitations, close, busy, send, text: t }: { room: Room; friends: PublicPlayer[]; invitations: Invitation[]; close: () => void; busy: boolean; send: (id: string) => void; text: (ru: string, en: string) => string }) {
  const eligible = friends.filter(f => !room.members.some(m => m.playerId === f.playerId));
  return <ShiftModal title={t('Пригласить друзей', 'Invite friends')} close={close}><div className="shift-invite-list">{eligible.map(f => { const sent = invitations.find(i => i.roomId === room.roomId && i.invitee.playerId === f.playerId && ['pending', 'accepted'].includes(i.status)); return <div key={f.playerId}><strong>{f.displayName}</strong>{sent ? <span>{t('Приглашение отправлено', 'Invitation sent')}</span> : <button className="shift-button primary" disabled={busy} onClick={() => send(f.playerId)}>{t('Пригласить', 'Invite')}</button>}</div>; })}{!eligible.length && <p>{t('Добавьте друзей на портале, чтобы пригласить их в команду.', 'Add friends on the portal to invite them to your team.')} <a href="/friends">{t('Открыть друзей', 'Open friends')} ↗</a></p>}</div></ShiftModal>;
}
