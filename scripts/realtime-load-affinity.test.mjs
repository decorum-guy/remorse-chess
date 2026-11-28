import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { inspectProcessAffinity, parseCpuList, requestedServerCpus, validateServerAffinity, processCpuFraction } from './realtime-load-affinity.mjs';

test('affinity parser counts exact CPUs and rejects overlapping/injected IDs', () => {
  assert.deepEqual(parseCpuList('0-2,4,6-7'), [0, 1, 2, 4, 6, 7]);
  assert.deepEqual(requestedServerCpus('3,1'), [1, 3]);
  assert.equal(requestedServerCpus(undefined), null);
  for (const invalid of ['0,0', '0-2,1', '3-1', '0;echo secret', '0,$(id)', '-1', '0,', '0-9999999']) assert.throws(() => parseCpuList(invalid));
  assert.throws(() => requestedServerCpus('0-2'));
});

test('process CPU fraction uses the explicit core budget and refuses an escaped thread', () => {
  assert.equal(processCpuFraction(1.2, [0, 1]), .6);
  assert.equal(processCpuFraction(1.2, null), null);
  const actual = { processCpus: [0, 1], threadCount: 2, threadCpuSets: [[0, 1]] };
  validateServerAffinity([0, 1], actual);
  assert.throws(() => validateServerAffinity([0, 1], { ...actual, threadCpuSets: [[0, 1], [0, 1, 2]] }));
});

test('actual taskset child and its actual Node worker inherit the declared mask', { timeout: 10_000 }, async () => {
  const cpus = inspectProcessAffinity(process.pid).processCpus.slice(0, 2);
  assert.ok(cpus.length > 0);
  const source = `import { Worker } from 'node:worker_threads';
    import { readFileSync } from 'node:fs';
    const worker = new Worker(\`import { parentPort } from 'node:worker_threads';
      import { readFileSync } from 'node:fs';
      parentPort.postMessage(readFileSync('/proc/thread-self/status', 'utf8').match(/^Cpus_allowed_list:\\\\s*(\\\\S+)$/m)[1]); setInterval(() => {}, 1000);\`, { eval: true });
    worker.once('message', workerMask => console.log(JSON.stringify({ workerMask, processMask: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\\s*(\\S+)$/m)[1] })));
    await new Promise(resolve => process.stdin.once('data', resolve));
    await worker.terminate();`;
  const child = spawn('taskset', ['-c', cpus.join(','), process.execPath, '--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    for await (const chunk of child.stdout) {
      output += chunk;
      if (output.includes('\n')) break;
    }
    assert.ok(output.includes('\n'), errors);
    const message = JSON.parse(output.trim());
    assert.deepEqual(parseCpuList(message.processMask), cpus); assert.deepEqual(parseCpuList(message.workerMask), cpus);
    validateServerAffinity(cpus, inspectProcessAffinity(child.pid));
    child.stdin.end('stop');
    const [code] = await exited; assert.equal(code, 0, errors);
  } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } }
});
