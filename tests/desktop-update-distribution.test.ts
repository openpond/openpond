import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { desktopUpdateManifestName } from "../packages/contracts/src/desktop-updates";
import { selectDesktopUpdateRelease, validateDesktopUpdateManifest } from "../apps/desktop/src/desktop-update-release";
import { installDebUpdate, installPreparedAppImage, prepareAppImageUpdate } from "../apps/desktop/src/desktop-update-install";
import { checkDesktopUpdateAssets } from "../scripts/check-desktop-update-assets";

const hash = (content: string) => createHash("sha512").update(content).digest("base64");

describe("desktop update distribution boundary", () => {
  // A mixed repository release feed must never upgrade a desktop installation
  // to a CLI release, a different channel, architecture, or package format.
  test("selects only newer desktop releases with the right channel manifest", () => {
    const release = (version: string, prerelease = false, platform: "darwin" | "linux" = "linux", arch: "x64" | "arm64" = "x64") => {
      const name = desktopUpdateManifestName(prerelease ? "nightly" : "stable", platform, arch);
      return { tag_name: `v${version}`, draft: false, prerelease, assets: [
        { name, browser_download_url: `https://github.com/openpond/openpond/releases/download/v${version}/${name}` },
      ] };
    };
    const payload = [
      { ...release("9.0.0"), tag_name: "cli-v9.0.0" },
      release("0.3.0-nightly.20261008.1", true),
      release("0.4.0", false, "linux", "arm64"),
      release("0.3.1"), release("0.3.0"), release("0.2.47"),
    ];
    const target = { channel: "stable" as const, platform: "linux" as const, arch: "x64" as const, installedVersion: "0.2.47" };
    expect(selectDesktopUpdateRelease(payload, target)?.version).toBe("0.3.1");
    expect(selectDesktopUpdateRelease(payload, { ...target, channel: "nightly" })?.version).toBe("0.3.0-nightly.20261008.1");
    expect(() => validateDesktopUpdateManifest({ version: "0.3.1", files: [
      { url: "openpond-0.3.1-linux-arm64.AppImage", sha512: hash("wrong architecture") },
    ] }, target, "appimage", "0.3.1")).toThrow("unexpected artifact");
    const linuxFiles = [
      { url: "openpond-0.3.1-linux-x86_64.AppImage", sha512: hash("appimage") },
      { url: "openpond-0.3.1-linux-amd64.deb", sha512: hash("deb") },
    ];
    expect(validateDesktopUpdateManifest({ version: "0.3.1", files: linuxFiles }, target, "appimage", "0.3.1")).toEqual(linuxFiles[0]);
    expect(validateDesktopUpdateManifest({ version: "0.3.1", files: linuxFiles }, target, "deb", "0.3.1")).toEqual(linuxFiles[1]);
    expect(() => validateDesktopUpdateManifest({ version: "0.3.1", files: [
      { url: "openpond-0.3.1-linux-amd64.AppImage", sha512: hash("wrong format architecture") },
    ] }, target, "appimage", "0.3.1")).toThrow("unexpected artifact");
  });

  // Release jobs previously merged same-named Mac manifests. Prove all four
  // independent manifests survive collection and every published hash matches.
  test("validates the complete release matrix and rejects a corrupted artifact", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "openpond-update-assets-"));
    try {
      for (const platform of ["darwin", "linux"] as const) {
        for (const arch of ["x64", "arm64"] as const) {
          const extensions = platform === "darwin" ? ["zip"] : ["AppImage", "deb"];
          const files = [];
          for (const extension of extensions) {
            const packageArch = platform === "linux" && arch === "x64"
              ? extension === "deb" ? "amd64" : "x86_64" : arch;
            const name = `openpond-0.3.0-${platform === "darwin" ? "mac" : "linux"}-${packageArch}.${extension}`;
            await fs.writeFile(path.join(directory, name), name);
            files.push({ url: name, sha512: hash(name) });
          }
          await fs.writeFile(path.join(directory, desktopUpdateManifestName("stable", platform, arch)), stringify({ version: "0.3.0", files }));
        }
      }
      await checkDesktopUpdateAssets({ directory, channel: "stable", version: "0.3.0" });
      await fs.writeFile(path.join(directory, "openpond-0.3.0-mac-arm64.zip"), "corrupt");
      await expect(checkDesktopUpdateAssets({ directory, channel: "stable", version: "0.3.0" })).rejects.toThrow("hash mismatch");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  // A failed update must not unlink the working AppImage; a successful one
  // must preserve the filename referenced by the user's existing shortcuts.
  test("atomically replaces an AppImage only after the staged copy is verified", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "openpond-appimage-update-"));
    const destination = path.join(directory, "My OpenPond.AppImage");
    const downloaded = path.join(directory, "new.AppImage");
    try {
      await fs.writeFile(destination, "old");
      await fs.writeFile(downloaded, "new");
      await expect(prepareAppImageUpdate(downloaded, destination, hash("bad"))).rejects.toThrow("verification");
      expect(await fs.readFile(destination, "utf8")).toBe("old");
      const staged = await prepareAppImageUpdate(downloaded, destination, hash("new"));
      expect(await fs.readFile(destination, "utf8")).toBe("old");
      installPreparedAppImage(staged, destination);
      expect(await fs.readFile(destination, "utf8")).toBe("new");
      expect((await fs.stat(destination)).mode & 0o111).toBe(0o111);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  // Root installation is allowed only for the verified OpenPond package for
  // this channel/version/architecture, using argv rather than shell text.
  test("rejects mismatched DEBs before elevation and handles authorization cancellation", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "openpond-deb-update-"));
    const file = path.join(directory, "a package 'with quotes'.deb");
    try {
      await fs.writeFile(file, "deb fixture");
      const input = { file, sha512: hash("deb fixture"), packageName: "openpond" as const, version: "0.3.0", arch: "x64" as const, elevated: false };
      const wrongPackage = vi.fn(async () => ({ stdout: "another-package\n0.3.0\namd64\n" }));
      await expect(installDebUpdate({ ...input, run: wrongPackage })).rejects.toThrow("does not match");
      expect(wrongPackage).toHaveBeenCalledOnce();
      const cancelled = vi.fn().mockResolvedValueOnce({ stdout: "openpond\n0.3.0\namd64\n" }).mockRejectedValueOnce(new Error("Cancelled"));
      await expect(installDebUpdate({ ...input, run: cancelled })).rejects.toThrow("authorize or install");
      const [command, args] = cancelled.mock.calls[1]!;
      expect(command).toBe("/usr/bin/pkexec");
      expect(args.slice(0, 4)).toEqual(["/usr/bin/apt-get", "install", "--yes", "--no-remove"]);
      expect(path.isAbsolute(args[4])).toBe(true);
      await expect(fs.stat(path.dirname(args[4]))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
