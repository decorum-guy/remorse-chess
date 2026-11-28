import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveCurrentArtifact, readArtifact, WORKER_PROTOCOL } from '../src/artifacts.js';

describe('trusted local executable archive (file fixtures, not gameplay)', () => {
  function fixture(run: (source: string, archive: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'iva-artifact-'));
    try {
      const source = join(root, 'compiled'), archive = join(root, 'archive');
      mkdirSync(join(source, 'chunks'), { recursive: true });
      writeFileSync(join(source, 'simulation-worker.js'), "import './chunks/rules.js';\n");
      writeFileSync(join(source, 'chunks/rules.js'), 'export const physics = 1;\n');
      run(source, archive);
    } finally { rmSync(root, { force: true, recursive: true }); }
  }
  it('keeps byte-exact old chunks when a newly deployed artifact changes', () => fixture((source, archive) => {
    const old = archiveCurrentArtifact(source, archive);
    expect(old.manifest.protocol).toBe(WORKER_PROTOCOL);
    expect(archiveCurrentArtifact(source, archive).sha256).toBe(old.sha256);
    writeFileSync(join(source, 'chunks/rules.js'), 'export const physics = 2;\n');
    const current = archiveCurrentArtifact(source, archive);
    expect(current.sha256).not.toBe(old.sha256);
    expect(readArtifact(archive, old.sha256).manifest).toEqual(old.manifest);
    expect(readFileSync(join(archive, old.sha256, 'chunks/rules.js'), 'utf8')).toContain('physics = 1');
    expect(readFileSync(join(archive, current.sha256, 'chunks/rules.js'), 'utf8')).toContain('physics = 2');
  }));
  it('rejects changed executable bytes, missing archives, and untrusted path or URL selection', () => fixture((source, archive) => {
    const old = archiveCurrentArtifact(source, archive);
    chmodSync(old.workerPath, 0o600); writeFileSync(old.workerPath, 'console.log("changed");\n');
    expect(() => readArtifact(archive, old.sha256)).toThrow('ARTIFACT_CORRUPT');
    for (const id of ['a'.repeat(64), '../elsewhere', 'https://example.invalid/worker.js']) {
      expect(() => readArtifact(archive, id)).toThrow('ARTIFACT_UNAVAILABLE');
    }
  }));
  it('rejects executable or directory symlinks instead of following an external path', () => fixture((source, archive) => {
    symlinkSync('/dev/null', join(source, 'elsewhere.js'));
    expect(() => archiveCurrentArtifact(source, archive)).toThrow('ARTIFACT_SYMLINK');
  }));
});
