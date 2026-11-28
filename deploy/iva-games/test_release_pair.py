"""Real SQLite copies and the production pair verifier; no Docker/VPS claim."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('release-pair.mjs').resolve()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


class ReleasePairTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix='iva-pair-test-')
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.platform = self.root / 'platform'; self.platform.mkdir()
        self.realtime = self.root / 'realtime'; self.realtime.mkdir()
        self.start = {'startCommandId': 'start-1', 'roomId': 'room-1', 'rulesVersion': 'tyaga@0.1',
                      'contentVersion': 'content@1', 'settings': {}, 'participants': [
                          {'participantId': 'seat-1', 'playerId': 'player-1', 'controller': {'kind': 'human', 'playerId': 'player-1'}}]}
        self.roster = hashlib.sha256(canonical(self.start['participants']).encode()).hexdigest()
        self.manifest = {'gameId': 'tyaga', 'rulesVersion': 'tyaga@0.1', 'contentVersion': 'content@1',
                         'runtimeArtifactId': 'runtime@1:' + 'a' * 64,
                         'clientContentHash': 'b' * 64, 'clientRoute': '/play/tyaga/versions/' + 'b' * 64 + '/'}
        self.meta = {'phase': 'paused', 'epoch': 2, 'journalSeq': 10, 'worldTick': 60, 'outcome': None}
        self.barrier = {'ok': True, 'manifest': {'schema': 1, 'capturedAt': 100, 'gameIds': ['tyaga'],
            'matches': [{**self.manifest, 'matchId': 'match-1', 'phase': 'paused', 'epoch': 2, 'journalSeq': 10,
                         'worldTick': 60, 'rosterHash': self.roster}]}}
        with sqlite3.connect(self.platform / 'platform.sqlite') as db:
            db.executescript('''
                CREATE TABLE rooms(room_id TEXT PRIMARY KEY,game_id TEXT,host_player_id TEXT,state TEXT,match_id TEXT,outcome_json TEXT);
                CREATE TABLE start_commands(start_command_id TEXT,room_id TEXT,payload_json TEXT,completed_at INTEGER);
            ''')
            db.execute('INSERT INTO rooms VALUES(?,?,?,?,?,?)', ('room-1', 'tyaga', 'player-1', 'playing', 'match-1', None))
            db.execute('INSERT INTO start_commands VALUES(?,?,?,?)', ('start-1', 'room-1', canonical(self.start), 99))
        with sqlite3.connect(self.realtime / 'realtime.sqlite') as db:
            db.executescript('''
                CREATE TABLE rt_matches(id TEXT PRIMARY KEY,start_id TEXT,roster_hash TEXT,manifest TEXT,start TEXT,meta TEXT);
                CREATE TABLE rt_snapshots(match_id TEXT,seq INTEGER);
                CREATE TABLE rt_outbox(result_id TEXT,match_id TEXT,value TEXT,acknowledged INTEGER);
            ''')
            db.execute('INSERT INTO rt_matches VALUES(?,?,?,?,?,?)', ('match-1', 'start-1', self.roster, canonical(self.manifest), canonical(self.start), canonical(self.meta)))
            db.execute('INSERT INTO rt_snapshots VALUES(?,?)', ('match-1', 10))

    def verify(self, success=True):
        barrier = self.root / 'barrier.json'; barrier.write_text(json.dumps(self.barrier))
        before = {path: path.read_bytes() for path in [self.platform / 'platform.sqlite', self.realtime / 'realtime.sqlite']}
        result = subprocess.run(['node', str(SCRIPT), str(self.platform), str(self.realtime), str(barrier)],
                                capture_output=True, text=True, timeout=10)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content, 'Verifier wrote into a saved backup')
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout); self.assertTrue(report['valid']); return report
        self.assertNotEqual(result.returncode, 0)

    def test_linked_match_is_verified_without_changing_either_backup(self):
        report = self.verify()
        self.assertEqual(report['matches'][0]['roomId'], 'room-1')
        self.assertEqual(report['runtimeArtifacts'], [self.manifest['runtimeArtifactId']])
        self.assertEqual(report['clientContentHashes'], [self.manifest['clientContentHash']])

    def test_browser_version_cannot_change_after_drain(self):
        self.barrier['manifest']['matches'][0]['clientContentHash'] = 'c' * 64
        self.verify(False)

    def queued_fixture(self):
        start = copy.deepcopy(self.start)
        start.update(startCommandId='queued-start', roomId='queued-room', hostPlayerId='queued-host')
        start['participants'][0].update(playerId='queued-host', controller={'kind': 'human', 'playerId': 'queued-host'})
        start_hash = hashlib.sha256(canonical({'gameId': 'tyaga', 'input': start}).encode()).hexdigest()
        with sqlite3.connect(self.platform / 'platform.sqlite') as db:
            db.execute('INSERT INTO rooms VALUES(?,?,?,?,?,?)', ('queued-room', 'tyaga', 'queued-host', 'starting', None, None))
            db.execute('INSERT INTO start_commands VALUES(?,?,?,?)', ('queued-start', 'queued-room', canonical(start), None))
        with sqlite3.connect(self.realtime / 'realtime.sqlite') as db:
            db.execute('CREATE TABLE rt_admissions(sequence INTEGER,start_id TEXT,host_id TEXT,game_id TEXT,start TEXT,start_hash TEXT,reservation_id TEXT,reserved_until INTEGER)')
            db.execute('INSERT INTO rt_admissions VALUES(?,?,?,?,?,?,?,?)', (1, 'queued-start', 'queued-host', 'tyaga', canonical(start), start_hash, 'reservation', 15000))
        self.barrier['manifest']['admissions'] = [{'sequence': 1, 'startCommandId': 'queued-start', 'hostPlayerId': 'queued-host',
            'gameId': 'tyaga', 'startHash': start_hash, 'reservationId': 'reservation', 'reservedUntil': 15000}]

    def test_queue_reservation_and_frozen_platform_start_are_preserved_together(self):
        self.queued_fixture()
        self.assertEqual(self.verify()['admissions'], self.barrier['manifest']['admissions'])

    def test_queue_without_its_frozen_platform_command_is_rejected(self):
        self.queued_fixture()
        with sqlite3.connect(self.platform / 'platform.sqlite') as db:
            db.execute("DELETE FROM start_commands WHERE start_command_id='queued-start'")
        self.verify(False)

    def test_queue_cannot_claim_a_different_room_owner(self):
        self.queued_fixture()
        with sqlite3.connect(self.platform / 'platform.sqlite') as db:
            db.execute("UPDATE rooms SET host_player_id='different' WHERE room_id='queued-room'")
        self.verify(False)

    def test_queue_reservation_cannot_change_after_drain(self):
        self.queued_fixture()
        with sqlite3.connect(self.realtime / 'realtime.sqlite') as db:
            db.execute("UPDATE rt_admissions SET reservation_id='new-token'")
        self.verify(False)

    def test_durable_pending_start_is_a_valid_recoverable_link(self):
        with sqlite3.connect(self.platform / 'platform.sqlite') as db:
            db.execute("UPDATE rooms SET state='starting',match_id=NULL")
            db.execute('UPDATE start_commands SET completed_at=NULL')
        self.assertEqual(self.verify()['matches'][0]['platformState'], 'starting')

    def test_changed_frozen_controller_roster_fails_without_repairing_data(self):
        changed = copy.deepcopy(self.start); changed['participants'][0]['playerId'] = 'different-player'
        with sqlite3.connect(self.platform / 'platform.sqlite') as db:
            db.execute('UPDATE start_commands SET payload_json=?', (canonical(changed),))
        self.verify(False)

    def test_world_without_a_platform_room_is_rejected(self):
        with sqlite3.connect(self.platform / 'platform.sqlite') as db:
            db.execute('DELETE FROM rooms')
        self.verify(False)

    def test_platform_link_to_an_absent_world_is_rejected_even_with_empty_runtime(self):
        with sqlite3.connect(self.realtime / 'realtime.sqlite') as db:
            db.execute('DELETE FROM rt_matches'); db.execute('DELETE FROM rt_snapshots')
        self.barrier['manifest']['matches'] = []
        self.verify(False)

    def test_a_world_advanced_after_the_positive_drain_is_rejected(self):
        self.meta['journalSeq'] += 1
        with sqlite3.connect(self.realtime / 'realtime.sqlite') as db:
            db.execute('UPDATE rt_matches SET meta=?', (canonical(self.meta),))
        self.verify(False)

    def test_missing_full_drain_snapshot_is_rejected(self):
        with sqlite3.connect(self.realtime / 'realtime.sqlite') as db:
            db.execute('UPDATE rt_snapshots SET seq=9')
        self.verify(False)

    def result_fixture(self, acknowledged):
        result = {'resultId': 'result-1', 'game': {'success': True}}
        self.meta.update(phase='finished', outcome=result)
        self.barrier['manifest']['matches'][0]['phase'] = 'finished'
        with sqlite3.connect(self.realtime / 'realtime.sqlite') as db:
            db.execute('UPDATE rt_matches SET meta=?', (canonical(self.meta),))
            db.execute('INSERT INTO rt_outbox VALUES(?,?,?,?)', ('result-1', 'match-1', canonical(result), acknowledged))
        return result

    def test_undelivered_outcome_remains_in_durable_outbox_for_reconciliation(self):
        self.result_fixture(0)
        self.assertFalse(self.verify()['matches'][0]['acknowledged'])

    def test_acknowledgement_without_a_platform_commit_is_rejected(self):
        self.result_fixture(1)
        self.verify(False)

    def test_the_same_durable_result_on_both_sides_is_verified(self):
        result = self.result_fixture(1)
        with sqlite3.connect(self.platform / 'platform.sqlite') as db:
            db.execute("UPDATE rooms SET state='finished',outcome_json=?", (canonical(result),))
        self.assertTrue(self.verify()['matches'][0]['acknowledged'])


if __name__ == '__main__':
    unittest.main()
