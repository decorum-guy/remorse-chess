import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { REALTIME_PROTOCOL, RealtimeError, checkJson, exactFields, identifier, integer, object } from '@iva-games/realtime-kit';
import type { TicketClaims } from '@iva-games/realtime-kit';
import { canonicalJson } from '@iva-games/session-kit';

export const hash = (data: string): string => createHash('sha256').update(data).digest('hex');
export const fingerprint = (value: unknown): string => hash(canonicalJson(value));
export function privateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new RealtimeError('INVALID_KEY');
  return key;
}
export function publicKeys(entries: Record<string, string>): Map<string, KeyObject> {
  return new Map(Object.entries(entries).map(([id, pem]) => {
    const key = createPublicKey(pem);
    if (!identifier(id) || key.asymmetricKeyType !== 'ed25519') throw new RealtimeError('INVALID_KEY');
    return [id, key];
  }));
}
const signed = (purpose: string, payload: string): Buffer => Buffer.from(`${purpose}\n${payload}`, 'utf8');
export function signTicket(claims: TicketClaims, key: KeyObject): string {
  const payload = Buffer.from(canonicalJson(claims)).toString('base64url');
  return `${payload}.${sign(null, signed('iva-ticket-v1', payload), key).toString('base64url')}`;
}
export function verifyTicket(token: unknown, keys: Map<string, KeyObject>, origin: string, now: number): TicketClaims {
  if (typeof token !== 'string' || token.length > 4000) throw new RealtimeError('AUTH_FAILED', 401);
  const split = token.split('.');
  if (split.length !== 2 || !split.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new RealtimeError('AUTH_FAILED', 401);
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(Buffer.from(split[0], 'base64url').toString('utf8'))); } catch { throw new RealtimeError('AUTH_FAILED', 401); }
  const key = typeof value.keyId === 'string' ? keys.get(value.keyId) : undefined;
  if (!key || !verify(null, signed('iva-ticket-v1', split[0]), key, Buffer.from(split[1], 'base64url'))) throw new RealtimeError('AUTH_FAILED', 401);
  const fields = ['issuer', 'audience', 'keyId', 'ticketId', 'playerId', 'participantId', 'matchId', 'roomId', 'rosterHash', 'gameId', 'rulesVersion', 'contentVersion', 'protocolVersion', 'allowedOrigin', 'permission', 'sessionId', 'issuedAt', 'expiresAt'];
  exactFields(value, fields);
  if (fields.some(field => !(field in value)) || value.issuer !== 'iva-platform' || value.audience !== 'iva-realtime' || value.permission !== 'play' || value.protocolVersion !== REALTIME_PROTOCOL || value.allowedOrigin !== origin || !integer(value.issuedAt) || !integer(value.expiresAt) || value.issuedAt > now + 5000 || value.expiresAt < now - 5000 || value.expiresAt - value.issuedAt !== 30_000 || value.issuedAt < now - 35_000) throw new RealtimeError('AUTH_FAILED', 401);
  for (const field of ['keyId', 'playerId', 'participantId', 'matchId', 'roomId', 'gameId', 'rulesVersion', 'contentVersion']) if (!identifier(value[field])) throw new RealtimeError('AUTH_FAILED', 401);
  if (typeof value.ticketId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.ticketId) || typeof value.rosterHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.rosterHash) || typeof value.sessionId !== 'string' || !/^[a-f0-9]{64}$/.test(value.sessionId)) throw new RealtimeError('AUTH_FAILED', 401);
  return value as unknown as TicketClaims;
}
export interface BridgeEnvelope {
  keyId: string; nonce: string; issuedAt: number; method: string; path: string; body: unknown; signature: string;
}
export function signBridge(method: string, path: string, body: unknown, keyId: string, key: KeyObject, now = Date.now()): BridgeEnvelope {
  const base = { keyId, nonce: randomBytes(24).toString('base64url'), issuedAt: now, method, path, body };
  return { ...base, signature: sign(null, signed('iva-bridge-v1', canonicalJson(base)), key).toString('base64url') };
}
export function verifyBridge(raw: unknown, keys: Map<string, KeyObject>, method: string, path: string, now: number): BridgeEnvelope {
  const value = object(raw);
  exactFields(value, ['keyId', 'nonce', 'issuedAt', 'method', 'path', 'body', 'signature']);
  checkJson(value.body);
  const { signature, ...base } = value;
  const key = typeof value.keyId === 'string' ? keys.get(value.keyId) : undefined;
  if (!key || typeof signature !== 'string' || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.nonce) || !integer(value.issuedAt) || Math.abs(value.issuedAt - now) > 30_000 || value.method !== method || value.path !== path || !verify(null, signed('iva-bridge-v1', canonicalJson(base)), key, Buffer.from(signature, 'base64url'))) throw new RealtimeError('BRIDGE_UNAUTHORIZED', 401);
  return value as unknown as BridgeEnvelope;
}
