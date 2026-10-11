/** Staged by the private verifier owner. Untrusted policy programs run with no
 * capabilities as a different UID, outside the sealed private verifier tree.
 * The parent must assess returned behavior; an exit code is never correctness. */
export const PREPARED_PROCESS_ISOLATION_SOURCE = String.raw`
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";

const MAX_BYTES = 15 * 1024 * 1024, MAX_OUTPUT = 1024 * 1024;
const usedUsers = new Set();
const safePath = value => typeof value === "string" && value.length > 0 && value.length <= 2000
  && !value.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(value)
  && value.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith(".env"));

/** files contain only public original/policy bytes and a public invocation
 * adapter. Never stage independent assertions, expected answers or checkers. */
export async function runPolicyProgram(input) {
  const privateRoot = path.dirname(fileURLToPath(import.meta.url));
  if (process.getuid?.() !== 0 || !path.basename(privateRoot).startsWith(".openpond-reward-verifier-"))
    throw new Error("policy_process_isolation_runtime_unavailable");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100
    || !safePath(input.entrypoint) || !input.files.some(file => file.path === input.entrypoint)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60000
    || !Array.isArray(input.args ?? []) || (input.args ?? []).length > 100
    || (input.args ?? []).some(arg => typeof arg !== "string" || arg.length > 2000 || arg.includes("\0")))
    throw new Error("policy_process_isolation_input_invalid");
  let total = 0;
  const paths = new Set();
  const files = input.files.map(file => {
    if (!safePath(file.path) || paths.has(file.path) || typeof file.base64 !== "string")
      throw new Error("policy_process_isolation_file_invalid");
    paths.add(file.path);
    const bytes = Buffer.from(file.base64, "base64");
    if (bytes.toString("base64") !== file.base64) throw new Error("policy_process_isolation_file_invalid");
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error("policy_process_isolation_file_limit");
    return { path: file.path, bytes };
  });
  // Directory access seals request JSON, checker modules, helper source and
  // private artifacts before any untrusted program can be spawned.
  await fs.chmod(privateRoot, 0o700);
  const stat = await fs.stat(privateRoot);
  if (stat.uid !== 0 || (stat.mode & 0o777) !== 0o700) throw new Error("policy_process_private_tree_not_sealed");
  for (const executable of ["/usr/bin/setsid", "/usr/bin/setpriv", "/usr/local/bin/bun"])
    await fs.access(executable, 1);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-policy-"));
  let user;
  do { user = randomInt(1000000, 2000000); } while (usedUsers.has(user));
  usedUsers.add(user);
  let child, timer, timedOut = false;
  const kill = () => {
    if (!child) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
  };
  try {
    await fs.chmod(directory, 0o700);
    await fs.chown(directory, user, user);
    for (const file of files) {
      const target = path.join(directory, file.path);
      const parent = path.dirname(target);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      let current = parent;
      while (current !== directory) {
        await fs.chmod(current, 0o700); await fs.chown(current, user, user);
        current = path.dirname(current);
      }
      await fs.writeFile(target, file.bytes, { mode: 0o600, flag: "wx" });
      await fs.chown(target, user, user);
    }
    child = Bun.spawn(["/usr/bin/setsid", "/usr/bin/setpriv", "--reuid=" + user, "--regid=" + user, "--clear-groups",
      "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
      "/usr/local/bin/bun", path.join(directory, input.entrypoint), ...(input.args ?? [])], {
      cwd: directory, env: { PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: directory }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    timer = setTimeout(() => { timedOut = true; kill(); }, input.timeoutMs);
    const read = async stream => {
      const reader = stream.getReader(), chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read(); if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > MAX_OUTPUT) { kill(); throw new Error("policy_process_output_limit"); }
          chunks.push(item.value);
        }
        return new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks));
      } finally { await reader.cancel(); reader.releaseLock(); }
    };
    const [stdout, stderr, exitCode] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    return { stdout, stderr, exitCode, timedOut, isolation: { uid: user, gid: user, privateTreeSealed: true } };
  } finally {
    if (timer) clearTimeout(timer);
    kill();
    // A policy child can call setsid and escape its initial process group.
    // Drain every process with this invocation's unique real UID before the
    // next call; namespaces cannot grant a different outside UID or privilege.
    try { await drainPolicyProcesses(user); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}

async function drainPolicyProcesses(user) {
  const deadline = Date.now() + 2000;
  let empty = 0;
  while (Date.now() < deadline) {
    const entries = (await fs.readdir("/proc")).filter(value => /^\d+$/.test(value));
    if (entries.length > 10000) throw new Error("policy_process_inventory_limit");
    let owned = 0;
    for (const entry of entries) {
      let status;
      try { status = await fs.readFile("/proc/" + entry + "/status", "utf8"); }
      catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) continue; throw error; }
      const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
      if (ids && ids.slice(1).some(value => Number(value) === user)) {
        // Zombies cannot fork, inspect a subsequent invocation or hold files.
        if (/^State:\s+Z/m.test(status)) continue;
        owned++;
        try { process.kill(Number(entry), "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    empty = owned === 0 ? empty + 1 : 0;
    if (empty >= 2) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("policy_process_cleanup_unconfirmed");
}
`;
