#!/usr/bin/env python3
"""Collect the actual deployed image's current and recursive retained bundle.

Only public metadata is requested. A recognized legacy portal may create an
explicit bootstrap build input; it never exempts host-store preflight.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid

INVENTORY_URL = 'https://iva-games.pro/api/realtime/v1/compatibility'
PORTAL_URL = 'https://iva-games.pro/'
REALTIME_HEALTH_URL = 'https://iva-games.pro/api/realtime/v1/health'
PLATFORM_HEALTH_URL = 'https://iva-games.pro/health/live'
CATALOGUE_URL = 'https://iva-games.pro/api/platform/v1/games'
# Independently observed public legacy shell on 2026-11-28. A future/different
# HTML response must be reviewed, not guessed to mean an empty runtime store.
LEGACY_PORTAL_SHA256 = 'b0af43f9cda37d8dc17f8613df907719e4f6b537fa92830c9410066df7e7e9b5'
LEGACY_GAMES = {
    'platform-lab': ('other', 'available', 'lab-1', 'lab-1'),
    'district': ('other', 'available', 'district@0.4', 'district-territorial@1'),
    'remorse': ('chess', 'unavailable', 'pending', 'pending'),
    'overdrive': ('chess', 'unavailable', 'pending', 'pending'),
    'colossus': ('chess', 'unavailable', 'pending', 'pending'),
    'harbor': ('other', 'planned', 'pending', 'pending'),
}
REPOSITORY = 'ghcr.io/decorum-guy/iva-games-realtime'
SOURCE = 'https://github.com/decorum-guy/iva-games'
REVISION = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
VERSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,159}')
FIELDS = ('runtime', 'rules', 'content', 'protocol', 'serializer', 'bot', 'map', 'physics', 'prng', 'client')


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise RuntimeError('Compatibility inventory redirect refused')


OPENER = urllib.request.build_opener(RefuseRedirects())


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def sanitize_inventory(value):
    if not isinstance(value, dict) or set(value) != {'format', 'buildRevision', 'current', 'manifests'} or type(value.get('format')) is not int or value['format'] != 1:
        raise RuntimeError('Invalid compatibility inventory')
    if not isinstance(value['buildRevision'], str) or not REVISION.fullmatch(value['buildRevision']):
        raise RuntimeError('Invalid inventory revision')
    current = value['current']
    if not isinstance(current, dict) or set(current) != {'runtime', 'client'} or any(not isinstance(v, str) or not DIGEST.fullmatch(v) for v in current.values()):
        raise RuntimeError('Invalid current image identities')
    if not isinstance(value['manifests'], list) or len(value['manifests']) > 4096:
        raise RuntimeError('Invalid compatibility manifest list')
    unique = {}
    for raw in value['manifests']:
        if not isinstance(raw, dict) or set(raw) != set(FIELDS):
            raise RuntimeError('Invalid saved manifest')
        manifest = {}
        for field in FIELDS:
            item = raw[field]
            if not isinstance(item, str) or not (DIGEST if field in ('runtime', 'client') else VERSION).fullmatch(item):
                raise RuntimeError('Invalid saved manifest value')
            manifest[field] = item
        unique[canonical(manifest)] = manifest
    return {'format': 1, 'buildRevision': value['buildRevision'], 'current': {key: current[key] for key in ('runtime', 'client')},
            'manifests': [unique[key] for key in sorted(unique)]}


def fetch_public(url, opener=None):
    request = urllib.request.Request(url, headers={'Accept': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'iva-realtime-retention/1'})
    with (opener or OPENER).open(request, timeout=15) as response:
        if response.geturl() != url or response.status != 200:
            raise RuntimeError('Unexpected public response URL or status')
        payload = response.read(1_048_577)
        if len(payload) > 1_048_576:
            raise RuntimeError('Public compatibility evidence is too large')
        return response.headers.get_content_type(), payload


def require_legacy_catalogue(value):
    if not isinstance(value, dict) or set(value) != {'games'} or not isinstance(value['games'], list) or len(value['games']) != len(LEGACY_GAMES):
        raise RuntimeError('Unrecognized legacy catalogue')
    seen = set()
    fields = {'gameId', 'collectionId', 'title', 'minPlayers', 'maxPlayers', 'supportsBots', 'rulesVersion', 'contentVersion', 'status'}
    for game in value['games']:
        if not isinstance(game, dict) or set(game) != fields or not isinstance(game['gameId'], str):
            raise RuntimeError('Unrecognized legacy catalogue')
        game_id = game['gameId']
        expected = LEGACY_GAMES.get(game_id)
        if expected is None or game_id in seen or tuple(game[key] for key in ('collectionId', 'status', 'rulesVersion', 'contentVersion')) != expected:
            raise RuntimeError('Legacy catalogue does not prove absence of realtime registration')
        if not isinstance(game['title'], str) or not game['title'] or type(game['supportsBots']) is not bool or any(type(game[key]) is not int for key in ('minPlayers', 'maxPlayers')) or not 1 <= game['minPlayers'] <= game['maxPlayers'] <= 64:
            raise RuntimeError('Unrecognized legacy catalogue')
        seen.add(game_id)


def require_legacy_portal(compatibility_html, opener=None):
    """Recognize public routing only; make no claim about physical saved data."""
    media, portal = fetch_public(PORTAL_URL, opener)
    if media != 'text/html' or hashlib.sha256(portal).hexdigest() != LEGACY_PORTAL_SHA256:
        raise RuntimeError('Unrecognized legacy portal response')
    if compatibility_html is not None and compatibility_html != portal:
        raise RuntimeError('Compatibility response differs from the legacy portal')
    media, realtime_health = fetch_public(REALTIME_HEALTH_URL, opener)
    if media != 'text/html' or realtime_health != portal:
        raise RuntimeError('Realtime route cannot be classified as legacy portal fallback')
    media, health = fetch_public(PLATFORM_HEALTH_URL, opener)
    value = json.loads(health) if media == 'application/json' else None
    if not isinstance(value, dict) or set(value) != {'ok', 'service'} or value['ok'] is not True or value['service'] != 'iva-platform':
        raise RuntimeError('Legacy platform health is not positively confirmed')
    media, catalogue = fetch_public(CATALOGUE_URL, opener)
    if media != 'application/json':
        raise RuntimeError('Legacy catalogue is not positively confirmed')
    require_legacy_catalogue(json.loads(catalogue))


def fetch_inventory(opener=None):
    try:
        media, payload = fetch_public(INVENTORY_URL, opener)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        if status == 404:
            require_legacy_portal(None, opener)
            return None
        raise RuntimeError(f'Compatibility inventory HTTP {status}') from None
    if media == 'application/json':
        return sanitize_inventory(json.loads(payload))
    if media == 'text/html':
        require_legacy_portal(payload, opener)
        return None
    raise RuntimeError('Unexpected compatibility response')


def command(*args):
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=180).strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f'{Path(args[0]).name} {args[1] if len(args) > 1 else ""} failed') from error


def check_labels(labels, revision):
    if not isinstance(labels, dict) or labels.get('org.opencontainers.image.source') != SOURCE or labels.get('org.opencontainers.image.revision') != revision:
        raise RuntimeError('Previous image source/revision labels do not match')


def check_copied_bundle(directory, inventory):
    metadata = directory / 'bundle.json'
    if metadata.is_symlink() or not metadata.is_file() or metadata.stat().st_size > 16 * 1024 * 1024:
        raise RuntimeError('Previous image has no sealed retention bundle')
    value = json.loads(metadata.read_text())
    expected = {'format', 'buildRevision', 'current', 'artifacts', 'clients', 'readers', 'seal'}
    if not isinstance(value, dict) or set(value) != expected or type(value.get('format')) is not int or value['format'] != 1:
        raise RuntimeError('Invalid previous retention bundle')
    body = {key: value[key] for key in expected - {'seal'}}
    if value['seal'] != 'sha256:' + hashlib.sha256(canonical(body).encode()).hexdigest():
        raise RuntimeError('Previous retention bundle seal differs')
    if value['buildRevision'] != inventory['buildRevision'] or value['current'] != inventory['current']:
        raise RuntimeError('Inventory and previous image identities differ')
    for key in ('artifacts', 'clients'):
        entries = value[key]
        if not isinstance(entries, list) or not entries or len(entries) > 4096 or any(not isinstance(v, str) or not DIGEST.fullmatch(v) for v in entries) or entries != sorted(set(entries)):
            raise RuntimeError('Invalid retained identity list')
    if inventory['current']['runtime'] not in value['artifacts'] or inventory['current']['client'] not in value['clients']:
        raise RuntimeError('Previous image current bytes are absent from its bundle')
    for manifest in inventory['manifests']:
        if manifest['runtime'] not in value['artifacts'] or manifest['client'] not in value['clients']:
            raise RuntimeError('Required saved version missing from previous image bundle')
    # The new image's seal command independently hashes every copied file and
    # checks the explicit readers before this input may enter a runnable image.


def prepare(output, opener=None, run=None):
    output = Path(output).resolve()
    if output.exists():
        raise RuntimeError('Retention input already exists; refusing to overwrite evidence')
    output.parent.mkdir(parents=True, exist_ok=True)
    inventory = fetch_inventory(opener)
    staging = Path(tempfile.mkdtemp(prefix='.retention-', dir=output.parent))
    docker = run or command
    container = 'iva-retention-' + uuid.uuid4().hex
    created = False
    try:
        image = None
        if inventory is not None:
            revision = inventory['buildRevision']
            tag = f'{REPOSITORY}:{revision}'
            description = json.loads(docker('docker', 'buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', tag))
            digest = description.get('digest') if isinstance(description, dict) else None
            if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
                raise RuntimeError('Previous immutable image digest is missing')
            reference = f'{REPOSITORY}@{digest}'
            metadata = json.loads(docker('docker', 'buildx', 'imagetools', 'inspect', '--format', '{{json .Image}}', reference))
            if not isinstance(metadata, dict):
                raise RuntimeError('Previous image configuration is missing')
            platform = metadata.get('linux/amd64', {})
            config = metadata.get('config') or (platform.get('config') if isinstance(platform, dict) else None)
            if not isinstance(config, dict):
                raise RuntimeError('Previous image configuration is missing')
            check_labels(config.get('Labels'), revision)
            docker('docker', 'pull', reference)
            check_labels(json.loads(docker('docker', 'image', 'inspect', reference, '--format', '{{json .Config.Labels}}')), revision)
            docker('docker', 'create', '--name', container, '--network', 'none', '--entrypoint', '/bin/true', reference)
            created = True
            copied = staging / 'bundle'; copied.mkdir()
            docker('docker', 'cp', f'{container}:/app/retention/.', str(copied))
            check_copied_bundle(copied, inventory)
            image = {'repository': REPOSITORY, 'revision': revision, 'digest': digest}
        value = {'format': 1, 'bootstrap': inventory is None, 'inventory': inventory, 'image': image}
        (staging / 'input.json').write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        staging.rename(output)
        return {'ok': True, 'bootstrap': inventory is None, 'buildRevision': inventory['buildRevision'] if inventory else None,
                'requiredManifests': len(inventory['manifests']) if inventory else 0,
                'bootstrapEvidence': 'recognized-public-legacy-portal-v1' if inventory is None else None,
                'hostPreflightRequired': True}
    finally:
        if created:
            try:
                docker('docker', 'rm', '--force', container)
            except RuntimeError:
                pass
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('deploy/iva-games/retained-input/current'))
    options = parser.parse_args()
    try:
        print(json.dumps(prepare(options.output), sort_keys=True))
    except RuntimeError as error:
        raise SystemExit(f'Realtime retention preparation failed: {error}') from None
    except (OSError, ValueError, TypeError, KeyError):
        # No raw response, image environment, world or caller credential is logged.
        raise SystemExit('Realtime retention preparation failed; existing service must remain in place') from None


if __name__ == '__main__':
    main()
