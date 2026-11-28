import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TicketClaims } from '@iva-games/realtime-kit';

export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  throw new Error('INVALID_JSON');
}
export function loadSigningKey(path: string): KeyObject {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    try { writeFileSync(path, key, { flag: 'wx', mode: 0o600 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  chmodSync(path, 0o600);
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('INVALID_SIGNING_KEY');
  return key;
}
export function publicKeyPem(key: KeyObject): string { return createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(); }
export function signTicket(claims: TicketClaims, key: KeyObject): string {
  const payload = Buffer.from(canonical(claims)).toString('base64url');
  return payload + '.' + sign(null, Buffer.from('iva-ticket-v1.' + payload), key).toString('base64url');
}
export function verifyTicket(token: string, keys: Record<string, KeyObject>, origin: string, now = Date.now()): TicketClaims {
  const parts = token.split('.');
  if (parts.length !== 2 || token.length > 3800 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error('AUTH_REQUIRED');
  let value: TicketClaims;
  try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as TicketClaims; } catch { throw new Error('AUTH_REQUIRED'); }
  const keysAllowed = ['issuer', 'audience', 'keyId', 'ticketId', 'playerId', 'participantId', 'matchId', 'roomId', 'rosterHash', 'gameId', 'protocolVersion', 'rulesVersion', 'contentVersion', 'allowedOrigin', 'permission', 'issuedAt', 'expiresAt', 'admissionId'];
  if (!value || Object.keys(value).length !== keysAllowed.length || Object.keys(value).some(k => !keysAllowed.includes(k)) ||
    !['iva-platform', 'iva-realtime-practice'].includes(value.issuer) || value.audience !== 'iva-realtime' || value.protocolVersion !== 1 || value.permission !== 'control' ||
    value.allowedOrigin !== origin || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) || value.issuedAt > now + 5000 ||
    value.expiresAt < now - 5000 || value.expiresAt - value.issuedAt !== 30_000 || !/^[A-Za-z0-9_-]{32}$/.test(value.ticketId) ||
    !keys[value.keyId] || canonical(value) !== Buffer.from(parts[0], 'base64url').toString() ||
    !verify(null, Buffer.from('iva-ticket-v1.' + parts[0]), keys[value.keyId], Buffer.from(parts[1], 'base64url'))) throw new Error('AUTH_REQUIRED');
  return value;
}
export function newTicketId(): string { return randomBytes(24).toString('base64url'); }
export function bridgeSignature(method: string, path: string, body: string, requestId: string, timestamp: string, key: KeyObject): string {
  return sign(null, Buffer.from(['iva-bridge-v1', method, path, requestId, timestamp, hash(body)].join('\n')), key).toString('base64url');
}
export function verifyBridge(method: string, path: string, body: string, requestId: string, timestamp: string, signature: string, key: KeyObject): boolean {
  if (!/^[A-Za-z0-9_-]{32}$/.test(requestId) || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30_000) return false;
  return verify(null, Buffer.from(['iva-bridge-v1', method, path, requestId, timestamp, hash(body)].join('\n')), key, Buffer.from(signature, 'base64url'));
}
