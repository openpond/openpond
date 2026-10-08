// Linux process RSS, without an inspector or forced GC. Uses only synthetic input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

if (process.platform !== 'linux') throw new Error('RSS benchmarking requires Linux /proc.');
const { values } = parseArgs({ options: { bundle: { type: 'string' }, executable: { type: 'string' }, runs: { type: 'string', default: '3' } } });
if (values.bundle && values.executable) throw new Error('Choose --bundle or --executable.');
const runs = Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be an integer from 1 to 20.');
const root = new URL('../../../', import.meta.url);
const artifact = values.executable ? path.resolve(values.executable) : values.bundle
  ? path.resolve(values.bundle) : fileURLToPath(new URL('dist/turnkey-agent-profile/app.cjs', root));
const bytes = await readFile(artifact);
const base = new URL('tmp/tvc-profile/', root);
await mkdir(base, { recursive: true });
const output = await mkdtemp(path.join(fileURLToPath(base), 'benchmark-'));
const fixture = createServer(async (request, response) => {
  for await (const _ of request) { /* drain the bounded synthetic model request */ }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
  }));
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const upstream = `http://127.0.0.1:${fixture.address().port}`;
const samples = [];
async function memory(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const kib = name => {
    const match = status.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
    if (!match) throw new Error(`Missing ${name} for child ${pid}`);
    return Number(match[1]);
  };
  return { rssMiB: kib('VmRSS') / 1024, peakRssMiB: kib('VmHWM') / 1024 };
}
try {
  for (let run = 0; run < runs; run++) {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'openpond-memory-'));
    const started = performance.now();
    const config = {
      host: '127.0.0.1', port: 0, authTokenSha256: createHash('sha256').update('memory-fixture').digest('hex'),
      modelEndpoint: `${upstream}/v1`, model: 'fixture', sandboxEndpoint: `${upstream}/sandboxes`,
      sandboxId: 'fixture', sandboxTeamId: 'fixture',
    };
    const child = spawn(values.executable ? artifact : process.execPath, [
      ...(values.executable ? [] : [artifact]), '--config-json', JSON.stringify(config),
    ], { cwd: scratch, env: { PATH: process.env.PATH ?? '', HOME: scratch, TMPDIR: scratch }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
    const exited = new Promise(resolve => {
      child.once('error', error => resolve({ error: String(error) }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const lines = createInterface({ input: child.stdout });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 60_000);
    try {
      const ready = new Promise(resolve => lines.on('line', line => {
        try { const event = JSON.parse(line); if (event.status === 'listening') resolve(event); }
        catch { /* unrelated startup log */ }
      }));
      const event = await Promise.race([ready, exited.then(result => { throw new Error(`Startup failed: ${JSON.stringify(result)} ${stderr}`); })]);
      const sample = { run, startupMs: performance.now() - started, ready: await memory(child.pid) };
      await delay(2000);
      const response = await fetch(`http://127.0.0.1:${event.port}/chat`, {
        method: 'POST', headers: { authorization: 'Bearer memory-fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Reply OK', credentials: { modelApiKey: 'fixture', sandboxApiKey: 'fixture' } }),
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).answer, 'OK');
      sample.afterTurn = await memory(child.pid);
      await delay(2000);
      sample.idle = await memory(child.pid);
      samples.push(sample);
    } finally {
      clearTimeout(deadline);
      lines.close();
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(force); await rm(scratch, { recursive: true, force: true }); }
    }
  }
  const median = numbers => {
    const ordered = [...numbers].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  };
  const result = {
    artifact, sha256: createHash('sha256').update(bytes).digest('hex'),
    runtime: values.executable ? 'packaged executable' : process.version,
    samples, median: {
      readyRssMiB: median(samples.map(sample => sample.ready.rssMiB)),
      afterTurnRssMiB: median(samples.map(sample => sample.afterTurn.rssMiB)),
      peakRssMiB: median(samples.map(sample => sample.idle.peakRssMiB)),
    },
  };
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...result.median }, null, 2));
} finally {
  await new Promise(resolve => fixture.close(resolve));
}
