/** Runs only the QA clients beside immutable image code, with no image mutation. */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

try {
  process.umask(0o077);
  if (process.getuid?.() !== 1000 || process.env.NODE_ENV !== 'test' ||
    process.env.FORPOST_QA_RUNTIME_ENTRY !== '/app/dist-realtime/main.js' || process.env.FORPOST_QA_CLIENT_DIRECTORY !== '/app/client' ||
    process.env.REALTIME_RETENTION_DIRECTORY !== '/app/retention') throw new Error('IMMUTABLE_PROFILE_IMAGE_REQUIRED');
  const sourceRoot = process.env.FORPOST_QA_SOURCE_DIRECTORY, tracePath = process.env.FORPOST_QA_SOURCE_TRACE;
  if (!sourceRoot || !tracePath || !process.env.FORPOST_QA_EXPECTED_BUILD_SHA) throw new Error('SOURCE_TRACE_REQUIRED');
  const directory = resolve(sourceRoot, 'apps/realtime-server/scripts');
  const { verifySourceTrace } = await import(pathToFileURL(resolve(directory, 'source-identity.mjs')).href);
  const trace = await verifySourceTrace(sourceRoot, JSON.parse(await readFile(tracePath, 'utf8')));
  if (trace.dirty || trace.gitCommit !== process.env.FORPOST_QA_EXPECTED_BUILD_SHA || process.env.IVA_BUILD_SHA !== trace.gitCommit) throw new Error('IMAGE_SOURCE_IDENTITY_MISMATCH');
  // Main verifies every archive and reader before readiness. This records the
  // exact sealed index bytes, then startRig cross-checks current IDs with health.
  const bundleBytes = await readFile('/app/retention/bundle.json'), bundle = JSON.parse(bundleBytes);
  if (bundle.format !== 1 || bundle.buildRevision !== trace.gitCommit || !/^sha256:[0-9a-f]{64}$/.test(bundle.seal) ||
    !/^sha256:[0-9a-f]{64}$/.test(bundle.current?.runtime) || !/^sha256:[0-9a-f]{64}$/.test(bundle.current?.client) ||
    !Array.isArray(bundle.artifacts) || !Array.isArray(bundle.clients) || !Array.isArray(bundle.readers?.profiles)) throw new Error('IMAGE_RETENTION_IDENTITY_MISMATCH');
  const retentionIdentity = { bundleFileSha256: createHash('sha256').update(bundleBytes).digest('hex'), seal: bundle.seal,
    buildRevision: bundle.buildRevision, current: { runtime: bundle.current.runtime, client: bundle.current.client },
    artifactCount: bundle.artifacts.length, clientCount: bundle.clients.length, readerProfileCount: bundle.readers.profiles.length };
  const harness = '/app/qa/harness'; await mkdir(harness, { recursive: true, mode: 0o700 });
  for (const name of ['load-probe.mjs', 'probe-lib.mjs', 'load-summary.mjs', 'source-identity.mjs']) await copyFile(resolve(directory, name), resolve(harness, name));
  const child = spawn(process.execPath, [resolve(harness, 'load-probe.mjs'), ...process.argv.slice(2), '--admission=test-fixture'], { cwd: '/app', stdio: 'inherit',
    env: { ...process.env, FORPOST_QA_RETENTION_IDENTITY: JSON.stringify(retentionIdentity) } });
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const [code] = await once(child, 'exit'); process.off('SIGTERM', stop); process.off('SIGINT', stop);
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(JSON.stringify({ stage: 'image-profile-bootstrap', complete: false,
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'IMAGE_PROFILE_FAILED' }));
  process.exitCode = 1;
}
