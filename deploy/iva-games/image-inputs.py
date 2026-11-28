#!/usr/bin/env python3
"""Hash each service's tracked sources and resolved npm dependency closure.

The lockfile remains authoritative. Hashing it wholesale also invalidated chess
for a District-only workspace/dependency change. Instead keep the complete lock
records reachable from this service and shared root tooling, including optional
and peer dependencies. Unknown/missing required records fail the release.

Root tooling is deliberately conservative: all root dependencies are included
for both services. A shared toolchain upgrade still refreshes both images. New
build steps reading files outside these inputs must update this contract.
"""

import hashlib
import json
from pathlib import PurePosixPath
import re
import subprocess
import sys

SPEC = {
    'chess': {
        'roots': ['apps/server'],
        'build': 'build',
        'files': ['Dockerfile', 'games/chess', 'apps/server', 'apps/portal/chess-home', 'apps/portal/src/chess-home.tsx', 'apps/portal/src/ui.tsx',
                  'apps/portal/src/types.ts', 'apps/portal/src/AvatarArt.tsx', 'apps/portal/src/navigation.tsx', 'apps/portal/src/styles.css',
                  'packages/engine-sdk', 'packages/session-kit',
                  'vite.config.ts', 'vite.server.config.ts', 'tsconfig.json', 'scripts/compose-client.mjs', 'scripts/build-chess.mjs', 'scripts/check-game-registry.mjs', 'scripts/chess-health.mjs'],
        'compatibility': ['apps/server/src/store.ts', ':(glob)apps/server/src/**/store.ts',
                          ':(glob)games/chess/**/src/core/**', ':(glob)games/chess/**/src/online/protocol.ts'],
    },
    'platform': {
        'roots': ['apps/platform', 'apps/portal'],
        'build': 'build:foundation',
        'files': ['Dockerfile.platform', 'apps/platform', 'apps/portal', 'games/district/src', 'games/district/maps',
                  'packages/session-kit', 'packages/telegram-transport', 'vite.platform.config.ts', 'tsconfig.platform.json'],
        'compatibility': ['apps/platform/src/database.ts', 'apps/platform/src/telegram/schema.ts',
                          'packages/session-kit/src', 'games/district/src/types.ts',
                          'games/district/src/core.ts', 'games/district/src/runtime.ts'],
    },
    'realtime': {
        'roots': ['apps/realtime-server', 'games/forpost'],
        'build': 'build:realtime',
        'files': ['Dockerfile.realtime', 'apps/realtime-server', 'games/forpost/src', 'games/forpost/public',
                  'games/forpost/vite.config.ts', 'games/forpost/index.html', 'packages/realtime-kit',
                  'deploy/iva-games/realtime-control.mjs', 'deploy/iva-games/prepare-realtime-image.py'],
        'compatibility': ['apps/realtime-server/src/store.ts', 'packages/realtime-kit/src',
                          'games/forpost/src/core'],
    },
}
COMMON = ['.dockerignore', '.npmrc', 'tsconfig.base.json', 'packages/game-registry', 'scripts/check-game-registry.mjs',
          'deploy/iva-games/image-inputs.py', 'deploy/iva-games/image-inputs.sh']


def git(*args):
    return subprocess.check_output(['git', *args])


def manifest(path):
    return json.loads(git('show', f':{path}'))


def build_scripts(scripts, entry):
    selected = {}
    pending = [entry, 'preinstall', 'install', 'postinstall', 'prepare', 'prepublish']
    while pending:
        name = pending.pop()
        if name in selected or name not in scripts:
            continue
        selected[name] = scripts[name]
        pending += [f'pre{name}', f'post{name}']
        pending += re.findall(r'\bnpm\s+run\s+([\w:.-]+)', scripts[name])
    if entry not in selected:
        raise ValueError('Service build script is missing')
    return selected


def dependency_closure(lock, roots):
    if lock.get('lockfileVersion') != 3 or '' not in lock.get('packages', {}):
        raise ValueError('Unsupported npm lockfile; update the fingerprint contract')
    packages = lock['packages']
    selected = {}
    local = set(roots)
    pending = ['', *roots]

    def resolve(origin, name, optional):
        if not re.fullmatch(r'(?:@[\w.-]+/)?[\w.-]+', name):
            raise ValueError('Unsupported npm dependency name')
        path = PurePosixPath(origin)
        for directory in [path, *path.parents]:
            if directory.name == 'node_modules':
                continue
            candidate = str(directory / 'node_modules' / name)
            if candidate in packages:
                return candidate
        if optional:
            return None
        raise ValueError(f'Missing required npm lock record: {origin or "root"} -> {name}')

    while pending:
        path = pending.pop()
        if path in selected:
            continue
        if path not in packages:
            raise ValueError(f'Missing service workspace in lockfile: {path}')
        entry = packages[path]
        # npm's dev/devOptional markers can change when another workspace
        # starts using an already present package. Resolution/content still
        # comes from the full record; those global reachability flags do not.
        selected[path] = {key: value for key, value in entry.items() if key not in ('dev', 'devOptional')}
        if entry.get('link'):
            target = entry.get('resolved', '')
            if not re.fullmatch(r'(?:apps|games|packages)/[\w./-]+', target) or '..' in target.split('/'):
                raise ValueError('Unsupported workspace link in lockfile')
            local.add(target)
            pending.append(target)
            continue
        dependencies = dict(entry.get('dependencies', {}))
        optional = set(entry.get('optionalDependencies', {}))
        dependencies.update(entry.get('optionalDependencies', {}))
        dependencies.update(entry.get('peerDependencies', {}))
        optional.update(name for name, metadata in entry.get('peerDependenciesMeta', {}).items()
                        if metadata.get('optional'))
        if path == '' or path in local:
            dependencies.update(entry.get('devDependencies', {}))
        for name in dependencies:
            resolved = resolve(path, name, name in optional)
            if resolved:
                pending.append(resolved)
    return selected, local


def fingerprints(service):
    spec = SPEC[service]
    root = manifest('package.json')
    roots = list(spec['roots'])
    if service == 'chess':
        registry = manifest('packages/game-registry/games.json')
        if registry.get('version') not in (1, 2) or not isinstance(registry.get('games'), list):
            raise ValueError('Invalid game registry')
        for game in registry['games']:
            if not game.get('chess'):
                continue
            source = game['chess'].get('source', '')
            if not re.fullmatch(r'games/chess/[a-z][a-z0-9-]*', source):
                raise ValueError('Invalid registered chess source')
            roots.append(source)
    lock, local = dependency_closure(manifest('package-lock.json'), roots)
    root['scripts'] = build_scripts(root.get('scripts', {}), spec['build'])
    # Keep declared ranges as well as the resolved graph, so a range/override
    # change cannot be lost. The service's local workspaces include their code.
    source_index = git('ls-files', '--stage', '-z', '--', *COMMON, *spec['files'], *sorted(local))
    value = {'schema': 2, 'root': root, 'lock': lock, 'sources': source_index.decode()}
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    compatibility = git('ls-files', '--stage', '-z', '--', *spec['compatibility'])
    return hashlib.sha256(encoded).hexdigest(), hashlib.sha256(compatibility).hexdigest()


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in SPEC:
        sys.exit('usage: image-inputs.sh chess|platform|realtime')
    try:
        print(*fingerprints(sys.argv[1]))
    except (KeyError, TypeError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'Cannot establish image inputs: {error}')
