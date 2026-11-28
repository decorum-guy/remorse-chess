import json
import unittest
from unittest.mock import patch
import activation


class RealtimePreflightTest(unittest.TestCase):
    revision = 'a' * 40
    image = 'ghcr.io/decorum-guy/iva-games-realtime@sha256:' + 'b' * 64

    def setUp(self):
        self.release = {'services': {'realtime': {'image': self.image, 'sha': self.revision}}}
        self.calls = []
        self.containers = 'existing-realtime'
        self.volume_exists = True
        self.mounted_volume = 'actual-realtime-data'
        self.labels_revision = self.revision
        self.run_fails = False

    def compose(self, _release, *args, **_options):
        if args == ('config', '--format', 'json'):
            return json.dumps({'volumes': {'realtime-data': {'external': True, 'name': 'actual-realtime-data'}}})
        if args == ('ps', '--all', '--quiet', 'realtime'): return self.containers
        self.fail(f'Unexpected compose operation {args}')

    def command(self, *args, **_options):
        self.calls.append(args)
        if args[1:3] == ('image', 'inspect'):
            return json.dumps({'org.opencontainers.image.source': 'https://github.com/decorum-guy/iva-games', 'org.opencontainers.image.revision': self.labels_revision})
        if args[1:3] == ('volume', 'inspect'): return 'actual-realtime-data' if self.volume_exists else ''
        if args[1] == 'inspect': return json.dumps([{'Destination': '/data', 'Type': 'volume', 'Name': self.mounted_volume}])
        if args[1] == 'run':
            if self.run_fails: raise RuntimeError('docker run failed')
            return json.dumps({'ok': True, 'operation': 'check-store', 'buildRevision': self.revision, 'bundleSeal': 'sha256:' + 'c' * 64})
        if args[1:3] == ('rm', '--force'): return ''
        self.fail(f'Unexpected command {args}')

    def invoke(self, allow_empty=False):
        with patch.object(activation, 'compose', side_effect=self.compose), patch.object(activation, 'command', side_effect=self.command):
            return activation.realtime_preflight(self.release, self.release, allow_empty)

    def test_checks_actual_mount_with_network_none_and_readonly_volume(self):
        self.assertTrue(self.invoke()['ok'])
        run = next(call for call in self.calls if call[1] == 'run')
        self.assertEqual(run[run.index('--network') + 1], 'none')
        self.assertIn('--read-only', run)
        self.assertEqual(run[run.index('--mount') + 1], 'type=volume,src=actual-realtime-data,dst=/data,readonly,volume-nocopy')
        self.assertEqual(run[run.index('--entrypoint') + 1], 'node')
        self.assertIn('/app/dist-realtime/retention-cli.js', run)
        self.assertIn('check-store', run)
        self.assertNotIn('--allow-empty-store', run)
        self.assertEqual(self.calls[-1][1:3], ('rm', '--force'))
        self.assertEqual(self.calls[-1][-1], run[run.index('--name') + 1])

    def test_missing_or_mismatched_volume_never_starts_a_verifier_on_an_empty_substitute(self):
        for failure in ('missing', 'different'):
            self.calls = []; self.volume_exists = failure != 'missing'
            self.mounted_volume = 'wrong-new-volume' if failure == 'different' else 'actual-realtime-data'
            with self.subTest(failure=failure), self.assertRaises(RuntimeError): self.invoke()
            self.assertFalse(any(call[1] == 'run' for call in self.calls))

    def test_labels_must_match_the_immutable_candidate(self):
        self.labels_revision = 'd' * 40
        with self.assertRaisesRegex(RuntimeError, 'labels differ'): self.invoke()
        self.assertFalse(any(call[1] == 'run' for call in self.calls))

    def test_first_provisioning_still_runs_the_real_cli_and_is_explicit(self):
        self.containers = ''
        with self.assertRaisesRegex(RuntimeError, 'existing realtime data mount'): self.invoke()
        self.calls = []
        self.assertTrue(self.invoke(allow_empty=True)['ok'])
        run = next(call for call in self.calls if call[1] == 'run')
        self.assertIn('--allow-empty-store', run)
        self.assertIn('type=volume,src=actual-realtime-data,dst=/data,readonly,volume-nocopy', run)

    def test_failed_verifier_is_removed_without_touching_the_service_or_database(self):
        self.run_fails = True
        with self.assertRaisesRegex(RuntimeError, 'docker run failed'): self.invoke()
        self.assertEqual(self.calls[-1][1:3], ('rm', '--force'))
        self.assertTrue(self.calls[-1][-1].startswith('iva-realtime-preflight-'))
        self.assertNotIn('existing-realtime', self.calls[-1])
        self.assertFalse(any(call[1] in ('stop', 'restart', 'cp') for call in self.calls))


if __name__ == '__main__':
    unittest.main()
