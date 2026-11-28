import { resolve } from 'node:path';
import { parseTrustedProxyIps } from '@iva-games/session-kit/http';
import { createFileMailbox, createSmtpMailbox } from './mail.js';
import type { TelegramAuthConfig } from './telegram/auth.js';
import type { MailTransport } from './types.js';

function bool(value: string | undefined): boolean { return value === '1' || value === 'true'; }
function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('Invalid configured port');
  return parsed;
}
function isLoopback(host: string): boolean { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host); }
export interface PlatformConfig {
  production: boolean;
  host: string;
  port: number;
  publicOrigin: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  trustedProxyIps: string[];
  databasePath: string;
  runtimeDatabasePath: string;
  serveDirectory: string | undefined;
  mail?: MailTransport;
  mailMode: 'smtp' | 'file' | 'disabled';
  realtime?: { baseUrl: string; signingKeyPath: string; keyId: string; publicOrigin: string };
  telegramAuth?: TelegramAuthConfig;
  telegram?: {
    botToken: string; botId: string; botUsername: string; webhookSecret: string;
    proofEncryptionKey: Uint8Array; proxyUrl: string;
  };
}

export function loadPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const production = env.NODE_ENV === 'production';
  const host = env.PLATFORM_HOST ?? '127.0.0.1';
  const configuredPort = port(env.PLATFORM_PORT, 4310);
  const publicUrl = new URL(env.PORTAL_ORIGIN ?? (production ? '' : 'http://127.0.0.1:5175'));
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('PORTAL_ORIGIN must be an origin without credentials or path');
  if (!['https:', 'http:'].includes(publicUrl.protocol) || (production && publicUrl.protocol !== 'https:')) throw new Error('Production portal requires HTTPS');
  if (!production && publicUrl.protocol === 'http:' && !isLoopback(publicUrl.hostname)) throw new Error('HTTP development is restricted to loopback origins');
  const publicOrigin = publicUrl.origin;
  const allowedOrigins = (env.PLATFORM_ALLOWED_ORIGINS ?? publicOrigin).split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    const value = new URL(origin);
    if (value.origin !== origin || (production && value.protocol !== 'https:')) throw new Error('Invalid allowed origin');
    if (!production && value.protocol === 'http:' && !isLoopback(value.hostname)) throw new Error('HTTP development origins must be loopback');
  }
  if (!allowedOrigins.includes(publicOrigin)) throw new Error('PORTAL_ORIGIN must be allowed');
  const allowedHosts = (env.PLATFORM_ALLOWED_HOSTS ?? `${publicUrl.host},127.0.0.1:${configuredPort},localhost:${configuredPort}`).split(',').map(value => value.trim()).filter(Boolean);
  if (allowedHosts.some(value => value.includes('/') || value.includes('@') || /\s/.test(value) || !value)) throw new Error('Invalid allowed Host');
  const mailMode = env.MAIL_MODE ?? (production ? 'smtp' : 'file');
  let mail: MailTransport | undefined;
  if (mailMode === 'file') {
    if (production || !isLoopback(host) || !isLoopback(publicUrl.hostname)) throw new Error('File mailbox is permitted only in isolated loopback development');
    mail = createFileMailbox(env.MAIL_FILE_DIRECTORY ?? '.runtime/platform-mail');
  } else if (mailMode === 'smtp') {
    if (!env.SMTP_HOST || !env.SMTP_FROM || !/^[^\r\n]+@[^\r\n]+$/.test(env.SMTP_FROM)) throw new Error('SMTP_HOST and a valid SMTP_FROM are required');
    if (env.SMTP_USER && !env.SMTP_PASSWORD) throw new Error('SMTP authentication password is required');
    const secure = env.SMTP_SECURE === undefined ? true : bool(env.SMTP_SECURE);
    mail = createSmtpMailbox({ host: env.SMTP_HOST, port: port(env.SMTP_PORT, secure ? 465 : 587), secure, user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.SMTP_FROM });
  } else if (mailMode !== 'disabled') throw new Error('MAIL_MODE must be smtp, file or disabled');
  let telegramAuth: TelegramAuthConfig | undefined;
  const authFlag = env.TELEGRAM_AUTH_ENABLED;
  if (authFlag !== undefined && !['true', 'false'].includes(authFlag)) throw new Error('Invalid TELEGRAM_AUTH_ENABLED');
  if (authFlag === 'true') {
    const { TELEGRAM_AUTH_BOT_ID: botId = '', TELEGRAM_AUTH_BOT_USERNAME: botUsername = '',
      TELEGRAM_AUTH_WEBHOOK_SECRET: webhookSecret = '', TELEGRAM_AUTH_CODE_KEY_BASE64: encodedKey = '' } = env;
    const codeKey = Buffer.from(encodedKey, 'base64');
    if (publicUrl.protocol !== 'https:' || !/^[1-9]\d{3,18}$/.test(botId) || !/^[A-Za-z0-9_]{5,32}$/.test(botUsername) ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) || codeKey.length !== 32 || codeKey.toString('base64') !== encodedKey) {
      throw new Error('Invalid Telegram account bot configuration');
    }
    telegramAuth = { botId, botUsername, webhookSecret, codeKey };
  }
  let telegram: PlatformConfig['telegram'];
  const telegramFlag = env.TELEGRAM_ENABLED;
  if (telegramFlag !== undefined && !['0', 'false', '1', 'true'].includes(telegramFlag)) throw new Error('TELEGRAM_ENABLED must be true or false');
  const telegramKeys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_PROOF_KEY_BASE64', 'TELEGRAM_PROXY_URL'] as const;
  if (!bool(telegramFlag) && telegramFlag === undefined && telegramKeys.some(key => !!env[key])) throw new Error('Telegram credentials require explicit TELEGRAM_ENABLED; partial configuration is not activated');
  if (bool(telegramFlag)) {
    if (telegramKeys.some(key => !env[key])) throw new Error('Enabled Telegram requires token, username, webhook secret, proof key and kz-bot proxy');
    if (publicUrl.protocol !== 'https:') throw new Error('Telegram linking requires an HTTPS portal origin');
    const botToken = env.TELEGRAM_BOT_TOKEN!;
    const botUsername = env.TELEGRAM_BOT_USERNAME!;
    const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET!;
    const encodedKey = env.TELEGRAM_PROOF_KEY_BASE64!;
    if (!/^\d{4,}:[A-Za-z0-9_-]{20,}$/.test(botToken) || !/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) throw new Error('Invalid Telegram bot configuration');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) throw new Error('Invalid Telegram webhook secret');
    const proofEncryptionKey = Buffer.from(encodedKey, 'base64');
    if (proofEncryptionKey.length !== 32 || proofEncryptionKey.toString('base64') !== encodedKey) throw new Error('Telegram proof key must be 32 bytes encoded in base64');
    const proxyUrl = env.TELEGRAM_PROXY_URL!;
    let proxy: URL;
    try { proxy = new URL(proxyUrl); } catch { throw new Error('Invalid Telegram proxy configuration'); }
    if (!['http:', 'https:', 'socks5h:'].includes(proxy.protocol) || proxy.search || proxy.hash || (proxy.pathname && proxy.pathname !== '/')) throw new Error('Telegram requires an explicit HTTP CONNECT or socks5h proxy');
    telegram = { botToken, botId: botToken.split(':')[0], botUsername, webhookSecret, proofEncryptionKey, proxyUrl };
  }
  let realtime: PlatformConfig['realtime'];
  if (env.REALTIME_INTERNAL_ORIGIN) {
    const endpoint = new URL(env.REALTIME_INTERNAL_ORIGIN);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      !env.REALTIME_SIGNING_KEY_PATH || !env.REALTIME_SIGNING_KEY_ID) throw new Error('Realtime requires an internal origin and signing key configuration');
    realtime = { baseUrl: endpoint.origin, signingKeyPath: resolve(env.REALTIME_SIGNING_KEY_PATH), keyId: env.REALTIME_SIGNING_KEY_ID, publicOrigin };
  }
  return {
    production, host, port: configuredPort, publicOrigin, allowedOrigins, allowedHosts,
    trustedProxyIps: parseTrustedProxyIps(env.TRUSTED_PROXY_IPS),
    databasePath: resolve(env.PLATFORM_DATABASE_PATH ?? '.runtime/platform.sqlite'),
    runtimeDatabasePath: resolve(env.PLATFORM_LAB_DATABASE_PATH ?? '.runtime/platform-lab.sqlite'),
    serveDirectory: env.PORTAL_DIST_DIRECTORY ? resolve(env.PORTAL_DIST_DIRECTORY) : undefined,
    mail, mailMode, telegram, telegramAuth, realtime,
  };
}
