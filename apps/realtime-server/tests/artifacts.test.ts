import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { copyRuntimeArtifact, retainRuntimeArtifact, retainedWorkerDirectory } from '../src/artifacts';
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'iva-runtime-artifact-')); temporary.push(root);
  const source = join(root, 'source'); mkdirSync(join(source, 'assets'), { recursive: true });
  for (const file of ['main.js', 'simulation-worker.js', 'store-worker.js', 'assets/core-v1.js']) writeFileSync(join(source, file), '// artifact archive unit fixture: ' + file);
  return { root: join(root, 'archive'), source, url: pathToFileURL(source + '/') };
}
describe('saved simulation artifact retention', () => {
  it('retains immutable content, reuses its identity and preserves an earlier worker after an update', () => {
    const f = fixture(), first = retainRuntimeArtifact(f.url, f.root);
    expect(retainRuntimeArtifact(f.url, f.root).artifactId).toBe(first.artifactId);
    writeFileSync(join(f.source, 'assets/core-v1.js'), '// changed source fixture');
    const second = retainRuntimeArtifact(f.url, f.root); expect(second.artifactId).not.toBe(first.artifactId);
    const previous = retainedWorkerDirectory(f.root, first.artifactId);
    expect(readFileSync(new URL('assets/core-v1.js', previous), 'utf8')).toBe('// artifact archive unit fixture: assets/core-v1.js');
    expect(readFileSync(new URL('assets/core-v1.js', second.workerDirectory), 'utf8')).toBe('// changed source fixture');
  });
  it('rejects a missing or altered pinned artifact instead of running new rules on the old world', () => {
    const f = fixture(), first = retainRuntimeArtifact(f.url, f.root);
    expect(() => retainedWorkerDirectory(f.root, 'sha256:' + '0'.repeat(64))).toThrow();
    writeFileSync(join(fileURLToPath(first.workerDirectory), 'simulation-worker.js'), '// changed after checkpoint');
    expect(() => retainedWorkerDirectory(f.root, first.artifactId)).toThrow('INVALID_RUNTIME_ARTIFACT');
    expect(() => retainedWorkerDirectory(f.root, '../outside')).toThrow('UNSUPPORTED_SAVED_RUNTIME');
  });
  it('keeps legacy format1 archives readable while including new checkpoint and CLI entries in current identity', () => {
    const f = fixture(), legacy = retainRuntimeArtifact(f.url, f.root);
    const copied = copyRuntimeArtifact(f.root, join(f.source, 'copied'), legacy.artifactId);
    expect(readFileSync(new URL('simulation-worker.js', copied), 'utf8')).toBe('// artifact archive unit fixture: simulation-worker.js');
    writeFileSync(join(f.source, 'checkpoint-worker.js'), '// checkpoint fixture v1');
    writeFileSync(join(f.source, 'retention-cli.js'), '// retention CLI fixture');
    const current = retainRuntimeArtifact(f.url, f.root);
    expect(current.artifactId).not.toBe(legacy.artifactId);
    expect(JSON.parse(readFileSync(new URL('manifest.json', current.workerDirectory), 'utf8')).files).toContain('checkpoint-worker.js');
    writeFileSync(join(f.source, 'checkpoint-worker.js'), '// checkpoint fixture v2');
    expect(retainRuntimeArtifact(f.url, f.root).artifactId).not.toBe(current.artifactId);
    expect(() => retainedWorkerDirectory(f.root, legacy.artifactId)).not.toThrow();
  });
});
