import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, writeFile, readFile, stat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retainAppImageRuntime, removeAppImageRuntimes } from "../src/native-conversations/appimage-runtime.js";

// A foreground AppImage disappears on exit. Concurrent installs must retain a
// coherent private image without replacing the runtime of an existing owner.
test.skipIf(process.platform !== "linux")("AppImage service runtime survives mount loss and concurrent upgrades without trusting foreign storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-appimage-"));
  try {
    const mount = join(root, "mount"), directory = join(root, "collector"), image = join(root, "download.AppImage");
    await mkdir(join(mount, "resources/cli"), { recursive: true });
    const executable = join(mount, "openpond-desktop"), cli = join(mount, "resources/cli/cli.js");
    await writeFile(executable, "fixture"); await writeFile(cli, "fixture");
    const bytes = Buffer.alloc(8192, 3); Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes); Buffer.from([0x41, 0x49, 2]).copy(bytes, 8);
    await writeFile(image, bytes);
    const env = { APPIMAGE: image, APPDIR: mount }, input = { directory, executable, args: [cli] };
    const [first, duplicate] = await Promise.all([retainAppImageRuntime(input, env), retainAppImageRuntime(input, env)]);
    assert(first && duplicate); assert.equal(first.executable, duplicate.executable);
    assert.equal((await stat(first.executable)).mode & 0o777, 0o500);
    assert.equal((await stat(join(directory, "appimage-runtime"))).mode & 0o777, 0o700);
    assert.deepEqual(await readFile(first.executable), bytes);
    bytes[100] = 4; await writeFile(image, bytes);
    const next = await retainAppImageRuntime(input, env); assert(next); assert.notEqual(next.executable, first.executable);
    await chmod(next.executable, 0o700);
    await assert.rejects(retainAppImageRuntime(input, env), /integrity/);
    await chmod(next.executable, 0o500);
    await rm(mount, { recursive: true }); await rm(image);
    assert.equal((await readFile(first.executable))[100], 3); assert.equal((await readFile(next.executable))[100], 4);
    assert.equal(first.args[0], "-e"); assert(first.args[1]!.includes("process.env.APPDIR"));
    await removeAppImageRuntimes(directory); await assert.rejects(stat(first.executable), { code: "ENOENT" });
    await symlink(root, join(directory, "appimage-runtime"));
    await assert.rejects(removeAppImageRuntimes(directory), /unowned/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
