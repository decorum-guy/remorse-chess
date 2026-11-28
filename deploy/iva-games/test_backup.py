"""Backup orchestration fault tests; Docker is a CLI double, SQLite is real.

These do not claim a Docker/VPS acceptance. The production script's unchanged
Node verifier runs with the installed better-sqlite3 against actual WAL files.
"""
import json
import hashlib
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time
import unittest


HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, signal, subprocess, sys
root = pathlib.Path(os.environ['BACKUP_TEST_ROOT'])
args = sys.argv[1:]
with (root / 'commands.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
state_path = root / 'state.json'
state = json.loads(state_path.read_text())
fault = os.environ.get('BACKUP_TEST_FAULT', '')
if args[0] == 'inspect':
    if '|' in args[2]:
        values = ['sha256:' + 'a' * 64, str(state['running']).lower(), str(state['paused']).lower(),
                  'ghcr.io/example/iva-platform@sha256:' + 'b' * 64, 'c' * 40]
        print('|'.join(values))
    else:
        print(str(state['running']).lower(), str(state['paused']).lower())
elif args[0] == 'pause':
    state['paused'] = True
    state_path.write_text(json.dumps(state))
    if fault == 'pause_reply_lost': sys.exit(1)
elif args[0] == 'unpause':
    if fault == 'unpause_once' and not state.get('retried'):
        state['retried'] = True
        state_path.write_text(json.dumps(state))
        sys.exit(1)
    state['paused'] = False
    state_path.write_text(json.dumps(state))
elif args[0] == 'cp':
    assert not state['running'] or state['paused'], 'live writable copy forbidden'
    if fault == 'copy': sys.exit(1)
    if fault == 'signal':
        (root / 'copy-waiting').touch()
        signal.pause()
    shutil.copytree(root / 'source', args[2], dirs_exist_ok=True)
elif args[0] == 'run':
    assert not state['paused'], 'verification must follow resume'
    assert args[args.index('--network') + 1] == 'none'
    mount = args[args.index('--mount') + 1]
    assert mount.endswith(',dst=/backup,readonly')
    source = mount.split('src=', 1)[1].split(',dst=', 1)[0]
    script = sys.stdin.read().replace("'/backup'", json.dumps(source))
    result = subprocess.run([os.environ['BACKUP_TEST_NODE'], '--input-type=module', '-', args[-1]],
                            input=script, text=True, cwd=os.environ['BACKUP_TEST_REPO'])
    sys.exit(result.returncode)
elif args[0] == 'rm':
    assert args[-1].startswith('iva-backup-check-'), 'must not remove an application'
else:
    raise AssertionError('Unexpected Docker action: ' + repr(args))
'''


@unittest.skipUnless(shutil.which('timeout'), 'The Linux VPS script requires GNU timeout')
class BackupTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix='iva-backup-test-')
        self.root = pathlib.Path(self.work.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.source = self.root / 'source'
        self.source.mkdir()
        self.destination = self.root / 'backup'
        self.connections = []
        for name in ('platform.sqlite', 'platform-lab.sqlite'):
            db = sqlite3.connect(self.source / name)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA wal_autocheckpoint=0')
            db.execute('CREATE TABLE durable (value TEXT NOT NULL)')
            db.execute("INSERT INTO durable VALUES ('committed')")
            db.commit()
            db.execute("INSERT INTO durable VALUES ('not committed')")
            self.connections.append(db)
        shutil.copy2(HERE / 'backup.sh', self.root / 'backup.sh')
        (self.root / 'compose.sh').write_text('#!/usr/bin/env bash\n[[ "$*" == "ps --all --quiet platform" ]] || exit 1\nprintf "original-platform-container\\n"\n')
        (self.root / 'compose.sh').chmod(0o700)
        (self.bin / 'docker').write_text(FAKE_DOCKER)
        (self.bin / 'docker').chmod(0o700)
        (self.root / 'state.json').write_text(json.dumps({'running': True, 'paused': False}))
        self.env = {**os.environ, 'PATH': f'{self.bin}{os.pathsep}{os.environ["PATH"]}',
                    'BACKUP_TEST_ROOT': str(self.root), 'BACKUP_TEST_REPO': str(REPO),
                    'BACKUP_TEST_NODE': shutil.which('node') or 'node'}

    def tearDown(self):
        for db in self.connections:
            db.close()
        self.work.cleanup()

    def run_backup(self, fault='', service='platform'):
        return subprocess.run(['bash', str(self.root / 'backup.sh'), service, str(self.destination)],
                              env={**self.env, 'BACKUP_TEST_FAULT': fault}, capture_output=True,
                              text=True, timeout=15)

    def state(self):
        return json.loads((self.root / 'state.json').read_text())

    def commands(self):
        return [json.loads(line) for line in (self.root / 'commands.jsonl').read_text().splitlines()]

    def test_wal_snapshot_keeps_committed_data_and_never_stops_either_service(self):
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.destination / 'INCOMPLETE').exists())
        self.assertEqual(self.state(), {'running': True, 'paused': False})
        commands = self.commands()
        actions = [row[0] for row in commands]
        self.assertLess(actions.index('pause'), actions.index('cp'))
        self.assertLess(actions.index('unpause'), actions.index('run'))
        self.assertFalse(set(actions) & {'stop', 'start', 'restart', 'kill'})
        self.assertNotIn('chess', json.dumps(commands))
        self.assertIn('2 SQLite databases passed quick_check.', result.stdout)
        # Read another disposable copy, never checkpoint the saved backup itself.
        restored = self.root / 'restore-test'
        shutil.copytree(self.destination / 'data', restored)
        for name in ('platform.sqlite', 'platform-lab.sqlite'):
            self.assertTrue((self.destination / 'data' / f'{name}-wal').exists())
            with sqlite3.connect(restored / name) as db:
                self.assertEqual(db.execute('SELECT value FROM durable').fetchall(), [('committed',)])

    def test_chess_backup_checks_colossus_and_preserves_all_three_wal_databases(self):
        for db in self.connections:
            db.close()
        self.connections = []
        shutil.rmtree(self.source)
        self.source.mkdir()
        for name in ('remorse.sqlite', 'overdrive.sqlite', 'colossus.sqlite'):
            db = sqlite3.connect(self.source / name)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA wal_autocheckpoint=0')
            db.execute('CREATE TABLE durable (value TEXT NOT NULL)')
            db.execute("INSERT INTO durable VALUES ('committed')")
            db.commit()
            self.connections.append(db)
        (self.root / 'compose.sh').write_text('#!/usr/bin/env bash\n[[ "$*" == "ps --all --quiet chess" ]] || exit 1\nprintf "original-chess-container\\n"\n')
        result = self.run_backup(service='chess')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('3 SQLite databases passed quick_check.', result.stdout)
        restored = self.root / 'restore-three'
        shutil.copytree(self.destination / 'data', restored)
        for name in ('remorse.sqlite', 'overdrive.sqlite', 'colossus.sqlite'):
            with sqlite3.connect(restored / name) as db:
                self.assertEqual(db.execute('SELECT value FROM durable').fetchall(), [('committed',)])

    def realtime_source(self):
        for db in self.connections:
            db.close()
        self.connections = []
        shutil.rmtree(self.source)
        self.source.mkdir()
        code = b'export const archivedFixture = true;\n'
        artifact = hashlib.sha256(b'simulation-worker.js\0' + code + b'\0').hexdigest()
        directory = self.source / 'runtime-artifacts' / artifact
        directory.mkdir(parents=True)
        (directory / 'simulation-worker.js').write_bytes(code)
        (directory / 'manifest.json').write_text(json.dumps({'protocol': 'iva-worker@1', 'sha256': artifact,
            'createdAt': 1, 'files': [{'path': 'simulation-worker.js', 'sha256': hashlib.sha256(code).hexdigest()}]}))
        db = sqlite3.connect(self.source / 'realtime.sqlite')
        db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA wal_autocheckpoint=0')
        db.execute('CREATE TABLE rt_matches(manifest TEXT NOT NULL)')
        db.execute('INSERT INTO rt_matches VALUES (?)', (json.dumps({'runtimeArtifactId': 'fixture@1:' + artifact}),))
        db.commit(); self.connections.append(db)
        (self.root / 'compose.sh').write_text('#!/usr/bin/env bash\n[[ "$*" == "ps --all --quiet realtime" ]] || exit 1\nprintf "original-realtime-container\\n"\n')
        return directory

    def test_realtime_backup_preserves_sqlite_wal_and_exact_referenced_code(self):
        directory = self.realtime_source()
        result = self.run_backup(service='realtime')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('1 referenced runtime archives passed SHA256 verification.', result.stdout)
        self.assertTrue((self.destination / 'data/realtime.sqlite-wal').exists())
        restored = self.destination / 'data' / directory.relative_to(self.source) / 'simulation-worker.js'
        self.assertEqual(restored.read_bytes(), (directory / 'simulation-worker.js').read_bytes())
        self.assertFalse(self.state()['paused'])

    def test_corrupt_referenced_runtime_archive_rejects_backup_after_thaw(self):
        directory = self.realtime_source()
        (directory / 'simulation-worker.js').write_text('corrupt fixture')
        result = self.run_backup(service='realtime')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.destination / 'INCOMPLETE').exists())
        self.assertFalse(self.state()['paused'])

    def client_source(self):
        self.realtime_source()
        meta = {'gameId': 'tyaga', 'route': '/play/tyaga/', 'rulesVersion': 'tyaga@0.1', 'contentVersion': 'content@1'}
        files = {'assets/model.glb': b'fixture-model-bytes', 'index.html': b'<script src="./assets/client.js"></script>', 'assets/client.js': b'export const oldVersion = true;'}
        ordered = sorted(files)
        digest = hashlib.sha256(json.dumps(meta, sort_keys=True, separators=(',', ':')).encode() + b'\0')
        for path in ordered:
            digest.update(path.encode() + b'\0' + files[path] + b'\0')
        identity = digest.hexdigest()
        directory = self.source / 'client-artifacts' / identity
        for path, content in files.items():
            target = directory / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(content)
        (directory / '.iva-client-manifest.json').write_text(json.dumps({**meta, 'schema': 1, 'sha256': identity, 'createdAt': 1,
            'files': [{'path': path, 'sha256': hashlib.sha256(files[path]).hexdigest()} for path in ordered]}))
        db = self.connections[0]
        manifest = json.loads(db.execute('SELECT manifest FROM rt_matches').fetchone()[0])
        manifest.update(gameId='tyaga', rulesVersion=meta['rulesVersion'], contentVersion=meta['contentVersion'],
                        clientContentHash=identity, clientRoute=f'/play/tyaga/versions/{identity}/')
        db.execute('UPDATE rt_matches SET manifest=?', (json.dumps(manifest),)); db.commit()
        return directory

    def test_realtime_backup_preserves_all_referenced_browser_bytes(self):
        directory = self.client_source()
        result = self.run_backup(service='realtime')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('1 referenced browser archives passed SHA256 verification.', result.stdout)
        saved = self.destination / 'data' / directory.relative_to(self.source)
        self.assertEqual((saved / 'assets/model.glb').read_bytes(), (directory / 'assets/model.glb').read_bytes())
        self.assertFalse(self.state()['paused'])

    def test_changed_browser_asset_rejects_backup_after_thaw(self):
        directory = self.client_source()
        (directory / 'assets/model.glb').write_bytes(b'replaced by newer build')
        result = self.run_backup(service='realtime')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.destination / 'INCOMPLETE').exists())
        self.assertFalse(self.state()['paused'])

    def test_missing_browser_archive_rejects_backup_after_thaw(self):
        directory = self.client_source()
        shutil.rmtree(directory)
        result = self.run_backup(service='realtime')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.destination / 'INCOMPLETE').exists())
        self.assertFalse(self.state()['paused'])

    def test_copy_failure_thaws_and_retains_incomplete_marker(self):
        result = self.run_backup('copy')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state(), {'running': True, 'paused': False})
        self.assertTrue((self.destination / 'INCOMPLETE').exists())
        self.assertNotIn('run', [row[0] for row in self.commands()])

    def test_lost_pause_reply_still_thaws(self):
        result = self.run_backup('pause_reply_lost')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.state()['paused'])
        self.assertTrue((self.destination / 'INCOMPLETE').exists())

    def test_failed_unpause_gets_cleanup_retry_without_approving_backup(self):
        result = self.run_backup('unpause_once')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.state()['paused'])
        self.assertEqual([row[0] for row in self.commands()].count('unpause'), 2)
        self.assertTrue((self.destination / 'INCOMPLETE').exists())

    def test_invalid_sqlite_rejects_backup_after_resuming_application(self):
        # Both sources are required; a missing database must not become an empty one.
        (self.source / 'platform-lab.sqlite').unlink()
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.state()['paused'])
        self.assertTrue((self.destination / 'INCOMPLETE').exists())
        self.assertEqual(self.commands()[-1][0], 'rm')

    def test_already_paused_container_is_not_taken_over(self):
        (self.root / 'state.json').write_text(json.dumps({'running': True, 'paused': True}))
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.state()['paused'])
        self.assertFalse(self.destination.exists())
        self.assertEqual([row[0] for row in self.commands()], ['inspect'])

    def test_stopped_container_is_preserved_without_starting_it(self):
        (self.root / 'state.json').write_text(json.dumps({'running': False, 'paused': False}))
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state(), {'running': False, 'paused': False})
        self.assertFalse(set(row[0] for row in self.commands()) & {'pause', 'unpause', 'start', 'stop'})

    def test_process_group_term_during_copy_runs_thaw_cleanup(self):
        child = subprocess.Popen(['bash', str(self.root / 'backup.sh'), 'platform', str(self.destination)],
                                 env={**self.env, 'BACKUP_TEST_FAULT': 'signal'}, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            limit = time.monotonic() + 5
            while not (self.root / 'copy-waiting').exists():
                if child.poll() is not None or time.monotonic() > limit:
                    self.fail('Copy never reached the interruption point')
                time.sleep(0.01)
            os.killpg(child.pid, signal.SIGTERM)
            child.communicate(timeout=10)
            self.assertNotEqual(child.returncode, 0)
            self.assertFalse(self.state()['paused'])
            self.assertTrue((self.destination / 'INCOMPLETE').exists())
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate(timeout=3)


if __name__ == '__main__':
    unittest.main()
