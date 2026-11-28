import copy
from email.message import Message
import fcntl
import io
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import sys
import textwrap
import time
import unittest
import urllib.error
from unittest.mock import patch

import activation


class ActivationTest(unittest.TestCase):
    ip = '78.137.109.13'

    def test_two_resolvers_both_domains_and_ipv6(self):
        for mode in ('old', 'one', 'wrong_aaaa', 'mixed', 'resolver_error', 'ready'):
            def records(resolver, domain, kind):
                if kind == 'AAAA':
                    return {'2001:4860::2'} if mode == 'wrong_aaaa' else set()
                if mode == 'resolver_error' and resolver == '1.1.1.1':
                    raise RuntimeError('SERVFAIL')
                if mode == 'old' or (mode == 'one' and domain == activation.DOMAINS[1]):
                    return {'192.0.2.1'}
                return {self.ip, '192.0.2.1'} if mode == 'mixed' else {self.ip}
            with self.subTest(mode=mode), patch.object(activation, 'command', return_value='[]'), (
                patch.object(activation, 'dns_records', side_effect=records)
            ):
                _, result = activation.dns_sample(self.ip)
                self.assertEqual(result is not None, mode == 'ready')

    def test_chain_checks_terminal_records(self):
        response = """;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1
chess.iva-games.pro. 60 IN CNAME iva-games.pro.
unrelated.example. 60 IN A 192.0.2.1
iva-games.pro. 60 IN A 78.137.109.13"""
        with patch.object(activation, 'command', return_value=response):
            self.assertEqual(activation.dns_records('1.1.1.1', 'chess.iva-games.pro', 'A'), {self.ip})

    def test_interrupted_success_resets_counter(self):
        with tempfile.TemporaryDirectory() as work, patch.object(activation, 'STATE', pathlib.Path(work)):
            answers = {'iva-games.pro': [], 'chess.iva-games.pro': []}
            with patch.object(activation, 'dns_sample', side_effect=[
                ({}, answers), ({}, None), ({}, answers), ({}, answers),
            ]):
                self.assertEqual([activation.dns_readiness(self.ip)['consecutive'] for _ in range(4)],
                                 [1, 0, 1, 2])

    def test_missing_smtp_keeps_sites_closed_even_when_dns_is_ready(self):
        with tempfile.TemporaryDirectory() as work, patch.object(activation, 'STATE', pathlib.Path(work)), (
            patch.object(activation, 'CONFIG', pathlib.Path(work))
        ), patch.object(activation, 'dns_readiness', return_value={'consecutive': 2}), (
            patch.object(activation, 'compose')
        ) as compose:
            activation.save(activation.CONFIG / 'activation.json', {'ipv4': self.ip})
            activation.activate()
            self.assertEqual(activation.load(activation.STATE / 'state.json')['status'], 'WAITING_CONFIG')
            compose.assert_not_called()

    def test_telegram_mode_waits_only_for_dns_before_public_start(self):
        with tempfile.TemporaryDirectory() as work, patch.object(activation, 'STATE', pathlib.Path(work)), (
            patch.object(activation, 'CONFIG', pathlib.Path(work))
        ), patch.object(activation, 'dns_readiness', return_value={'consecutive': 0}), (
            patch.object(activation, 'compose')
        ) as compose:
            (activation.CONFIG / 'platform.env').write_text('MAIL_MODE=disabled\nTELEGRAM_AUTH_ENABLED=false\n')
            activation.save(activation.CONFIG / 'activation.json', {'ipv4': self.ip, 'initial_sha': 'approved'})
            activation.save(activation.CONFIG / 'pins.json', {'sha': 'approved'})
            activation.activate()
            self.assertEqual(activation.load(activation.STATE / 'state.json')['status'], 'WAITING_DNS')
            compose.assert_not_called()

    def test_registry_metadata_skips_downloading_unchanged_images(self):
        old = {'sha': 'old', 'inputs': 'a' * 64, 'image': 'retained-chess-digest', 'compatibility': 'f' * 64}
        version = 'b' * 40
        digests = ['sha256:' + 'a' * 64, 'sha256:' + 'b' * 64]
        pulled = []
        def command(*args, **_options):
            if args[1] == 'buildx':
                chess = 'chess' in args[-1]
                if args[-2] == '{{json .Manifest}}':
                    return json.dumps({'digest': digests[0 if chess else 1]})
                return json.dumps({'config': {'Labels': {
                    'org.opencontainers.image.revision': version,
                    'org.opencontainers.image.source': 'https://github.com/decorum-guy/iva-games',
                    'org.iva-games.inputs': ('a' if chess else 'c') * 64,
                    'org.iva-games.compatibility': 'f' * 64,
                }}})
            if args[1] == 'pull':
                pulled.append(args[2])
            return ''
        temporary = tempfile.TemporaryDirectory
        with patch.object(activation, 'command', side_effect=command), patch.object(
            activation.tempfile, 'TemporaryDirectory', side_effect=lambda **_: temporary(),
        ):
            release = activation.pull_release(version, digests, 'fixture_token', {'services': {'chess': old}})
        self.assertEqual(release['services']['chess'], old)
        self.assertEqual(pulled, [release['services']['platform']['image']])

    def test_registry_provenance_and_fingerprints_are_required_before_reuse(self):
        version = 'b' * 40
        digest = 'sha256:' + 'c' * 64
        valid = {
            'org.opencontainers.image.revision': version,
            'org.opencontainers.image.source': 'https://github.com/decorum-guy/iva-games',
            'org.iva-games.inputs': 'a' * 64, 'org.iva-games.compatibility': 'f' * 64,
        }
        temporary = tempfile.TemporaryDirectory
        for changed in ('digest', *valid):
            labels = dict(valid)
            if changed != 'digest':
                labels[changed] = 'invalid'
            def command(*args, **_options):
                if args[1] == 'buildx':
                    if args[-2] == '{{json .Manifest}}':
                        return json.dumps({'digest': 'wrong' if changed == 'digest' else digest})
                    return json.dumps({'config': {'Labels': labels}})
                if args[1] in ('pull', 'image'):
                    self.fail('Unverified registry metadata reached image pull/reuse')
                return ''
            with self.subTest(field=changed), patch.object(activation, 'command', side_effect=command), (
                patch.object(activation.tempfile, 'TemporaryDirectory', side_effect=lambda **_: temporary())
            ), self.assertRaises(RuntimeError):
                activation.pull_release(version, [digest, digest], 'fixture_token', {'services': {
                    'chess': {'image': 'old', 'inputs': 'a' * 64, 'compatibility': 'f' * 64},
                }})

    def test_waiting_tls_and_active_dont_restart_caddy(self):
        with tempfile.TemporaryDirectory() as work, patch.object(activation, 'STATE', pathlib.Path(work)), (
            patch.object(activation, 'CONFIG', pathlib.Path(work))
        ), patch.object(activation, 'dns_readiness', return_value={'consecutive': 2}), (
            patch.object(activation, 'mail_verification_settings', return_value=None)
        ), patch.object(activation, 'running', return_value=True), (
            patch.object(activation, 'public_health', side_effect=[False, True])
        ), patch.object(activation, 'command') as commands, patch.object(activation, 'up') as up:
            activation.save(activation.CONFIG / 'activation.json', {'ipv4': self.ip, 'initial_sha': 'test'})
            activation.save(activation.CONFIG / 'pins.json', {'sha': 'test'})
            activation.activate()
            self.assertEqual(activation.load(activation.STATE / 'state.json')['status'], 'WAITING_TLS')
            activation.activate()
            activation.activate()
            self.assertEqual(activation.load(activation.STATE / 'state.json')['status'], 'ACTIVE')
            self.assertEqual(commands.call_count, 2)
            up.assert_not_called()

    def test_initial_start_failure_resumes_an_existing_drained_realtime(self):
        with tempfile.TemporaryDirectory() as work, patch.object(activation, 'STATE', pathlib.Path(work)), (
            patch.object(activation, 'CONFIG', pathlib.Path(work))
        ), patch.object(activation, 'dns_readiness', return_value={'consecutive': 2}), (
            patch.object(activation, 'mail_verification_settings', return_value=None)
        ), patch.object(activation, 'running', side_effect=lambda _release, service: service == 'realtime'), (
            patch.object(activation, 'compose')
        ) as compose, patch.object(activation, 'realtime_preflight') as preflight, (
            patch.object(activation, 'up', side_effect=RuntimeError('initial startup failed'))
        ):
            release = {'sha': 'test', 'services': {'realtime': {'image': 'fixture-image'}}}
            activation.save(activation.CONFIG / 'activation.json', {'ipv4': self.ip, 'initial_sha': 'test'})
            activation.save(activation.CONFIG / 'pins.json', release)
            with self.assertRaisesRegex(RuntimeError, 'initial startup failed'):
                activation.activate()
            preflight.assert_called_once_with(release, release, allow_empty=False)
            operations = [call.args[-1] for call in compose.call_args_list]
            self.assertEqual(operations, ['--quiet', 'drain', 'resume'])


