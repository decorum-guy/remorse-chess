// Verify frozen, disposable backup copies. Does not write either saved backup
// or a live application database, and never repairs an inconsistent pair.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
export function inspectReleasePair(platformDirectory, realtimeDirectory, barrier) {
  assert.equal(barrier.ok, true); assert.equal(barrier.manifest?.schema, 1);
  assert.ok(Array.isArray(barrier.manifest.matches));
  const scratch = mkdtempSync(join(tmpdir(), 'iva-pair-'));
  let platform, realtime;
  try {
    for (const [kind, directory] of [['platform', platformDirectory], ['realtime', realtimeDirectory]]) {
      const target = join(scratch, kind); mkdirSync(target);
      for (const name of readdirSync(directory)) if (/\.sqlite(?:-(?:wal|shm))?$/.test(name)) copyFileSync(join(directory, name), join(target, name));
    }
    platform = new Database(join(scratch, 'platform/platform.sqlite'), { readonly: true, fileMustExist: true });
    realtime = new Database(join(scratch, 'realtime/realtime.sqlite'), { readonly: true, fileMustExist: true });
    for (const db of [platform, realtime]) {
      assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    }
    const records = realtime.prepare('SELECT id,start_id,roster_hash,manifest,start,meta FROM rt_matches ORDER BY id').all();
    const runtimeIds = new Set(records.map(row => row.id)), gameIds = new Set([...(barrier.manifest.gameIds ?? []), ...records.map(row => JSON.parse(row.manifest).gameId)]);
    const barrierIds = new Set(barrier.manifest.matches.map(row => row.matchId));
    assert.equal(barrierIds.size, barrier.manifest.matches.length, 'Duplicate drain match');
    assert.deepEqual([...runtimeIds].sort(), [...barrierIds].sort(), 'Match set changed after durable drain');
    const matches = [];
    for (const record of records) {
      const meta = JSON.parse(record.meta), manifest = JSON.parse(record.manifest), start = JSON.parse(record.start);
      const drained = barrier.manifest.matches.find(row => row.matchId === record.id);
      for (const field of ['gameId', 'runtimeArtifactId', 'physicsBuildHash', 'serializerVersion', 'rulesVersion', 'contentVersion', 'clientContentHash', 'clientRoute']) {
        assert.equal(drained[field], manifest[field], `Drained ${field} differs from the saved world`);
      }
      assert.equal(meta.journalSeq, drained.journalSeq, 'Journal changed after durable drain');
      assert.equal(meta.worldTick, drained.worldTick); assert.equal(meta.epoch, drained.epoch); assert.equal(meta.phase, drained.phase);
      assert.ok(['paused', 'finished', 'abandoned'].includes(meta.phase), 'A world was not frozen before backup');
      const snapshot = realtime.prepare('SELECT seq FROM rt_snapshots WHERE match_id=? ORDER BY seq DESC LIMIT 1').get(record.id);
      assert.equal(snapshot?.seq, meta.journalSeq, 'Drain must include a complete, committed world snapshot');
      const room = platform.prepare('SELECT room_id,game_id,host_player_id,state,match_id,outcome_json FROM rooms WHERE room_id=?').get(start.roomId);
      assert.ok(room, 'Realtime world has no durable platform room');
      assert.equal(room.game_id, manifest.gameId); assert.equal(drained.rosterHash, record.roster_hash);
      const command = platform.prepare('SELECT start_command_id,payload_json,completed_at FROM start_commands WHERE room_id=?').get(start.roomId);
      assert.ok(command, 'Realtime world has no durable platform start command');
      assert.equal(command.start_command_id, record.start_id); assert.equal(record.start_id, start.startCommandId);
      const frozen = JSON.parse(command.payload_json);
      if (frozen.hostPlayerId !== undefined) assert.equal(frozen.hostPlayerId, room.host_player_id, 'Frozen host differs from the room owner');
      assert.equal(fingerprint(frozen.participants), record.roster_hash, 'Frozen participant/controller roster differs');
      assert.equal(frozen.rulesVersion, manifest.rulesVersion); assert.equal(frozen.contentVersion, manifest.contentVersion);
      assert.equal(fingerprint(frozen), fingerprint(start), 'Frozen start settings differ');
      if (room.state === 'starting') { assert.equal(room.match_id, null); assert.equal(command.completed_at, null); }
      else { assert.ok(['playing', 'finished'].includes(room.state)); assert.equal(room.match_id, record.id); assert.notEqual(command.completed_at, null); }
      const outcome = room.outcome_json ? JSON.parse(room.outcome_json) : null;
      const outbox = realtime.prepare('SELECT result_id,value,acknowledged FROM rt_outbox WHERE match_id=?').get(record.id);
      if (meta.outcome) {
        assert.equal(outbox?.result_id, meta.outcome.resultId, 'Durable result is missing from outbox');
        assert.equal(fingerprint(JSON.parse(outbox.value)), fingerprint(meta.outcome));
        if (outcome) assert.equal(fingerprint(outcome), fingerprint(meta.outcome), 'Platform result differs from authoritative result');
        if (outbox.acknowledged) assert.equal(outcome?.resultId, outbox.result_id, 'Acknowledged result is missing on platform');
      } else { assert.equal(outbox, undefined, 'Unexpected result outbox'); assert.equal(outcome, null, 'Platform invented a result'); }
      matches.push({ matchId: record.id, roomId: start.roomId, hostPlayerId: room.host_player_id, startCommandId: record.start_id,
        rosterHash: record.roster_hash, platformState: room.state, phase: meta.phase, epoch: meta.epoch,
        journalSeq: meta.journalSeq, runtimeArtifactId: manifest.runtimeArtifactId,
        ...(manifest.clientContentHash ? { clientContentHash: manifest.clientContentHash, clientRoute: manifest.clientRoute } : {}), resultId: outbox?.result_id ?? null,
        acknowledged: !!outbox?.acknowledged });
    }
    const queue = realtime.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rt_admissions'").get()
      ? realtime.prepare('SELECT sequence,start_id,host_id,game_id,start,start_hash,reservation_id,reserved_until FROM rt_admissions ORDER BY sequence').all() : [];
    const admissions = queue.map(row => ({ sequence: row.sequence, startCommandId: row.start_id, hostPlayerId: row.host_id,
      gameId: row.game_id, startHash: row.start_hash, reservationId: row.reservation_id, reservedUntil: row.reserved_until }));
    assert.deepEqual(admissions, barrier.manifest.admissions ?? [], 'Admission queue changed after durable drain');
    assert.equal(new Set(admissions.map(row => row.hostPlayerId)).size, admissions.length, 'A host has multiple pending admissions');
    for (const queued of queue) {
      const start = JSON.parse(queued.start);
      assert.equal(start.startCommandId, queued.start_id);
      assert.equal(fingerprint({ gameId: queued.game_id, input: start }), queued.start_hash, 'Queued start hash differs');
      assert.equal(records.some(row => row.start_id === queued.start_id), false, 'An admitted world still holds a reservation');
      const room = platform.prepare('SELECT game_id,host_player_id,state,match_id FROM rooms WHERE room_id=?').get(start.roomId);
      assert.ok(room, 'Queued start has no platform room');
      assert.equal(room.game_id, queued.game_id); assert.equal(room.host_player_id, queued.host_id);
      assert.equal(room.state, 'starting'); assert.equal(room.match_id, null);
      const command = platform.prepare('SELECT start_command_id,payload_json,completed_at FROM start_commands WHERE room_id=?').get(start.roomId);
      assert.ok(command, 'Queued start has no frozen platform command');
      assert.equal(command.start_command_id, queued.start_id); assert.equal(command.completed_at, null);
      assert.equal(fingerprint(JSON.parse(command.payload_json)), fingerprint(start), 'Queued settings differ from the frozen platform command');
      if (start.hostPlayerId !== undefined) assert.equal(start.hostPlayerId, queued.host_id);
      assert.ok(start.participants.some(participant => participant.playerId === queued.host_id && participant.controller.kind === 'human'), 'Queue owner is not a human in the frozen roster');
    }
    // The registry is supplied by the pinned platform image in production. The
    // drained game set also covers retained versions no longer in a catalogue.
    try { for (const game of JSON.parse(readFileSync('/app/game-registry.json', 'utf8')).games) if (game.realtime) gameIds.add(game.gameId); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const room of platform.prepare('SELECT game_id,match_id FROM rooms WHERE match_id IS NOT NULL').all()) {
      if (gameIds.has(room.game_id)) assert.ok(runtimeIds.has(room.match_id), 'Platform points to a missing realtime world');
    }
    return { schema: 1, valid: true, capturedAt: Date.now(), barrierCapturedAt: barrier.manifest.capturedAt,
      runtimeArtifacts: [...new Set(matches.map(match => match.runtimeArtifactId))].sort(),
      clientContentHashes: [...new Set(matches.flatMap(match => match.clientContentHash ? [match.clientContentHash] : []))].sort(), matches, admissions };
  } finally { platform?.close(); realtime?.close(); rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] === '-' || process.argv[1]?.endsWith('/release-pair.mjs')) {
  const [platform, realtime, path] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(inspectReleasePair(platform, realtime, JSON.parse(readFileSync(path, 'utf8')))) + '\n');
}
