export type BotDifficulty = 'easy' | 'normal' | 'hard';

/** A seat survives reconnections. A bot is not a synthetic website account. */
export interface Participant {
  participantId: string;
  playerId: string | null;
  displayName: string;
  seatIndex: number;
  controller:
    | { kind: 'human'; playerId: string }
    | { kind: 'bot'; botProfileId: string; botVersion: string; difficulty: BotDifficulty };
}

export interface StartMatchRequest {
  startCommandId: string;
  roomId: string;
  /** Frozen by the authenticated platform, never taken from a browser body. */
  hostPlayerId?: string;
  rulesVersion: string;
  contentVersion: string;
  participants: Participant[];
  settings: Record<string, unknown>;
}

export interface ActionEnvelope {
  actionId: string;
  expectedRevision: number;
  payload: unknown;
}
export interface StartMatchContext { hostPlayerId: string }

/** The platform authenticates accounts; the runtime rechecks the frozen roster. */
export interface GameRuntime {
  createMatch(input: StartMatchRequest, context?: StartMatchContext): Promise<{ matchId: string }>;
  viewForPlayer(matchId: string, playerId: string): Promise<unknown>;
  applyAction(matchId: string, playerId: string, command: ActionEnvelope): Promise<unknown>;
  status(matchId: string): Promise<{ finished: boolean; outcome?: unknown }>;
  /** Optional standalone realtime capability; ordinary HTTP games retain their contract. */
  realtimeTicket?(matchId: string, playerId: string, sessionId: string, origin: string): Promise<unknown>;
  syncAdmissions?(sessionIds: string[]): Promise<unknown>;
  confirmResult?(matchId: string, resultId: string): Promise<unknown>;
}

export interface GameRegistration {
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
  /** Resolve settings and bot policy against a persisted room's version pair. */
  resolveRoomVersion?: (rulesVersion: string, contentVersion: string) => {
    normalizeSettings: (input: unknown) => Record<string, unknown>;
    botVersion: string;
  } | undefined;
  runtime?: GameRuntime;
}

export class SessionError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'SessionError';
  }
}

/** JSON request fingerprints must not depend on object-key insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new SessionError('INVALID_JSON', 'Некорректные данные команды.');
}