def response(payload, url='https://api.github.com/repos/decorum-guy/iva-games/branches/main'):
    result = io.BytesIO(json.dumps(payload).encode())
    result.url = url
    result.headers = Message()
    result.headers['Content-Type'] = 'application/json'
    return result


class GitHubEvidenceTest(unittest.TestCase):
    token = 'fixture_secret_do_not_print'
    sha = 'a' * 40

    def test_authenticated_request_has_fixed_origin_and_no_token_in_url(self):
        with patch.object(activation.GITHUB_OPENER, 'open', return_value=response({'commit': {'sha': self.sha}})) as opened:
            self.assertEqual(activation.github_json('branches/main', self.token)['commit']['sha'], self.sha)
        request = opened.call_args.args[0]
        self.assertEqual(request.get_header('Authorization'), f'Bearer {self.token}')
        self.assertEqual(request.full_url, 'https://api.github.com/repos/decorum-guy/iva-games/branches/main')

    def test_bare_403_fails_once_and_retains_safe_diagnostics(self):
        failure = urllib.error.HTTPError('https://api.github.com/', 403, 'forbidden',
            {'x-github-request-id': 'ABC:123', 'x-ratelimit-remaining': '10'}, io.BytesIO(self.token.encode()))
        with patch.object(activation.GITHUB_OPENER, 'open', side_effect=failure) as opened, (
            patch.object(activation.time, 'sleep')
        ) as sleep:
            with self.assertRaisesRegex(RuntimeError, 'HTTP 403.*request-id=ABC:123') as raised:
                activation.github_json('branches/main', self.token)
        self.assertNotIn(self.token, str(raised.exception))
        self.assertEqual(opened.call_count, 1)
        sleep.assert_not_called()

    def test_bounded_rate_limit_retry_and_no_anonymous_fallback(self):
        failure = urllib.error.HTTPError('https://api.github.com/', 403, 'rate limited', {'retry-after': '2'}, None)
        with patch.object(activation.GITHUB_OPENER, 'open', side_effect=[failure, response({'ok': True})]) as opened, (
            patch.object(activation.time, 'sleep')
        ) as sleep:
            self.assertTrue(activation.github_json('branches/main', self.token)['ok'])
        sleep.assert_called_once_with(2)
        self.assertTrue(all(call.args[0].get_header('Authorization') == f'Bearer {self.token}'
                            for call in opened.call_args_list))

    def test_long_rate_limit_fails_without_early_retry(self):
        failure = urllib.error.HTTPError('https://api.github.com/', 429, 'rate limited', {'retry-after': '600'}, None)
        with patch.object(activation.GITHUB_OPENER, 'open', side_effect=failure), (
            patch.object(activation.time, 'sleep')
        ) as sleep:
            with self.assertRaisesRegex(RuntimeError, 'HTTP 429'):
                activation.github_json('branches/main', self.token)
        sleep.assert_not_called()

    def test_empty_token_and_redirects_fail_before_anonymous_or_redirected_io(self):
        with patch.object(activation.GITHUB_OPENER, 'open') as opened:
            with self.assertRaisesRegex(RuntimeError, 'token'):
                activation.github_json('branches/main', '')
        opened.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'redirect refused'):
            activation.RefuseRedirects().redirect_request(None, None, 302, '', {}, 'https://untrusted.invalid/')

    def test_main_and_successful_ci_both_require_authenticated_evidence(self):
        with patch.object(activation, 'github_json', side_effect=[{'commit': {'sha': self.sha}},
            {'workflow_runs': [{'head_sha': self.sha, 'conclusion': 'success'}]}]) as api:
            activation.verify_main(self.sha, self.token)
        self.assertEqual(api.call_count, 2)
        self.assertTrue(all(call.args[1] == self.token for call in api.call_args_list))
        with patch.object(activation, 'github_json', return_value={'commit': {'sha': 'b' * 40}}) as api:
            with self.assertRaisesRegex(RuntimeError, 'no longer the head'):
                activation.verify_main(self.sha, self.token)
        self.assertEqual(api.call_count, 1)

    def test_public_health_request_does_not_carry_github_credentials(self):
        url = 'https://iva-games.pro/health/ready'
        with patch.object(activation.OPENER, 'open', return_value=response({'ok': True}, url)) as opened:
            activation.get_json(url)
        self.assertIsNone(opened.call_args.args[0].get_header('Authorization'))


class PromotionIsolationTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        directory = pathlib.Path(self.work.name)
        for name in ('STATE', 'CONFIG'):
            patched = patch.object(activation, name, directory)
            patched.start()
            self.addCleanup(patched.stop)
        self.previous = {'sha': 'a' * 40, 'services': {
            name: {'image': f'{name}-old', 'sha': 'a' * 40, 'inputs': 'a' * 64, 'compatibility': 'f' * 64}
            for name in activation.SERVICES}}
        self.candidate = copy.deepcopy(self.previous)
        self.candidate['sha'] = 'b' * 40
        self.candidate['services']['platform'].update(image='platform-new', sha='b' * 40, inputs='b' * 64)
        activation.save(directory / 'pins.json', self.previous)
        self.mutations = []
        self.backup_fails = False
        self.identity_changed = False
        self.commands = patch.object(activation, 'command', side_effect=self.command)
        self.commands.start()
        self.addCleanup(self.commands.stop)
        self.preflight_patch = patch.object(activation, 'realtime_preflight')
        self.preflight = self.preflight_patch.start()
        self.addCleanup(self.preflight_patch.stop)

    def command(self, *args, **options):
        binary = pathlib.Path(args[0]).name
        if binary == 'backup.sh':
            self.mutations.append(('backup', args[1]))
            self.assertEqual(options['cleanup_timeout'], 25)
            if self.backup_fails:
                raise RuntimeError('backup failed')
            return ''
        if binary == 'compose.sh':
            if args[1] == 'ps':
                return f'{args[-1]}-container'
            if args[1:4] == ('exec', '-T', 'realtime'):
                self.assertEqual(args[4:6], ('node', '/app/scripts/realtime-control.mjs'))
                self.mutations.append(('control', args[-1]))
                return ''
            self.assertEqual(args[1:10], ('up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                                          '--wait', '--wait-timeout', '75'))
            for service in args[10:]:
                self.mutations.append(('up', service, options['env'][service.upper() + '_IMAGE']))
            return ''
        if args[:2] == ('docker', 'inspect'):
            service = args[-1].removesuffix('-container')
            identity = f'{service}-container'
            if self.identity_changed and self.mutations and service == 'chess':
                identity += '-unexpected-replacement'
            return json.dumps([identity, f'{service}-image', 'original-start-time', 0, True, False])
        self.fail(f'Unexpected command: {binary}')

    def test_platform_only_never_backs_up_or_recreates_chess_or_caddy(self):
        with patch.object(activation, 'public_health', return_value=True):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('backup', 'platform'), ('up', 'platform', 'platform-new')])
        self.assertEqual(activation.load(activation.CONFIG / 'pins.json'), self.candidate)
        report = activation.load(activation.STATE / 'last-deploy.json')
        self.assertEqual(report['changed'], ['platform'])
        self.assertEqual(set(report['untouched_before']), {'chess', 'caddy'})
        self.assertEqual(report['untouched_before'], report['untouched_after'])

    def test_platform_health_failure_rolls_back_platform_only(self):
        with patch.object(activation, 'public_health', side_effect=[False, True]):
            with self.assertRaisesRegex(RuntimeError, 'HTTPS health failed'):
                activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('backup', 'platform'), ('up', 'platform', 'platform-new'),
                                         ('up', 'platform', 'platform-old')])
        self.assertEqual(activation.load(activation.CONFIG / 'pins.json'), self.previous)
        self.assertFalse((activation.STATE / 'pending.json').exists())

    def test_backup_failure_does_not_promote_or_touch_other_services(self):
        self.backup_fails = True
        with self.assertRaisesRegex(RuntimeError, 'backup failed'):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('backup', 'platform')])
        self.assertEqual(activation.load(activation.CONFIG / 'pins.json'), self.previous)

    def test_incompatible_failure_is_left_pending_without_unsafe_rollback(self):
        self.candidate['services']['platform']['compatibility'] = 'c' * 64
        with patch.object(activation, 'public_health', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'HTTPS health failed'):
                activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('backup', 'platform'), ('up', 'platform', 'platform-new')])
        self.assertTrue((activation.STATE / 'pending.json').exists())

    def test_unchanged_release_updates_receipt_without_any_mutation(self):
        self.candidate['services'] = copy.deepcopy(self.previous['services'])
        with patch.object(activation, 'public_health', return_value=True):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [])
        self.assertEqual(activation.load(activation.STATE / 'last-deploy.json')['changed'], [])

    def test_untouched_container_replacement_cannot_be_reported_as_success(self):
        self.identity_changed = True
        with patch.object(activation, 'public_health', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'untouched service changed'):
                activation.promote(self.candidate, self.previous)
        self.assertTrue(all(mutation[1] == 'platform' for mutation in self.mutations))
        self.assertEqual(activation.load(activation.CONFIG / 'pins.json'), self.previous)
        self.assertTrue((activation.STATE / 'pending.json').exists())

    def add_realtime(self):
        service = {'image': 'realtime-old', 'sha': 'a' * 40, 'inputs': 'a' * 64, 'compatibility': 'f' * 64}
        self.previous['services']['realtime'] = service
        self.candidate['services']['realtime'] = copy.deepcopy(service)
        activation.save(activation.CONFIG / 'pins.json', self.previous)

    def test_platform_update_drains_and_backs_up_realtime_without_recreating_it(self):
        self.add_realtime()
        with patch.object(activation, 'public_health', return_value=True):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('control', 'drain'), ('backup', 'platform'), ('backup', 'realtime'),
                                         ('up', 'platform', 'platform-new'), ('control', 'resume')])
        report = activation.load(activation.STATE / 'last-deploy.json')
        self.assertEqual(set(report['untouched_before']), {'chess', 'realtime', 'caddy'})
        self.assertEqual(report['untouched_before'], report['untouched_after'])

    def test_realtime_update_preserves_both_other_images_and_backs_up_admission_state(self):
        self.add_realtime()
        self.candidate['services']['platform'] = copy.deepcopy(self.previous['services']['platform'])
        self.candidate['services']['realtime']['image'] = 'realtime-new'
        with patch.object(activation, 'public_health', return_value=True):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('control', 'drain'), ('backup', 'platform'), ('backup', 'realtime'),
                                         ('up', 'realtime', 'realtime-new')])

    def test_realtime_is_resumed_if_the_backup_fails_before_promotion(self):
        self.add_realtime()
        self.backup_fails = True
        with self.assertRaisesRegex(RuntimeError, 'backup failed'):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('control', 'drain'), ('backup', 'platform'), ('control', 'resume')])
        self.assertEqual(activation.load(activation.CONFIG / 'pins.json'), self.previous)

    def test_failed_platform_start_resumes_unchanged_realtime_after_compatible_rollback(self):
        self.add_realtime()
        def command(*args, **options):
            result = self.command(*args, **options)
            if pathlib.Path(args[0]).name == 'compose.sh' and args[1] == 'up' and options['env'].get('PLATFORM_IMAGE') == 'platform-new':
                raise RuntimeError('candidate failed')
            return result
        with patch.object(activation, 'command', side_effect=command), patch.object(activation, 'public_health', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'candidate failed'):
                activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations[-2:], [('up', 'platform', 'platform-old'), ('control', 'resume')])
        self.assertFalse((activation.STATE / 'pending.json').exists())

    def test_first_realtime_release_does_not_back_up_a_nonexistent_service(self):
        self.candidate['services']['realtime'] = {'image': 'realtime-first', 'sha': 'b' * 40, 'inputs': 'b' * 64, 'compatibility': 'f' * 64}
        with patch.object(activation, 'public_health', return_value=True):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('backup', 'platform'), ('up', 'platform', 'platform-new'), ('up', 'realtime', 'realtime-first')])
        self.preflight.assert_called_once_with(self.candidate, self.candidate, allow_empty=True)

    def test_candidate_preflight_runs_after_drain_and_failure_resumes_old_without_promotion(self):
        self.add_realtime()
        self.candidate['services']['realtime']['image'] = 'realtime-new'
        def preflight(*_args, **_options):
            self.assertEqual(self.mutations, [('control', 'drain')])
            raise RuntimeError('required retained version missing')
        self.preflight.side_effect = preflight
        with self.assertRaisesRegex(RuntimeError, 'retained version missing'):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('control', 'drain'), ('control', 'resume')])
        self.assertFalse((activation.STATE / 'pending.json').exists())
        self.assertEqual(activation.load(activation.CONFIG / 'pins.json'), self.previous)

    def test_incomplete_drain_is_cancelled_before_preflight_or_backup(self):
        self.add_realtime(); self.candidate['services']['realtime']['image'] = 'realtime-new'
        def command(*args, **options):
            result = self.command(*args, **options)
            if args[-1] == 'drain': raise RuntimeError('drain incomplete')
            return result
        with patch.object(activation, 'command', side_effect=command), self.assertRaisesRegex(RuntimeError, 'drain incomplete'):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.mutations, [('control', 'drain'), ('control', 'resume')])
        self.preflight.assert_not_called()

    def test_rollback_checks_actual_postcandidate_store_and_does_not_restore_old_database(self):
        self.add_realtime()
        self.candidate['services']['platform'] = copy.deepcopy(self.previous['services']['platform'])
        self.candidate['services']['realtime']['image'] = 'realtime-new'
        self.preflight.side_effect = [None, RuntimeError('old image lacks newly saved runtime')]
        with patch.object(activation, 'public_health', return_value=False), self.assertRaisesRegex(RuntimeError, 'newly saved runtime'):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.preflight.call_args.args, (self.previous, self.candidate))
        self.assertEqual([m for m in self.mutations if m[0] == 'up'], [('up', 'realtime', 'realtime-new')])
        self.assertEqual(self.mutations[-2:], [('control', 'drain'), ('control', 'resume')])
        self.assertTrue((activation.STATE / 'pending.json').exists())

    def test_reader_checked_realtime_rollback_does_not_rely_on_source_fingerprint_equality(self):
        self.add_realtime()
        self.candidate['services']['platform'] = copy.deepcopy(self.previous['services']['platform'])
        self.candidate['services']['realtime'].update(image='realtime-new', compatibility='b' * 64)
        with patch.object(activation, 'public_health', side_effect=[False, True]), self.assertRaisesRegex(RuntimeError, 'HTTPS health failed'):
            activation.promote(self.candidate, self.previous)
        self.assertEqual(self.preflight.call_count, 2)
        self.assertEqual(self.preflight.call_args.args, (self.previous, self.candidate))
        self.assertEqual([m for m in self.mutations if m[0] == 'up'], [('up', 'realtime', 'realtime-new'), ('up', 'realtime', 'realtime-old')])
        self.assertFalse((activation.STATE / 'pending.json').exists())

    def test_new_image_count_requires_explicit_existing_host_integration(self):
        for enabled, count in ((False, 3), (True, 2)):
            activation.save(activation.CONFIG / 'activation.json', {'realtime_enabled': enabled})
            request = ('a' * 40 + ' ' + ' '.join(['sha256:' + 'b' * 64] * count) + '\nfixture_token\n').encode()
            stdin = type('Input', (), {'buffer': io.BytesIO(request)})()
            with self.subTest(enabled=enabled), patch.object(activation.sys, 'stdin', stdin), patch.object(activation, 'verify_main') as verify:
                with self.assertRaisesRegex(RuntimeError, 'host integration'):
                    activation.deploy()
                verify.assert_not_called()


