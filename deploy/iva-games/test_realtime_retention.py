import hashlib
import importlib.util
import io
import json
from email.message import Message
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('retention_prepare', Path(__file__).with_name('prepare-realtime-image.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def response(value, url=None, media='application/json'):
    stream = io.BytesIO(value if isinstance(value, bytes) else json.dumps(value).encode())
    stream.geturl = lambda: url or prepare.INVENTORY_URL
    stream.status = 200
    stream.headers = Message(); stream.headers['Content-Type'] = media
    return stream


# Exact public shell observed independently at all three legacy fallback URLs.
# This fixture is not a claimed runtime or an invented inventory.
LEGACY_PORTAL = '''<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#173744" />
    <meta name="referrer" content="no-referrer" />
    <meta name="description" content="Iva Games — игры, друзья и общий стол." />
    <title>Iva Games</title>
    <script type="module" crossorigin src="/assets/index-gq6eTcFQ.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-BhwHI1bQ.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
'''.encode()


def legacy_catalogue():
    return {'games': [{'gameId': game_id, 'collectionId': values[0], 'status': values[1], 'rulesVersion': values[2], 'contentVersion': values[3],
                       'title': game_id, 'minPlayers': 2, 'maxPlayers': 6, 'supportsBots': game_id in ('platform-lab', 'district')}
                      for game_id, values in prepare.LEGACY_GAMES.items()]}


def legacy_opener(overrides=None, inventory_status=200):
    known = {prepare.INVENTORY_URL: (LEGACY_PORTAL, 'text/html'), prepare.PORTAL_URL: (LEGACY_PORTAL, 'text/html'),
             prepare.REALTIME_HEALTH_URL: (LEGACY_PORTAL, 'text/html'),
             prepare.PLATFORM_HEALTH_URL: ({'ok': True, 'service': 'iva-platform'}, 'application/json'),
             prepare.CATALOGUE_URL: (legacy_catalogue(), 'application/json')}
    if inventory_status != 200:
        known[prepare.INVENTORY_URL] = urllib.error.HTTPError(prepare.INVENTORY_URL, inventory_status, 'fixture', {}, None)
    known.update(overrides or {})
    def open_response(request, timeout):
        if timeout != 15 or request.get_header('Authorization') is not None:
            raise AssertionError('Only bounded unauthenticated public GETs are allowed')
        value = known[request.full_url]
        if isinstance(value, Exception): raise value
        return response(value[0], request.full_url, value[1])
    opener = Mock(); opener.open.side_effect = open_response
    return opener


def digest(character):
    return 'sha256:' + character * 64


def manifest(runtime, client):
    return {'runtime': runtime, 'client': client, 'rules': 'forpost-0.1', 'content': 'forpost-content-1',
            'protocol': '1', 'serializer': 'forpost-world-1', 'bot': 'forpost-bot-0.1', 'map': 'forpost-maps-0.1',
            'physics': 'forpost-kinematic-1', 'prng': 'xorshift32-1'}


class RetentionPreparationTest(unittest.TestCase):
    revision = 'b' * 40

    def inventory(self):
        return {'format': 1, 'buildRevision': self.revision, 'current': {'runtime': digest('b'), 'client': digest('e')},
                'manifests': [manifest(digest('a'), digest('d'))]}

    def bundle(self):
        body = {'format': 1, 'buildRevision': self.revision, 'current': self.inventory()['current'],
                'artifacts': [digest('a'), digest('b')], 'clients': [digest('d'), digest('e')],
                'readers': {'format': 1, 'store': {'id': 'realtime-sqlite-record-1', 'userVersions': [0]}, 'profiles': []}}
        return {**body, 'seal': 'sha256:' + hashlib.sha256(prepare.canonical(body).encode()).hexdigest()}

    def docker(self, calls, bundle=None, invalid_labels=False):
        labels = {'org.opencontainers.image.source': prepare.SOURCE, 'org.opencontainers.image.revision': self.revision}
        if invalid_labels: labels['org.opencontainers.image.source'] = 'https://untrusted.invalid/repo'
        def run(*args):
            calls.append(args)
            if args[1:3] == ('buildx', 'imagetools'):
                return json.dumps({'digest': digest('f')} if args[-2] == '{{json .Manifest}}' else {'config': {'Labels': labels}})
            if args[1:3] == ('image', 'inspect'): return json.dumps(labels)
            if args[1] == 'cp': (Path(args[-1]) / 'bundle.json').write_text(json.dumps(bundle or self.bundle()))
            return ''
        return run

    def test_404_requires_positive_legacy_proof_before_bootstrap_and_keeps_final_host_gate(self):
        opener = legacy_opener(inventory_status=404)
        docker = Mock()
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'input'
            result = prepare.prepare(target, opener, docker)
            self.assertTrue(result['bootstrap']); self.assertTrue(result['hostPreflightRequired'])
            self.assertEqual(result['bootstrapEvidence'], 'recognized-public-legacy-portal-v1')
            self.assertEqual(json.loads((target / 'input.json').read_text()), {'format': 1, 'bootstrap': True, 'inventory': None, 'image': None})
        docker.assert_not_called()

    def test_observed_200_portal_fallback_has_an_explicit_verified_bootstrap_path(self):
        self.assertEqual(len(LEGACY_PORTAL), 598)
        self.assertEqual(hashlib.sha256(LEGACY_PORTAL).hexdigest(), prepare.LEGACY_PORTAL_SHA256)
        opener = legacy_opener(); docker = Mock()
        with tempfile.TemporaryDirectory() as root:
            result = prepare.prepare(Path(root) / 'input', opener, docker)
            self.assertTrue(result['bootstrap']); self.assertTrue(result['hostPreflightRequired'])
        self.assertEqual({call.args[0].full_url for call in opener.open.call_args_list}, {
            prepare.INVENTORY_URL, prepare.PORTAL_URL, prepare.REALTIME_HEALTH_URL, prepare.PLATFORM_HEALTH_URL, prepare.CATALOGUE_URL})
        docker.assert_not_called()

    def test_arbitrary_or_changed_html_is_never_assumed_empty_even_if_all_three_paths_match(self):
        html = LEGACY_PORTAL.replace(b'index-gq6eTcFQ.js', b'index-unknown.js')
        opener = legacy_opener({url: (html, 'text/html') for url in (prepare.INVENTORY_URL, prepare.PORTAL_URL, prepare.REALTIME_HEALTH_URL)})
        with self.assertRaisesRegex(RuntimeError, 'Unrecognized legacy portal'): prepare.fetch_inventory(opener)
        opener = legacy_opener({prepare.INVENTORY_URL: (b'<html>unknown gateway response</html>', 'text/html')})
        with self.assertRaisesRegex(RuntimeError, 'differs from the legacy portal'): prepare.fetch_inventory(opener)

    def test_realtime_health_or_new_catalogue_registration_blocks_legacy_bootstrap(self):
        opener = legacy_opener({prepare.REALTIME_HEALTH_URL: ({'ok': True, 'service': 'iva-realtime'}, 'application/json')})
        with self.assertRaisesRegex(RuntimeError, 'Realtime route'): prepare.fetch_inventory(opener)
        for change in ('additional-game', 'replacement-game', 'realtime-field', 'changed-status', 'duplicate'):
            catalogue = legacy_catalogue()
            if change == 'additional-game': catalogue['games'].append({**catalogue['games'][0], 'gameId': 'forpost'})
            elif change == 'replacement-game': catalogue['games'][-1]['gameId'] = 'tyaga'
            elif change == 'realtime-field': catalogue['games'][0]['realtime'] = {'protocolVersion': 1}
            elif change == 'changed-status': catalogue['games'][-1]['status'] = 'available'
            else: catalogue['games'][-1] = catalogue['games'][0]
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'catalogue'):
                prepare.fetch_inventory(legacy_opener({prepare.CATALOGUE_URL: (catalogue, 'application/json')}))

    def test_bare_404_and_failures_of_any_proof_request_never_become_bootstrap(self):
        urls = (prepare.PORTAL_URL, prepare.REALTIME_HEALTH_URL, prepare.PLATFORM_HEALTH_URL, prepare.CATALOGUE_URL)
        for url in urls:
            for status in (401, 403, 404, 429, 500, 503):
                error = urllib.error.HTTPError(url, status, 'fixture', {}, None)
                with self.subTest(url=url, status=status), self.assertRaises(urllib.error.HTTPError):
                    prepare.fetch_inventory(legacy_opener({url: error}, inventory_status=404))
            with self.subTest(url=url, status='network'), self.assertRaises(urllib.error.URLError):
                prepare.fetch_inventory(legacy_opener({url: urllib.error.URLError('offline')}))

    def test_legacy_proof_checks_exact_health_status_and_media(self):
        for health, media in (({'ok': 1, 'service': 'iva-platform'}, 'application/json'),
                              ({'ok': False, 'service': 'iva-platform'}, 'application/json'),
                              ({'ok': True, 'service': 'iva-realtime'}, 'application/json'),
                              ({'ok': True, 'service': 'iva-platform'}, 'text/html')):
            with self.subTest(health=health, media=media), self.assertRaisesRegex(RuntimeError, 'health'):
                prepare.fetch_inventory(legacy_opener({prepare.PLATFORM_HEALTH_URL: (health, media)}))

    def test_changed_url_non200_and_oversized_responses_fail_before_bootstrap(self):
        for mode in ('url', 'status', 'large', 'media'):
            value = response(self.inventory())
            if mode == 'url': value.geturl = lambda: 'https://other.invalid/'
            elif mode == 'status': value.status = 204
            elif mode == 'large': value = response(b' ' * 1_048_577)
            else: value.headers.replace_header('Content-Type', 'text/plain')
            opener = Mock(); opener.open.return_value = value
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): prepare.fetch_inventory(opener)

    def test_auth_network_errors_and_redirects_do_not_become_bootstrap(self):
        for status in (401, 403, 429, 500, 503):
            opener = Mock(); opener.open.side_effect = urllib.error.HTTPError(prepare.INVENTORY_URL, status, 'fixture', {}, None)
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, f'HTTP {status}'):
                prepare.fetch_inventory(opener)
        with self.assertRaisesRegex(RuntimeError, 'redirect refused'):
            prepare.RefuseRedirects().redirect_request(None, None, 302, '', {}, 'https://other.invalid/')

    def test_public_inventory_is_deduplicated_and_rejects_private_fields_or_nonrevision_input(self):
        value = self.inventory(); value['manifests'] *= 2
        self.assertEqual(len(prepare.sanitize_inventory(value)['manifests']), 1)
        value['manifests'][0]['world'] = 'private-world'
        with self.assertRaisesRegex(RuntimeError, 'saved manifest'): prepare.sanitize_inventory(value)
        value = self.inventory(); value['buildRevision'] = '../../mutable-main'
        with self.assertRaisesRegex(RuntimeError, 'revision'): prepare.sanitize_inventory(value)
        value = self.inventory(); value['format'] = True
        with self.assertRaisesRegex(RuntimeError, 'inventory'): prepare.sanitize_inventory(value)
        opener = Mock(); opener.open.return_value = response(self.inventory())
        prepare.fetch_inventory(opener)
        request = opener.open.call_args.args[0]
        self.assertIsNone(request.get_header('Authorization'))
        self.assertEqual(request.full_url, prepare.INVENTORY_URL)

    def test_copies_current_and_recursive_bundle_by_validated_revision_then_digest(self):
        calls = []; opener = Mock(); opener.open.return_value = response(self.inventory())
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'input'
            result = prepare.prepare(target, opener, self.docker(calls))
            value = json.loads((target / 'input.json').read_text())
            copied = json.loads((target / 'bundle/bundle.json').read_text())
            self.assertFalse(result['bootstrap'])
            self.assertEqual(copied['artifacts'], [digest('a'), digest('b')])
            self.assertEqual(value['image']['revision'], self.revision)
            self.assertEqual(value['image']['digest'], digest('f'))
        self.assertEqual(calls[0][-1], f'{prepare.REPOSITORY}:{self.revision}')
        pulls = [call for call in calls if call[1] == 'pull']
        self.assertEqual(pulls, [('docker', 'pull', f'{prepare.REPOSITORY}@{digest("f")}')])
        self.assertTrue(any(call[1] == 'create' and call[call.index('--network') + 1] == 'none' for call in calls))
        self.assertEqual(calls[-1][1:3], ('rm', '--force'))

    def test_foreign_source_label_is_rejected_before_pull_or_container_creation(self):
        calls = []; opener = Mock(); opener.open.return_value = response(self.inventory())
        with tempfile.TemporaryDirectory() as root, self.assertRaisesRegex(RuntimeError, 'labels'):
            prepare.prepare(Path(root) / 'input', opener, self.docker(calls, invalid_labels=True))
        self.assertFalse(any(call[1] in ('pull', 'create') for call in calls))

    def test_malformed_image_metadata_is_rejected_before_pull(self):
        calls = []; opener = Mock(); opener.open.return_value = response(self.inventory())
        valid = self.docker(calls)
        def run(*args):
            if '{{json .Image}}' in args:
                calls.append(args)
                return '[]'
            return valid(*args)
        with tempfile.TemporaryDirectory() as root, self.assertRaisesRegex(RuntimeError, 'configuration is missing'):
            prepare.prepare(Path(root) / 'input', opener, run)
        self.assertFalse(any(call[1] in ('pull', 'create') for call in calls))

    def test_missing_n_minus_two_version_fails_and_cleans_its_own_container(self):
        bundle = self.bundle(); bundle['artifacts'] = [digest('b')]
        body = {key: value for key, value in bundle.items() if key != 'seal'}
        bundle['seal'] = 'sha256:' + hashlib.sha256(prepare.canonical(body).encode()).hexdigest()
        calls = []; opener = Mock(); opener.open.return_value = response(self.inventory())
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(RuntimeError, 'Required saved version missing'):
                prepare.prepare(Path(root) / 'input', opener, self.docker(calls, bundle))
            self.assertFalse((Path(root) / 'input').exists())
        self.assertEqual(calls[-1][1:3], ('rm', '--force'))

    def test_bundle_revision_and_seal_are_checked_after_copy(self):
        for mode in ('revision', 'seal'):
            bundle = self.bundle()
            if mode == 'revision':
                bundle['buildRevision'] = 'c' * 40
                bundle['seal'] = 'sha256:' + hashlib.sha256(prepare.canonical({k: v for k, v in bundle.items() if k != 'seal'}).encode()).hexdigest()
            else: bundle['seal'] = digest('0')
            calls = []; opener = Mock(); opener.open.return_value = response(self.inventory())
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root, self.assertRaises(RuntimeError):
                prepare.prepare(Path(root) / 'input', opener, self.docker(calls, bundle))
            self.assertEqual(calls[-1][1:3], ('rm', '--force'))

    def test_existing_output_is_not_deleted_or_replaced(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'input'; target.mkdir(); (target / 'marker').write_text('keep')
            opener = Mock()
            with self.assertRaisesRegex(RuntimeError, 'refusing to overwrite'): prepare.prepare(target, opener)
            self.assertEqual((target / 'marker').read_text(), 'keep'); opener.open.assert_not_called()


if __name__ == '__main__':
    unittest.main()
