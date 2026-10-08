import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { snapshot: { type: 'boolean', default: false } } });
const bundle = path.join(root, 'dist/turnkey-agent-profile/app.cjs');
const source = await readFile(bundle);
const sourceMap = new SourceMap(JSON.parse(await readFile(`${bundle}.map`, 'utf8')));
const base = path.join(root, 'tmp/tvc-profile');
await mkdir(base, { recursive: true });
const output = await mkdtemp(path.join(base, 'capture-'));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'openpond-memory-'));
try {
  const config = {
    host: '127.0.0.1', port: 0, authTokenSha256: createHash('sha256').update('profile-fixture').digest('hex'),
    modelEndpoint: 'http://127.0.0.1:1/v1', model: 'fixture',
    sandboxEndpoint: 'http://127.0.0.1:1/sandboxes', sandboxId: 'fixture', sandboxTeamId: 'fixture',
  };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--expose-gc', '--require', fileURLToPath(new URL('./profile-hook.cjs', import.meta.url)),
      bundle, '--config-json', JSON.stringify(config),
    ], {
      cwd: scratch, stdio: ['ignore', 'inherit', 'inherit'],
      env: { PATH: process.env.PATH ?? '', HOME: scratch, TMPDIR: scratch,
        OPENPOND_PROFILE_OUTPUT: output, OPENPOND_PROFILE_SNAPSHOT: values.snapshot ? '1' : '0' },
    });
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      if (timedOut || code !== 0) reject(new Error(`Profile failed: ${timedOut ? 'timeout' : code ?? signal}`));
      else resolve();
    });
  });
  const profile = JSON.parse(await readFile(path.join(output, 'allocations.heapprofile'), 'utf8'));
  const sites = new Map();
  const callers = new Map();
  let total = 0;
  let zodBytes = 0;
  function visit(node, projectCaller = '(runtime)') {
    const frame = node.callFrame;
    const entry = frame.url === bundle || frame.url === `file://${bundle}`
      ? sourceMap.findEntry(frame.lineNumber, frame.columnNumber) : {};
    const file = entry.originalSource ?? frame.url ?? '(native)';
    const site = `${file}:${(entry.originalLine ?? frame.lineNumber) + 1} ${frame.functionName}`;
    if (/\/(packages|apps|examples)\//.test(file) && !file.includes('/node_modules/')) projectCaller = site;
    total += node.selfSize;
    if (file.includes('/zod/')) zodBytes += node.selfSize;
    sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
    callers.set(projectCaller, (callers.get(projectCaller) ?? 0) + node.selfSize);
    for (const child of node.children) visit(child, projectCaller);
  }
  visit(profile.head);
  const ranked = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 40)
    .map(([site, bytes]) => ({ site, MiB: +(bytes / 2 ** 20).toFixed(2) }));
  const memory = JSON.parse(await readFile(path.join(output, 'memory.json'), 'utf8'));
  const summary = {
    node: process.version, bundleSha256: createHash('sha256').update(source).digest('hex'),
    memory, sampledRetainedMiB: total / 2 ** 20, zodAllocationMiB: zodBytes / 2 ** 20,
    allocationSites: ranked(sites), nearestProjectCallers: ranked(callers),
  };
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ output, heapMiB: memory.heapUsed / 2 ** 20,
    sampledRetainedMiB: summary.sampledRetainedMiB, zodAllocationMiB: summary.zodAllocationMiB }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
