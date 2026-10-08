import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { installAcpAgent } from "../apps/server/src/runtime/native-agents/acp-install.js";
import { AcpRegistryAgentSchema, acpPackageLaunch, chooseAcpDistribution } from "../apps/server/src/runtime/native-agents/acp-registry.js";

// Registry downloads are executable inputs. Invalid paths/digests must fail
// before publication, while supported formats retain exact version/launch data.
it("installs supported registry distributions and rejects malicious archives before publishing them", async () => {
  const home = await mkdtemp(join(tmpdir(), "openpond-acp-install-"));
  const fixture = (archive: string, sha256?: string) => AcpRegistryAgentSchema.parse({ id: "fixture", name: "Fixture", version: "1.2.3", distribution: { binary: { "linux-x86_64": { archive, cmd: "./agent", args: ["--acp"], env: { ACP_TEST: "1" }, sha256 } } } });
  let content: Uint8Array = new Uint8Array();
  const download = vi.fn(async () => new Response(content));
  vi.stubGlobal("fetch", download);
  try {
    const zip = Buffer.from("UEsDBBQAAAAAAOhiSF1/MjUhFwAAABcAAAAFAAAAYWdlbnQjIS9iaW4vc2gKcHJpbnRmIEFDUFxuClBLAQIUAxQAAAAAAOhiSF1/MjUhFwAAABcAAAAFAAAAAAAAAAAAAACAAQAAAABhZ2VudFBLBQYAAAAAAQABADMAAAA6AAAAAAA=", "base64");
    const escape = Buffer.from("UEsDBBQAAAAAAOhiSF1/MjUhFwAAABcAAAAKAAAALi4vZXNjYXBlZCMhL2Jpbi9zaApwcmludGYgQUNQXG4KUEsBAhQDFAAAAAAA6GJIXX8yNSEXAAAAFwAAAAoAAAAAAAAAAAAAAIABAAAAAC4uL2VzY2FwZWRQSwUGAAAAAAEAAQA4AAAAPwAAAAAA", "base64");
    const gzip = Buffer.from("H4sIAHTDx2oC/+3NOwrCQAAE0K1ziogHyCLErcULeACbCH7SLJKs93dJI9grgu81M0wzw/WcS/isWKW+X7J6zxg36dWXfZtSDG0MX/CYyzDVy/Cf1qvuNOZuvjX3aczl0u72h2NuAgAAAAAAAAAAAL/tCYAIPeEAKAAA", "base64");
    const bzip = Buffer.from("QlpoOTFBWSZTWRsV2XAAAHLfgMqYaADTgCgAQAxz4V4ACAggAHUQKNGjTQAbUD1MQSkmjI0BkAAGkfaiRBAbKgggvy1o90zEBBQd9LOXxgyE7lINIBBDEDzvZRsbN28QpQoQRT8kvXsYktcnT5cU8REQ/F3JFOFCQGxXZcA=", "base64");
    const link = Buffer.from("H4sIAHTDx2oC/+3OSwoCMRAE0BzFE2TiZ8h5ggZ3IiZzf8Msx3UWwnsUVO+6yrO+epgrDXld9x6O/XufU77ewukS4zJS272862PSuK318hnvAwAAAAAAAAAAAPyPLx9ehzsAKAAA", "base64");
    for (const [format, bytes] of [["zip", zip], ["tar.gz", gzip], ["tar.bz2", bzip], ["", Buffer.from("#!/bin/sh\nexit 0\n")]] as const) {
      content = bytes;
      const archive = `https://registry.example/agent${format ? `.${format}` : ""}`;
      const agent = fixture(archive, createHash("sha256").update(bytes).digest("hex"));
      // Give the selected binary this machine's exact platform key.
      const spec = agent.distribution.binary!["linux-x86_64"]!;
      agent.distribution.binary = { [`${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`]: spec };
      const launch = await installAcpAgent(home, agent, "binary");
      expect(await readFile(launch.command)).toEqual(format ? Buffer.from("#!/bin/sh\nprintf ACP\\n\n") : bytes);
      expect(launch).toMatchObject({ args: ["--acp"], env: { ACP_TEST: "1" }, registryId: "fixture", version: "1.2.3" });
      const calls = download.mock.calls.length;
      expect(await installAcpAgent(home, agent, "binary")).toEqual(launch);
      expect(download.mock.calls.length).toBe(calls);
    }
    const agentFor = (archive: string, sha256?: string) => {
      const agent = fixture(archive, sha256); const spec = agent.distribution.binary!["linux-x86_64"]!;
      agent.distribution.binary = { [`${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`]: spec }; return agent;
    };
    const published = await readdir(join(home, "runtime", "acp-agents"));
    content = zip;
    await expect(installAcpAgent(home, agentFor("https://registry.example/wrong.zip", "0".repeat(64)))).rejects.toThrow("checksum");
    content = escape;
    await expect(installAcpAgent(home, agentFor("https://registry.example/escape.zip"))).rejects.toThrow("unsafe path");
    content = link;
    await expect(installAcpAgent(home, agentFor("https://registry.example/link.tar.gz"))).rejects.toThrow("links or special files");
    expect(await readdir(join(home, "runtime", "acp-agents"))).toEqual(published);
    await expect(readFile(join(dirname(home), "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
    const packages = AcpRegistryAgentSchema.parse({ id: "package", name: "Package", version: "1.2.3", distribution: { npx: { package: "@example/agent@1.2.3", args: ["--acp"] }, uvx: { package: "example-agent@1.2.3", args: ["--acp"] } } });
    expect(acpPackageLaunch(packages, chooseAcpDistribution(packages, "npx")! as Exclude<ReturnType<typeof chooseAcpDistribution>, { kind: "binary" } | null>)).toMatchObject({ command: "npx", args: ["--yes", "@example/agent@1.2.3", "--acp"] });
    expect(acpPackageLaunch(packages, chooseAcpDistribution(packages, "uvx")! as Exclude<ReturnType<typeof chooseAcpDistribution>, { kind: "binary" } | null>)).toMatchObject({ command: "uvx", args: ["example-agent==1.2.3", "--acp"] });
    expect(() => acpPackageLaunch(packages, { kind: "npx", spec: { package: "--unsafe", args: [], env: {} } })).toThrow("version-pinned");
  } finally { vi.unstubAllGlobals(); await rm(home, { recursive: true, force: true }); }
});
