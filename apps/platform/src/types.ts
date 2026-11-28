import type { GameRegistration as SessionRegistration } from '@iva-games/session-kit';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Controller =
  | { kind: 'human'; playerId: string }
  | { kind: 'bot'; botProfileId: string; botVersion: string; difficulty: Difficulty };

export const AVATARS = { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟',
  fox: '🦊', cat: '🐱', owl: '🦉', robot: '🤖', astronaut: '👩‍🚀', dragon: '🐉', dice: '🎲', comet: '☄️' } as const;
export type AvatarStyle = keyof typeof AVATARS;
export type AvatarChoice = AvatarStyle | 'photo';
export interface PublicPlayer {
  playerId: string;
  handle: string;
  displayName: string;
  avatar?: AvatarChoice;
  avatarVersion?: string;
}
export interface Account extends PublicPlayer {
  email: string;
  emailVerified: boolean;
  telegramVerified?: true;
}
export interface Participant {
  participantId: string;
  playerId: string | null;
  handle: string;
  displayName: string;
  avatar?: AvatarChoice;
  avatarVersion?: string;
  seatIndex: number;
  ready: boolean;
  controller: Controller;
}
export interface StartMatchCommand {
  startCommandId: string;
  roomId: string;
  hostPlayerId?: string;
  rulesVersion: string;
  contentVersion: string;
  participants: Participant[];
  settings: Record<string, unknown>;
}
export interface GameRuntime {
  createMatch(command: StartMatchCommand, context?: { hostPlayerId: string }): Promise<{ matchId: string }>;
  viewForPlayer(matchId: string, playerId: string): Promise<unknown>;
  applyAction(matchId: string, playerId: string, command: {
    actionId: string; expectedRevision: number; payload: unknown;
  }): Promise<unknown>;
  status?(matchId: string): Promise<{ finished: boolean; outcome?: unknown }>;
  realtimeTicket?(matchId: string, playerId: string, sessionId: string, origin: string): Promise<unknown>;
  syncAdmissions?(sessionIds: string[]): Promise<unknown>;
  confirmResult?(matchId: string, resultId: string): Promise<unknown>;
}
export interface GameRegistration extends Pick<SessionRegistration, 'resolveRoomVersion'> {
  gameId: string;
  collectionId?: 'chess' | 'other';
  title: string;
  minPlayers: number;
  maxPlayers: number;
  supportsBots: boolean;
  rulesVersion: string;
  contentVersion: string;
  status: 'available' | 'unavailable' | 'planned';
  /** Validate and freeze game-owned room settings before players confirm readiness. */
  normalizeSettings?: (input: unknown) => Record<string, unknown>;
  runtime?: GameRuntime;
}
export interface Room {
  roomId: string;
  gameId: string;
  title: string;
  hostPlayerId: string;
  state: 'lobby' | 'starting' | 'playing' | 'finished' | 'cancelled';
  capacity: number;
  rulesVersion: string;
  contentVersion: string;
  revision: number;
  settings: Record<string, unknown>;
  members: Participant[];
  reservedSeats: number;
  matchId: string | null;
  outcome: unknown;
  createdAt: number;
  startStatus?: { state: 'starting' | 'queued'; code?: string; position?: number; retryAfterMs?: number };
}
export interface Invitation {
  invitationId: string;
  roomId: string;
  roomTitle: string;
  gameId: string;
  inviter: PublicPlayer;
  invitee: PublicPlayer;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  displayStatus: Invitation['status'] | 'full';
  expiresAt: number;
  reservationExpiresAt: number | null;
  reason: string | null;
  url: string;
}
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  kind: 'verification' | 'password_reset';
}
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}
export interface SessionRecord {
  sessionHash: string;
  playerId: string | null;
  csrfToken: string;
  reauthenticatedAt: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}
/** Optional server-only adapter. It never becomes an alternate source of account identity. */
export interface TelegramIntegration {
  getStatus(playerId: string): unknown;
  createAttempt(session: SessionRecord): unknown;
  getAttemptStatus(session: SessionRecord, attemptId: string): unknown;
  cancelAttempt(session: SessionRecord, attemptId: string): unknown;
  confirm(session: SessionRecord, input: { attemptId: string; proofCode: string; consent: boolean }): unknown;
  setDelivery(session: SessionRecord, enabled: boolean): unknown;
  unlink(session: SessionRecord): unknown;
  handleUpdate(secretHeader: unknown, body: unknown): unknown;
}
export class PlatformError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'PlatformError';
  }
}
