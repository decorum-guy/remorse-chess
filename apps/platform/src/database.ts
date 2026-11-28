import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** One platform process owns this SQLite file. Runtime databases stay separate. */
export function openPlatformDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  const version = (db.pragma('user_version', { simple: true }) as number);
  if (version > 1) throw new Error('Platform database version is newer than this application');
  if (version === 0) db.transaction(() => {
    db.exec(`
      CREATE TABLE players (
        player_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE web_sessions (
        session_hash TEXT PRIMARY KEY, player_id TEXT REFERENCES players(player_id), csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        reauthenticated_at INTEGER NOT NULL
      );
      CREATE INDEX web_sessions_player ON web_sessions(player_id);
      CREATE TABLE account_tokens (
        token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(player_id),
        purpose TEXT NOT NULL CHECK(purpose IN ('verification','password_reset')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE INDEX account_tokens_player ON account_tokens(player_id,purpose);
      CREATE TABLE friendships (
        request_id TEXT NOT NULL UNIQUE, low_id TEXT NOT NULL REFERENCES players(player_id),
        high_id TEXT NOT NULL REFERENCES players(player_id), requested_by TEXT NOT NULL REFERENCES players(player_id),
        state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined','cancelled','removed')),
        updated_at INTEGER NOT NULL, PRIMARY KEY(low_id,high_id), CHECK(low_id < high_id)
      );
      CREATE TABLE blocks (
        blocker_id TEXT NOT NULL REFERENCES players(player_id), blocked_id TEXT NOT NULL REFERENCES players(player_id),
        created_at INTEGER NOT NULL, PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id <> blocked_id)
      );
      CREATE TABLE rooms (
        room_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, title TEXT NOT NULL,
        host_player_id TEXT NOT NULL REFERENCES players(player_id),
        state TEXT NOT NULL CHECK(state IN ('lobby','starting','playing','finished','cancelled')),
        capacity INTEGER NOT NULL CHECK(capacity BETWEEN 2 AND 16), rules_version TEXT NOT NULL,
        content_version TEXT NOT NULL, revision INTEGER NOT NULL, settings_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, match_id TEXT, outcome_json TEXT
      );
      CREATE TABLE room_members (
        participant_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id),
        player_id TEXT REFERENCES players(player_id), seat_index INTEGER NOT NULL,
        ready INTEGER NOT NULL DEFAULT 0, controller_json TEXT NOT NULL, display_name TEXT NOT NULL,
        UNIQUE(room_id,player_id), UNIQUE(room_id,seat_index)
      );
      CREATE TABLE invitations (
        invitation_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id),
        inviter_id TEXT NOT NULL REFERENCES players(player_id), invitee_id TEXT NOT NULL REFERENCES players(player_id),
        state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined','revoked','expired')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, reason TEXT
      );
      CREATE UNIQUE INDEX one_active_invite ON invitations(room_id,invitee_id) WHERE state IN ('pending','accepted');
      CREATE TABLE seat_reservations (
        room_id TEXT NOT NULL REFERENCES rooms(room_id), player_id TEXT NOT NULL REFERENCES players(player_id),
        invitation_id TEXT NOT NULL UNIQUE REFERENCES invitations(invitation_id), expires_at INTEGER NOT NULL,
        PRIMARY KEY(room_id,player_id)
      );
      CREATE TABLE start_commands (
        start_command_id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE REFERENCES rooms(room_id),
        payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, completed_at INTEGER, last_error TEXT
      );
      CREATE TABLE idempotency (
        actor TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(actor,operation,key)
      );
      CREATE TABLE site_notifications (
        event_id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(player_id),
        kind TEXT NOT NULL, invitation_id TEXT REFERENCES invitations(invitation_id), created_at INTEGER NOT NULL
      );
      CREATE TABLE integration_outbox (
        event_id TEXT PRIMARY KEY, destination TEXT NOT NULL, payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, UNIQUE(destination,event_id)
      );
      PRAGMA user_version = 1;
    `);
  }).immediate();
  // Additive authentication tables leave legacy player rows and foreign keys intact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_result_receipts (
      game_id TEXT NOT NULL, match_id TEXT NOT NULL, result_id TEXT NOT NULL,
      outcome_json TEXT NOT NULL, accepted_at INTEGER NOT NULL, acknowledged_at INTEGER,
      PRIMARY KEY(game_id,match_id), UNIQUE(game_id,result_id)
    );
    CREATE TABLE IF NOT EXISTS player_avatar (
      player_id TEXT PRIMARY KEY REFERENCES players(player_id),
      avatar TEXT NOT NULL CHECK(avatar IN ('king','queen','rook','bishop','knight','pawn'))
    );
    -- Additive storage preserves the existing six-figure table and old accounts.
    CREATE TABLE IF NOT EXISTS player_avatar_extra (
      player_id TEXT PRIMARY KEY REFERENCES players(player_id),
      avatar TEXT NOT NULL CHECK(avatar IN ('fox','cat','owl','robot','astronaut','dragon','dice','comet','photo')),
      photo BLOB, photo_version TEXT,
      CHECK((avatar='photo' AND photo IS NOT NULL AND photo_version IS NOT NULL) OR
            (avatar<>'photo' AND photo IS NULL AND photo_version IS NULL))
    );
    CREATE TABLE IF NOT EXISTS telegram_login_accounts (
      bot_id TEXT NOT NULL, telegram_user_id TEXT NOT NULL, player_id TEXT NOT NULL UNIQUE REFERENCES players(player_id),
      PRIMARY KEY(bot_id,telegram_user_id)
    );
    CREATE TABLE IF NOT EXISTS telegram_auth_attempts (
      id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, bot_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL, locale TEXT NOT NULL, telegram_user_id TEXT, first_update INTEGER,
      reply_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS telegram_auth_expiry ON telegram_auth_attempts(expires_at);
    CREATE INDEX IF NOT EXISTS telegram_auth_recipient ON telegram_auth_attempts(bot_id,telegram_user_id,reply_at);
    -- A player's room-list cleanup never deletes rooms or other participants' history.
    CREATE TABLE IF NOT EXISTS room_list_hidden (
      player_id TEXT NOT NULL REFERENCES players(player_id),
      room_id TEXT NOT NULL REFERENCES rooms(room_id),
      PRIMARY KEY(player_id,room_id)
    );
  `);
  return db;
}
