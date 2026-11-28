import { createDistrictRegistration } from '@iva-games/district/runtime';
import { createPlatformLabRegistration } from '@iva-games/session-kit/lab';
import { createForpostRegistration, forpostUnavailable } from './realtime-adapter.js';
import { createTelegramTransport } from '@iva-games/telegram-transport';
import { loadPlatformConfig } from './config.js';
import { createPlatformHttpServer } from './http.js';
import { PlatformService } from './service.js';
import { TelegramAuth } from './telegram/auth.js';
import { TelegramService } from './telegram/index.js';

process.umask(0o077);
const config = loadPlatformConfig();
const lab = createPlatformLabRegistration({ databasePath: config.runtimeDatabasePath });
// New rooms follow this deployed release; stored rooms retain their own version.
const district = createDistrictRegistration({ databasePath: config.runtimeDatabasePath, territorialDefault: true });
const realtime = config.realtime ? createForpostRegistration(config.realtime) : undefined;
const platform = new PlatformService({ databasePath: config.databasePath, publicOrigin: config.publicOrigin, mail: config.mail, games: [lab, district, realtime?.registration ?? forpostUnavailable()] });
await platform.ready;
const telegramTransport = config.telegram ? createTelegramTransport({
  botToken: config.telegram.botToken, proxyUrl: config.telegram.proxyUrl,
  portalOrigin: config.publicOrigin, timeoutMs: 10_000,
}) : undefined;
const telegram = config.telegram && telegramTransport ? new TelegramService({
  db: platform.db, publicOrigin: config.publicOrigin, botId: config.telegram.botId,
  botUsername: config.telegram.botUsername, webhookSecret: config.telegram.webhookSecret,
  proofEncryptionKey: config.telegram.proofEncryptionKey, transport: telegramTransport, sendTimeoutMs: 10_000,
}) : undefined;
if (telegram) platform.setInvitationDelivery(invitationId => telegram.enqueueInvitation(invitationId));
const telegramAuth = config.telegramAuth ? new TelegramAuth(platform, config.telegramAuth) : undefined;
const server = createPlatformHttpServer(platform, {
  publicOrigin: config.publicOrigin, allowedOrigins: config.allowedOrigins,
  trustedProxyIps: config.trustedProxyIps,
  allowedHosts: config.allowedHosts, secureCookies: config.publicOrigin.startsWith('https:'), serveDirectory: config.serveDirectory,
  telegramAuth, telegramAuthWebhookSecret: config.telegramAuth?.webhookSecret,
  telegram, telegramWebhookSecret: config.telegram?.webhookSecret,
});
let telegramWork: Promise<void> | undefined;
const runWorkers = (): void => {
  void platform.reconcile().catch(() => { console.error('Platform reconciliation failed; durable state retained.'); });
  if (realtime) void realtime.refreshAdmissions((sessionHash, playerId) => platform.isRealtimeAdmissionValid(sessionHash, playerId))
    .catch(() => { console.error('Realtime admission refresh unavailable; expired admission will reconnect.'); });
  if (telegram && !telegramWork) {
    telegramWork = telegram.drain({ limit: 1 }).then(() => {}, () => {
      console.error('Telegram outbox attempt failed; durable state retained.');
    }).finally(() => { telegramWork = undefined; });
  }
};
const timer = setInterval(runWorkers, 1000);
timer.unref();
server.listen(config.port, config.host, () => {
  console.info(`Iva Games platform listening on ${config.host}:${config.port}`);
  if (config.mailMode === 'file') console.info('Development file mailbox active. No email is sent.');
  console.info(telegram ? 'Telegram outbox enabled with an explicit proxy.' : 'Telegram integration is not configured.');
  runWorkers();
});
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  platform.stopReconciliation();
  // Compose allows 60s. A failed drain exits nonzero before Docker's SIGKILL,
  // so deployment can reject it instead of describing a forced exit as clean.
  const deadline = setTimeout(() => {
    console.error('Platform shutdown exceeded 30s; durable state retained for recovery.');
    process.exit(1);
  }, 30_000);
  void (async () => {
    await server.shutdown();
    // Accepted HTTP handlers can start adapter work while they drain. Only now
    // is the runtime-work set stable; a response timeout is not cancellation.
    await Promise.all([platform.settle(), telegramWork]);
    telegramTransport?.close(); platform.close(); lab.close(); district.close();
  })().then(() => {
    clearTimeout(deadline); process.exit(0);
  }, () => {
    clearTimeout(deadline);
    console.error('Platform shutdown failed; durable state retained for recovery.');
    process.exit(1);
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
