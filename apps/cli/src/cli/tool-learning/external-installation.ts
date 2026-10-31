import { access, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { atomicWriteFile, readOptionalFile, withFileLock } from "@openpond/persistence";
import { ToolLearningLocalStore } from "openpond-sdk/tool-learning/node";
import { IS_COMPILED_CLI } from "../build-mode";
import { loadToolLearningCredential, toolLearningHome, toolLearningProducer, type ToolLearningOptions } from "./credentials";
import { externalCaptureVersion, type ExternalCaptureClient } from "./external-client";
import { opencodeCapturePlugin } from "./opencode-plugin";

const Receipt = z.object({ installationId: z.string(), client: z.enum(["codex", "opencode"]), workspaceRoot: z.string(),
  path: z.string(), launcher: z.array(z.string()).min(1), command: z.string(), owned: z.array(z.string()).max(32), installedAt: z.iso.datetime() }).strict();
const receiptPath = (home: string, id: string) => join(home, "tool-learning", `external-${contentHash(id)}.json`);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function readReceipt(home: string, id: string) {
  const raw = await readOptionalFile(receiptPath(home, id));
  const receipt = raw ? Receipt.parse(JSON.parse(raw)) : null;
  if (receipt && receipt.installationId !== id) throw new Error("Capture receipt identity differs from the selected installation.");
  return receipt;
}
function launcherFor(client: ExternalCaptureClient, id: string, home: string) {
  const source = !IS_COMPILED_CLI && /\.[cm]?ts$/u.test(process.argv[1] ?? "");
  return [...(source ? ["/usr/bin/env", `TSX_TSCONFIG_PATH=${resolve(dirname(process.argv[1]!), "../../tsconfig.json")}`] : []),
    process.execPath, ...(IS_COMPILED_CLI ? [] : [...process.execArgv, process.argv[1]!]), "tool-learning", client === "codex" ? "run" : "opencode-hook", id, "--home", home];
}

/** Install an owned project plugin or Codex capture-launcher skill. */
export async function installExternalToolLearning(options: ToolLearningOptions, id: string) {
  if (process.platform === "win32") throw new Error("These external capture adapters are not yet qualified on Windows.");
  const home = toolLearningHome(options), { value: record } = await loadToolLearningCredential(home, id);
  const client = z.enum(["codex", "opencode"]).parse(record.prepared.registration.client);
  if (!record.locallyEnabled || record.installation?.state !== "enabled") throw new Error("Enable this registered installation before installing capture.");
  if (record.prepared.registration.collectionPolicy.purposes.some(p => p !== "capture")) throw new Error("These adapters currently support capture-only connections.");
  const remote = await toolLearningProducer(record).installation(id);
  if (remote.state !== "enabled" || remote.collectionPolicyHash !== record.installation.collectionPolicyHash) throw new Error("The remote collection policy changed. Reconfigure before installing capture.");
  if (await externalCaptureVersion(client) !== record.prepared.registration.clientVersion) throw new Error("Client version changed. Register the installed version.");
  const root = await realpath(record.workspaceRoot), launcher = launcherFor(client, id, home);
  if (launcher.some(v => !v || /[\r\n]/u.test(v))) throw new Error("Invalid capture launcher.");
  const command = launcher.map(quote).join(" ");
  const path = client === "codex" ? join(root, ".agents", "skills", "openpond-fix-it", "SKILL.md") : join(root, ".opencode", "plugins", `openpond-capture-${contentHash(id).slice(0, 16)}.js`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!(await realpath(dirname(path))).startsWith(root + "/")) throw new Error("Capture configuration must remain inside the selected workspace.");
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error("Preserve the linked capture configuration; choose an ordinary workspace configuration file.");
  await withFileLock(join(home, "tool-learning", `external-settings-${contentHash(path)}`), async () => {
    const previous = await readReceipt(home, id), raw = await readOptionalFile(path);
    if (previous && (previous.client !== client || previous.workspaceRoot !== root || previous.path !== path)) throw new Error("Capture receipt scope changed; preserve the existing configuration.");
    if (raw && Buffer.byteLength(raw) > 1048576) throw new Error("Capture configuration exceeds 1 MiB.");
    const plugin = client === "opencode" ? opencodeCapturePlugin(launcher) : `---
name: openpond-fix-it
description: Run a coding task in a fresh Codex CLI session with Fix-it shell-error capture when the user requests it. Does not observe the current desktop chat.
---

Run an authorized task through the installed OpenPond launcher:

\`\`\`sh
${launcher.slice(0, -4).map(quote).join(" ")} run ${quote(id)} --home ${quote(home)} --prompt '<user task>'
\`\`\`

Inspect tool-learning run --help for optional model and sandbox choices. Reuse Codex's existing login and permissions. The launcher observes native structured execution events; ordinary desktop shell calls are outside this connection. Do not recursively launch capture from within an already captured task. Captures go to the ordinary private Fix-it dataset; training requires separate reviewed enrollment. Use tool-learning doctor and flush for connection health and queued evidence. Never interpret a following successful command as proof that the original task was fixed.
`;
    if (raw && !previous?.owned.includes(contentHash(raw)) && raw !== plugin) throw new Error("The capture plugin has user changes. Preserve them before reinstalling.");
    const owned = [...new Set([...(previous?.owned ?? []), contentHash(plugin)])];
    const receipt = Receipt.parse({ installationId: id, client, workspaceRoot: root, path, launcher, command, owned, installedAt: new Date().toISOString() });
    await atomicWriteFile(receiptPath(home, id), JSON.stringify(receipt, null, 2) + "\n");
    await atomicWriteFile(path, plugin, { privateParent: false });
  });
  return { installationId: id, configuration: "installed", settingsPath: path, clientRestartRequired: true,
    clientTrust: client === "codex" ? "Use the installed openpond-fix-it skill to launch a captured Codex CLI task. Desktop chats are not observed." : "Restart OpenCode to load the project plugin.",
    learningEnrollment: false, consultation: "not_installed" };
}

export async function uninstallExternalToolLearning(options: ToolLearningOptions, id: string) {
  const home = toolLearningHome(options), receipt = await readReceipt(home, id);
  if (!receipt) return { installationId: id, configuration: "already_absent" };
  const { value: record } = await loadToolLearningCredential(home, id);
  if (receipt.workspaceRoot !== record.workspaceRoot || receipt.client !== record.prepared.registration.client) throw new Error("Capture receipt scope differs from the installation.");
  await withFileLock(join(home, "tool-learning", `external-settings-${contentHash(receipt.path)}`), async () => {
    if ((await lstat(receipt.path).catch(() => null))?.isSymbolicLink()) throw new Error("Capture configuration became a symlink; the file was preserved.");
    const raw = await readOptionalFile(receipt.path);
    if (!raw) return;
    if (Buffer.byteLength(raw) > 1048576) throw new Error("Capture configuration exceeds 1 MiB.");
    if (!receipt.owned.includes(contentHash(raw))) throw new Error("The installed capture file has user changes; it was preserved.");
    await unlink(receipt.path);
  });
  return { installationId: id, configuration: "removed", retainedData: "Saved dataset records have separate retention." };
}

export async function doctorExternalToolLearning(options: ToolLearningOptions, id: string) {
  const home = toolLearningHome(options), { value: record } = await loadToolLearningCredential(home, id), receipt = await readReceipt(home, id);
  const remote = await toolLearningProducer(record).installation(id), issues: string[] = [];
  let configured = false;
  if (receipt) {
    await access(receipt.launcher[0]!);
    const raw = await readOptionalFile(receipt.path);
    if (raw && Buffer.byteLength(raw) <= 1048576) {
      configured = receipt.owned.includes(contentHash(raw));
    }
    try { await externalCaptureVersion(receipt.client); } catch { issues.push("The installed client version differs from the qualified adapter."); }
  }
  if (!configured) issues.push("Run tool-learning install for this registered installation.");
  const store = new ToolLearningLocalStore(home);
  try {
    const observed = store.clientObservations(id), local = store.status(id);
    if (!observed.some(o => ["start", "resume", "compact", "pre_tool"].includes(String(o.event)))) issues.push("Start a captured client session; Codex uses tool-learning run.");
    if (!record.locallyEnabled || remote.state !== "enabled") issues.push("Collection is disabled or revoked.");
    if (local.pendingEvents) issues.push("Pending evidence remains queued; run tool-learning flush.");
    if (local.droppedEvents) issues.push("Some evidence was excluded by privacy or capacity limits.");
    return { installationId: id, configured, remoteState: remote.state, locallyEnabled: record.locallyEnabled, observed, local, issues, consultation: "not_installed", learningEnrollment: false };
  } finally { store.close(); }
}
