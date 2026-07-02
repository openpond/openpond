import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ReleaseChannel = "stable" | "nightly";

type ElectronBuilderConfig = {
  appId?: string;
  productName?: string;
  artifactName?: string;
  extraMetadata?: Record<string, unknown>;
  linux?: {
    desktop?: {
      entry?: Record<string, string>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function readArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readChannel(input: string | undefined): ReleaseChannel {
  if (input === "stable" || input === "nightly") return input;
  fail(`Expected --channel to be "stable" or "nightly", received: ${input ?? "<empty>"}`);
}

function readVersion(input: string | undefined): string {
  if (!input) fail("Expected --version.");
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Expected --version to be semver-compatible, received: ${input}`);
  }
  return version;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const channel = readChannel(readArg("channel"));
const version = readVersion(readArg("version"));

const productName = channel === "nightly" ? "openpond nightly" : "openpond";
const appPackageName = channel === "nightly" ? "openpond-app-nightly" : "openpond-app";
const appId = channel === "nightly" ? "ai.openpond.app.nightly" : "ai.openpond.app";
const artifactPrefix = channel === "nightly" ? "openpond-nightly" : "openpond";

const baseConfigPath = path.join(root, "apps", "desktop", "electron-builder.json");
const releaseConfigPath = path.join(root, "apps", "desktop", "electron-builder.release.json");
const releaseChannelPath = path.join(root, "apps", "desktop", "dist", "release-channel.json");

const baseConfig = JSON.parse(await readFile(baseConfigPath, "utf8")) as ElectronBuilderConfig;
const releaseConfig: ElectronBuilderConfig = {
  ...baseConfig,
  appId,
  productName,
  artifactName: `${artifactPrefix}-${version}-\${os}-\${arch}.\${ext}`,
  extraMetadata: {
    ...(baseConfig.extraMetadata ?? {}),
    name: appPackageName,
    productName,
    version,
    openpondReleaseChannel: channel,
  },
  linux: {
    ...(baseConfig.linux ?? {}),
    desktop: {
      ...(baseConfig.linux?.desktop ?? {}),
      entry: {
        ...(baseConfig.linux?.desktop?.entry ?? {}),
        Name: productName,
        StartupWMClass: productName,
      },
    },
  },
};

await writeFile(releaseConfigPath, `${JSON.stringify(releaseConfig, null, 2)}\n`);
await mkdir(path.dirname(releaseChannelPath), { recursive: true });
await writeFile(
  releaseChannelPath,
  `${JSON.stringify({ appId, channel, productName, version }, null, 2)}\n`,
);

console.log(`Prepared ${channel} release config for ${productName} ${version}.`);
