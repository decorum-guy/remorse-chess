"""Use real temporary Git indexes to test service isolation and lock changes."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('image-inputs.py').resolve()


class ImageInputsTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.run_command('git', 'init', '--quiet')
        self.root_package = {
            'name': 'iva-games', 'private': True, 'type': 'module',
            'workspaces': ['apps/*', 'games/*', 'games/chess/*', 'packages/*'],
            'scripts': {
                'build': 'npm run build:client && npm run build:server',
                'build:client': 'node scripts/compose-client.mjs',
                'build:server': 'vite build --config apps/server/vite.config.ts',
                'build:foundation': 'npm run build:platform && npm run build:portal',
                'build:platform': 'vite build --config vite.platform.config.ts',
                'build:portal': 'npm --prefix apps/portal run build',
                'build:realtime': 'npm run build --workspace @iva-games/realtime-server',
                'build:realtime-clients': 'node scripts/build-realtime-clients.mjs',
                'district:simulate': 'node games/district/scripts/simulate.mjs',
            },
            'devDependencies': {'vite': '1.0.0'},
        }
        self.workspaces = {
            'apps/server': {'name': '@chess-2/server', 'dependencies': {'@iva-games/session-kit': '1.0.0'}},
            'games/chess/remorse': {'name': '@chess-2/remorse', 'dependencies': {'react': '1.0.0'}},
            'games/chess/overdrive': {'name': '@chess-2/overdrive', 'dependencies': {'react': '1.0.0'}},
            'apps/platform': {'name': '@iva-games/platform', 'dependencies': {'@iva-games/district': '1.0.0', 'platform-only': '1.0.0'}},
            'apps/portal': {'name': '@iva-games/portal', 'dependencies': {'@iva-games/district': '1.0.0', 'react': '1.0.0'}},
            'games/district': {'name': '@iva-games/district', 'dependencies': {'@iva-games/session-kit': '1.0.0'}},
            'packages/session-kit': {'name': '@iva-games/session-kit', 'dependencies': {'shared-sql': '1.0.0'}},
            'apps/realtime-server': {'name': '@iva-games/realtime-server', 'dependencies': {'@iva-games/realtime-kit': '1.0.0'}},
            'packages/realtime-kit': {'name': '@iva-games/realtime-kit', 'dependencies': {'@iva-games/session-kit': '1.0.0'}},
            'games/tyaga': {'name': '@iva-games/tyaga', 'dependencies': {'physics': '1.0.0'}},
        }
        self.lock = {'lockfileVersion': 3, 'packages': {'': {'devDependencies': {'vite': '1.0.0'}}}}
        for path, package in self.workspaces.items():
            self.lock['packages'][path] = copy.deepcopy(package)
            self.lock['packages'][f'node_modules/{package["name"]}'] = {'link': True, 'resolved': path}
            self.write(path + '/package.json', package)
            self.write(path + '/src/index.ts', 'export const fixture = 1;')
        for name in ('vite', 'react', 'platform-only', 'shared-sql', 'physics'):
            self.lock['packages'][f'node_modules/{name}'] = {'version': '1.0.0', 'integrity': f'fixture-{name}-v1'}
        self.registry = {'version': 1, 'games': [
            {'gameId': name, 'chess': {'source': 'games/chess/' + name}}
            for name in ('remorse', 'overdrive')
        ]}
        self.registry['version'] = 2
        self.registry['games'].append({'gameId': 'tyaga', 'realtime': {'source': 'games/tyaga'}})
        self.write('packages/game-registry/games.json', self.registry)
        self.write('scripts/compose-client.mjs', '/* fixture build step */')
        self.save_manifests()
        self.stage()
        self.before = self.hashes()

    def run_command(self, *args):
        return subprocess.run(args, cwd=self.root, capture_output=True, text=True, check=True).stdout.strip()

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, sort_keys=True) if isinstance(value, dict) else value)

    def save_manifests(self):
        self.write('package.json', self.root_package)
        self.write('package-lock.json', self.lock)

    def stage(self):
        self.run_command('git', 'add', '--all')

    def hashes(self):
        return {service: self.run_command(sys.executable, '-B', str(SCRIPT), service).split()[0]
                for service in ('chess', 'platform')}

    def assert_platform_only(self):
        self.stage()
        after = self.hashes()
        self.assertEqual(after['chess'], self.before['chess'])
        self.assertNotEqual(after['platform'], self.before['platform'])

    def test_district_source_and_map_change_only_platform(self):
        self.write('games/district/src/index.ts', 'export const fixture = 2;')
        self.write('games/district/maps/new-map.json', {'shape': 'two-islands'})
        self.assert_platform_only()

    def test_district_manifest_and_private_dependency_do_not_invalidate_chess(self):
        self.workspaces['games/district']['dependencies']['map-layout'] = '1.0.0'
        self.lock['packages']['games/district'] = copy.deepcopy(self.workspaces['games/district'])
        self.lock['packages']['node_modules/map-layout'] = {'version': '1.0.0', 'integrity': 'fixture-map-layout'}
        self.write('games/district/package.json', self.workspaces['games/district'])
        self.save_manifests()
        self.assert_platform_only()

    def test_existing_platform_dependency_lock_upgrade_does_not_invalidate_chess(self):
        self.lock['packages']['node_modules/platform-only']['integrity'] = 'fixture-platform-v2'
        self.save_manifests()
        self.assert_platform_only()

    def test_new_unrelated_workspace_and_lock_records_do_not_change_either_service(self):
        self.write('games/new-game/package.json', {'name': '@iva-games/new-game', 'version': '1.0.0'})
        self.lock['packages']['games/new-game'] = {'name': '@iva-games/new-game', 'version': '1.0.0'}
        self.lock['packages']['node_modules/@iva-games/new-game'] = {'link': True, 'resolved': 'games/new-game'}
        self.save_manifests()
        self.stage()
        self.assertEqual(self.hashes(), self.before)

    def test_registered_chess_workspace_dependency_is_discovered_without_a_hardcoded_root(self):
        self.registry['games'].append({'gameId': 'future-chess', 'chess': {'source': 'games/chess/future-chess'}})
        self.write('packages/game-registry/games.json', self.registry)
        package = {'name': '@chess-2/future-chess', 'dependencies': {'future-mesh': '1.0.0'}}
        self.write('games/chess/future-chess/package.json', package)
        self.lock['packages']['games/chess/future-chess'] = package
        self.lock['packages']['node_modules/future-mesh'] = {'version': '1.0.0', 'integrity': 'future-mesh-v1'}
        self.save_manifests()
        self.stage()
        registered = self.hashes()
        self.assertTrue(all(registered[name] != self.before[name] for name in self.before))
        self.lock['packages']['node_modules/future-mesh']['integrity'] = 'future-mesh-v2'
        self.save_manifests()
        self.stage()
        changed = self.hashes()
        self.assertNotEqual(changed['chess'], registered['chess'])
        self.assertEqual(changed['platform'], registered['platform'])

    def test_registry_metadata_changes_refresh_both_images(self):
        self.registry['games'][0]['title'] = {'en': 'Renamed', 'ru': 'Новое имя'}
        self.write('packages/game-registry/games.json', self.registry)
        self.stage()
        after = self.hashes()
        self.assertTrue(all(after[name] != self.before[name] for name in self.before))

    def test_registry_build_validator_is_part_of_both_service_inputs(self):
        self.write('scripts/check-game-registry.mjs', '/* changed registration gate */')
        self.stage()
        after = self.hashes()
        self.assertTrue(all(after[name] != self.before[name] for name in self.before))

    def test_shared_dependency_upgrade_invalidates_both_services(self):
        self.lock['packages']['node_modules/shared-sql']['integrity'] = 'fixture-sql-v2'
        self.save_manifests()
        self.stage()
        after = self.hashes()
        self.assertTrue(all(after[name] != self.before[name] for name in self.before))

    def test_chess_code_does_not_invalidate_platform(self):
        self.write('games/chess/overdrive/src/index.ts', 'export const fixture = 2;')
        self.stage()
        after = self.hashes()
        self.assertNotEqual(after['chess'], self.before['chess'])
        self.assertEqual(after['platform'], self.before['platform'])

    def test_shared_chess_catalogue_source_invalidates_both_images(self):
        self.write('apps/portal/src/chess-home.tsx', 'export const fixture = 2;')
        self.stage()
        after = self.hashes()
        self.assertTrue(all(after[name] != self.before[name] for name in self.before))

    def test_portal_only_navigation_does_not_invalidate_chess(self):
        self.write('apps/portal/src/links.ts', 'export const fixture = 2;')
        self.assert_platform_only()

    def test_service_build_script_changes_are_scoped_and_recursive(self):
        self.root_package['scripts']['build:platform'] += ' --minify'
        self.save_manifests()
        self.assert_platform_only()

    def test_build_assembly_script_is_not_omitted(self):
        self.write('scripts/compose-client.mjs', '/* changed assembly */')
        self.stage()
        after = self.hashes()
        self.assertNotEqual(after['chess'], self.before['chess'])
        self.assertEqual(after['platform'], self.before['platform'])

    def test_nested_dependency_resolution_is_hashed_instead_of_wrong_hoisted_version(self):
        self.lock['packages']['node_modules/platform-only']['dependencies'] = {'nested': '2.0.0'}
        self.lock['packages']['node_modules/nested'] = {'version': '1.0.0'}
        self.lock['packages']['node_modules/platform-only/node_modules/nested'] = {'version': '2.0.0'}
        self.save_manifests()
        self.stage()
        before_nested = self.hashes()
        self.lock['packages']['node_modules/nested']['version'] = '1.1.0'
        self.save_manifests()
        self.stage()
        self.assertEqual(self.hashes(), before_nested)
        self.lock['packages']['node_modules/platform-only/node_modules/nested']['version'] = '2.1.0'
        self.save_manifests()
        self.stage()
        self.assertNotEqual(self.hashes()['platform'], before_nested['platform'])

    def test_peer_and_optional_installed_dependencies_are_not_omitted(self):
        self.lock['packages']['node_modules/platform-only'].update(
            peerDependencies={'peer': '1.0.0'}, optionalDependencies={'optional': '1.0.0'})
        for name in ('peer', 'optional'):
            self.lock['packages'][f'node_modules/{name}'] = {'version': '1.0.0'}
        self.save_manifests()
        self.stage()
        baseline = self.hashes()
        for name in ('peer', 'optional'):
            with self.subTest(name=name):
                self.lock['packages'][f'node_modules/{name}']['version'] = '1.1.0'
                self.save_manifests()
                self.stage()
                current = self.hashes()
                self.assertNotEqual(current['platform'], baseline['platform'])
                self.assertEqual(current['chess'], baseline['chess'])
                baseline = current

    def test_missing_required_lock_record_fails_closed(self):
        del self.lock['packages']['node_modules/shared-sql']
        self.save_manifests()
        self.stage()
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'chess'], cwd=self.root,
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing required npm lock record', result.stderr)

    def test_realtime_source_and_physics_lock_are_hashed_without_chess_churn(self):
        before = self.run_command(sys.executable, '-B', str(SCRIPT), 'realtime').split()[0]
        self.write('games/tyaga/src/index.ts', 'export const physics = 2;')
        self.lock['packages']['node_modules/physics']['integrity'] = 'fixture-physics-v2'
        self.save_manifests(); self.stage()
        after = self.run_command(sys.executable, '-B', str(SCRIPT), 'realtime').split()[0]
        self.assertNotEqual(before, after)
        self.assertEqual(self.hashes()['chess'], self.before['chess'])

    def test_realtime_client_assembly_is_not_omitted(self):
        before = self.run_command(sys.executable, '-B', str(SCRIPT), 'realtime').split()[0]
        self.write('scripts/build-realtime-clients.mjs', '/* changed runtime client assembly */')
        self.stage()
        after = self.run_command(sys.executable, '-B', str(SCRIPT), 'realtime').split()[0]
        self.assertNotEqual(before, after)
        self.assertEqual(self.hashes()['chess'], self.before['chess'])


if __name__ == '__main__':
    unittest.main()