class BackupTimeoutTest(unittest.TestCase):
    def test_timeout_sends_term_and_waits_for_real_child_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / 'cleaned'
            child = ('import signal,sys,time; from pathlib import Path; '
                     'signal.signal(signal.SIGTERM, lambda *_: (Path(sys.argv[1]).write_text("thawed"), sys.exit(0))); '
                     'time.sleep(60)')
            with self.assertRaisesRegex(RuntimeError, 'failed'):
                activation.command(sys.executable, '-c', child, str(marker), timeout=1, cleanup_timeout=3)
            self.assertEqual(marker.read_text(), 'thawed')

    def start_activation_fixture(self, directory, cleanup_timeout, cooperative=True):
        child = directory / 'backup-child.py'
        child.write_text(textwrap.dedent('''\
            import os, signal, sys, time
            from pathlib import Path
            directory = Path(sys.argv[1])
            def cleanup(_signum, _frame):
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                (directory / 'marker').write_text('cleaning')
                while not (directory / 'allow-cleanup').exists():
                    time.sleep(0.01)
                (directory / 'marker').write_text('thawed')
                sys.exit(0)
            handler = cleanup if sys.argv[2] == 'cooperative' else signal.SIG_IGN
            signal.signal(signal.SIGTERM, handler)
            signal.signal(signal.SIGINT, handler)
            (directory / 'child.pid').write_text(str(os.getpid()))
            (directory / 'marker').write_text('paused')
            time.sleep(60)
        '''))
        parent = directory / 'activation-parent.py'
        parent.write_text(textwrap.dedent('''\
            import sys
            from pathlib import Path
            sys.path.insert(0, sys.argv[1])
            import activation
            directory = Path(sys.argv[2])
            activation.STATE = directory
            activation.CONFIG = directory
            timeout = float(sys.argv[3])
            mode = sys.argv[4]
            # Exercise the real main(), including its actual flock lifetime.
            def deploy_fixture():
                activation.command(sys.executable, str(directory / 'backup-child.py'),
                                   str(directory), mode, timeout=20, cleanup_timeout=timeout)
                (directory / 'incorrect-success').write_text('must not happen')
            activation.deploy = deploy_fixture
            sys.argv = ['activation.py', 'deploy']
            sys.exit(activation.main())
        '''))
        process = subprocess.Popen([sys.executable, '-B', str(parent), str(pathlib.Path(activation.__file__).parent),
                                    str(directory), str(cleanup_timeout), 'cooperative' if cooperative else 'ignore'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        pids = [process.pid]
        self.addCleanup(self.remove_fixture_processes, process, pids)
        try:
            self.wait_for(lambda: (directory / 'marker').exists()
                          and (directory / 'marker').read_text() == 'paused', process)
        finally:
            if (directory / 'child.pid').exists():
                pids.append(int((directory / 'child.pid').read_text()))
        return process

    @staticmethod
    def remove_fixture_processes(process, pids):
        # Test cleanup must also clean the deliberately uncooperative fixture
        # if an assertion fails; never signal anything not started by this test.
        for pid in pids:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.communicate(timeout=5)

    def wait_for(self, predicate, process):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if predicate():
                return
            if process.poll() is not None:
                self.fail(f'Activation exited early: {process.communicate()[1]}')
            time.sleep(0.01)
        self.fail('Fixture did not reach the expected state')

    def assert_lock_held(self, directory):
        with (directory / 'release.lock').open('a') as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def assert_child_reaped_and_lock_released(self, directory):
        with self.assertRaises(ProcessLookupError):
            os.kill(int((directory / 'child.pid').read_text()), 0)
        with (directory / 'release.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertFalse((directory / 'incorrect-success').exists())

    def test_outer_term_and_int_hold_release_lock_until_real_backup_cleanup(self):
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=signum), tempfile.TemporaryDirectory() as work:
                directory = pathlib.Path(work)
                process = self.start_activation_fixture(directory, cleanup_timeout=3)
                os.killpg(process.pid, signum)
                self.wait_for(lambda: (directory / 'marker').read_text() == 'cleaning', process)
                self.assert_lock_held(directory)
                # A subsequent TERM/INT cannot interrupt thaw or free the lock.
                os.killpg(process.pid, signal.SIGTERM)
                os.killpg(process.pid, signal.SIGINT)
                self.assert_lock_held(directory)
                (directory / 'allow-cleanup').write_text('go')
                _, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 1, stderr)
                self.assertEqual((directory / 'marker').read_text(), 'thawed')
                self.assertIn('interrupted after cleanup', stderr)
                self.assert_child_reaped_and_lock_released(directory)

    def test_outer_term_bounds_uncooperative_backup_before_releasing_lock(self):
        with tempfile.TemporaryDirectory() as work:
            directory = pathlib.Path(work)
            process = self.start_activation_fixture(directory, cleanup_timeout=0.4, cooperative=False)
            started = time.monotonic()
            os.killpg(process.pid, signal.SIGTERM)
            self.assert_lock_held(directory)
            _, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 1, stderr)
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual((directory / 'marker').read_text(), 'paused')
            self.assert_child_reaped_and_lock_released(directory)


if __name__ == '__main__':
    unittest.main()
