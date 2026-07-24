import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PINNED_REGCTL_VERSION = "v0.11.5";
export const PINNED_WORKER_BASE =
  "primeintellect/prime-rl@sha256:eae2df21d34ddfdc0065390b4f3261ff691ea4ebd281630f64aacc60855c0c37";
export const PINNED_PRIME_RL_REVISION =
  "e0d60e4d85ea636873acb2e7083e794740d20226";
const IMAGE_MEDIA_TYPE =
  "application/vnd.oci.image.manifest.v1+json";
const EXPECTED_ENVIRONMENT = {
  PYTHONUNBUFFERED: "1",
  PYTHONPATH: "/opt/openpond-training/src",
  OPENPOND_CONNECTED_WORKER_STATE_DIR: "/var/lib/openpond-worker/state",
  OPENPOND_PRIME_RL_MODEL_CACHE: "/var/lib/openpond-worker/model-cache",
  UV_CACHE_DIR: "/var/lib/openpond-worker/uv-cache",
  HF_HOME: "/var/lib/openpond-worker/huggingface",
} as const;
const CONTEXT_ROOT_FILES = [
  "Dockerfile.worker",
  "LICENSE",
  "pyproject.toml",
  "worker-directory.keep",
  "worker-sbom.cdx.json",
] as const;

type CommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

type ImageManifest = {
  mediaType?: string;
  schemaVersion?: number;
  config?: { digest?: string; size?: number };
  layers?: Array<{
    mediaType?: string;
    digest?: string;
    size?: number;
  }>;
  manifests?: Array<{
    digest?: string;
    platform?: { architecture?: string; os?: string };
  }>;
};

type ImageConfig = {
  architecture?: string;
  os?: string;
  config?: {
    User?: string;
    WorkingDir?: string;
    Entrypoint?: string[];
    Cmd?: string[] | null;
    Env?: string[];
    Labels?: Record<string, string>;
  };
  rootfs?: { diff_ids?: string[] };
};

export type WorkerImagePublication = {
  schemaVersion: "openpond.workerImagePublication.v1";
  targetRef: string;
  targetDigest: string;
  imageSizeBytes: number;
  contextSha256: string;
  sourceIndexRef: string;
  sourceManifestDigest: string;
  sourceLayerCount: number;
  workerLayerDigest: string;
  publishedAt: string;
};

type PublishOptions = {
  regctlPath: string;
  gcloudPath: string;
  targetRepository: string;
  projectDirectory: string;
  openpondRelease: string;
  publishedAt: string;
};

function argument(name: string, required = true): string | null {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((candidate) => candidate.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value && required) {
    throw new Error(`Missing ${prefix}<value>.`);
  }
  return value ?? null;
}

function parseOptions(): PublishOptions {
  const publishedAt = argument("published-at")!;
  if (!Number.isFinite(Date.parse(publishedAt))) {
    throw new Error("Worker publication time must be an ISO timestamp.");
  }
  const openpondRelease = argument("openpond-release")!;
  if (!/^\d+\.\d+\.\d+$/.test(openpondRelease)) {
    throw new Error("OpenPond release must be an exact semantic version.");
  }
  const targetRepository = argument("target-repository")!;
  if (
    !/^[a-z0-9.-]+\/[a-z0-9._/-]+$/.test(targetRepository) ||
    targetRepository.includes("@") ||
    targetRepository.includes(":")
  ) {
    throw new Error("Target repository must not contain a tag or digest.");
  }
  return {
    regctlPath: path.resolve(argument("regctl")!),
    gcloudPath: argument("gcloud", false) ?? "gcloud",
    targetRepository,
    projectDirectory: path.resolve(
      argument("project-directory", false) ??
        "python/openpond-training",
    ),
    openpondRelease,
    publishedAt: new Date(publishedAt).toISOString(),
  };
}

async function filesInDirectory(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Worker image context contains a symlink: ${relative}`);
    }
    if (metadata.isDirectory()) {
      files.push(...await filesInDirectory(absolute, relative));
    } else if (metadata.isFile()) {
      files.push(relative);
    } else {
      throw new Error(
        `Worker image context contains an unsupported file: ${relative}`,
      );
    }
  }
  return files;
}

export async function hashWorkerImageContext(
  projectDirectory: string,
): Promise<string> {
  const files = [
    ...CONTEXT_ROOT_FILES,
    ...(await filesInDirectory(
      path.join(projectDirectory, "src"),
      "src",
    )),
  ].sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    const content = await readFile(path.join(projectDirectory, relative));
    digest.update(relative);
    digest.update("\0");
    digest.update(String(content.byteLength));
    digest.update("\0");
    digest.update(content);
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function createRegctlModificationArguments(input: {
  sourceManifestRef: string;
  targetRef: string;
  layerTarPath: string;
  openpondRelease: string;
  publishedAt: string;
  contextSha256: string;
}): string[] {
  return [
    "image",
    "mod",
    input.sourceManifestRef,
    "--create",
    input.targetRef,
    "--layer-add",
    `tar=${input.layerTarPath}`,
    "--to-oci",
    "--config-entrypoint",
    '["python","-m","openpond_training.connected_worker"]',
    "--config-cmd",
    "",
    ...Object.entries(EXPECTED_ENVIRONMENT).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--label",
    "org.opencontainers.image.title=OpenPond connected prime-rl worker",
    "--label",
    `org.opencontainers.image.version=${input.openpondRelease}`,
    "--label",
    `org.opencontainers.image.revision=${PINNED_PRIME_RL_REVISION}`,
    "--label",
    "ai.openpond.worker.protocol=openpond.connectedWorker.v1",
    "--label",
    "ai.openpond.worker.engine=connected-prime-rl",
    "--label",
    `ai.openpond.worker.upstream-image.digest=${
      PINNED_WORKER_BASE.split("@")[1]
    }`,
    "--label",
    `ai.openpond.worker.context-sha256=${input.contextSha256}`,
  ];
}

async function stageWorkerLayer(
  projectDirectory: string,
  temporaryDirectory: string,
  run: CommandRunner,
): Promise<string> {
  const layerDirectory = path.join(temporaryDirectory, "layer");
  const applicationDirectory = path.join(
    layerDirectory,
    "opt/openpond-training",
  );
  await mkdir(applicationDirectory, { recursive: true });
  for (const name of [
    "LICENSE",
    "pyproject.toml",
    "worker-sbom.cdx.json",
  ]) {
    await copyFile(
      path.join(projectDirectory, name),
      path.join(applicationDirectory, name),
    );
  }
  await cp(
    path.join(projectDirectory, "src"),
    path.join(applicationDirectory, "src"),
    { recursive: true, dereference: false, verbatimSymlinks: true },
  );
  for (const directory of [
    "state",
    "model-cache",
    "huggingface",
    "uv-cache",
  ]) {
    const destination = path.join(
      layerDirectory,
      "var/lib/openpond-worker",
      directory,
    );
    await mkdir(destination, { recursive: true });
    await copyFile(
      path.join(projectDirectory, "worker-directory.keep"),
      path.join(destination, ".keep"),
    );
  }
  const layerTarPath = path.join(temporaryDirectory, "worker-layer.tar");
  await run("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=1000",
    "--group=1000",
    "--numeric-owner",
    "--mode=u+rwX,go+rX,go-w",
    "--format=posix",
    "--pax-option=delete=atime,delete=ctime",
    "-cf",
    layerTarPath,
    "-C",
    layerDirectory,
    ".",
  ]);
  return layerTarPath;
}

function environmentMap(config: ImageConfig): Map<string, string> {
  return new Map(
    (config.config?.Env ?? []).flatMap((item) => {
      const separator = item.indexOf("=");
      return separator < 1
        ? []
        : [[item.slice(0, separator), item.slice(separator + 1)]];
    }),
  );
}

export function verifyPublishedWorkerImage(input: {
  sourceManifest: ImageManifest;
  sourceConfig: ImageConfig;
  targetManifest: ImageManifest;
  targetConfig: ImageConfig;
  contextSha256: string;
  openpondRelease: string;
}): { imageSizeBytes: number; workerLayerDigest: string } {
  const sourceLayers = input.sourceManifest.layers ?? [];
  const targetLayers = input.targetManifest.layers ?? [];
  if (
    input.targetManifest.schemaVersion !== 2 ||
    input.targetManifest.mediaType !== IMAGE_MEDIA_TYPE ||
    targetLayers.length !== sourceLayers.length + 1
  ) {
    throw new Error("Published worker manifest has invalid layer lineage.");
  }
  for (let index = 0; index < sourceLayers.length; index += 1) {
    if (
      sourceLayers[index]?.digest !== targetLayers[index]?.digest ||
      sourceLayers[index]?.size !== targetLayers[index]?.size
    ) {
      throw new Error("Published worker manifest changed a base layer.");
    }
  }
  const sourceDiffIds = input.sourceConfig.rootfs?.diff_ids ?? [];
  const targetDiffIds = input.targetConfig.rootfs?.diff_ids ?? [];
  if (
    targetDiffIds.length !== sourceDiffIds.length + 1 ||
    sourceDiffIds.some(
      (digest, index) => targetDiffIds[index] !== digest,
    )
  ) {
    throw new Error("Published worker config changed base filesystem lineage.");
  }
  const config = input.targetConfig.config;
  if (
    input.targetConfig.architecture !== "amd64" ||
    input.targetConfig.os !== "linux" ||
    config?.User !== "appuser" ||
    config.WorkingDir !== "/app" ||
    JSON.stringify(config.Entrypoint) !==
      '["python","-m","openpond_training.connected_worker"]' ||
    (config.Cmd?.length ?? 0) !== 0
  ) {
    throw new Error("Published worker runtime binding is invalid.");
  }
  const environment = environmentMap(input.targetConfig);
  for (const [name, value] of Object.entries(EXPECTED_ENVIRONMENT)) {
    if (environment.get(name) !== value) {
      throw new Error(`Published worker environment is missing ${name}.`);
    }
  }
  const labels = config.Labels ?? {};
  if (
    labels["org.opencontainers.image.version"] !== input.openpondRelease ||
    labels["org.opencontainers.image.revision"] !==
      PINNED_PRIME_RL_REVISION ||
    labels["ai.openpond.worker.protocol"] !==
      "openpond.connectedWorker.v1" ||
    labels["ai.openpond.worker.engine"] !== "connected-prime-rl" ||
    labels["ai.openpond.worker.context-sha256"] !== input.contextSha256
  ) {
    throw new Error("Published worker labels do not bind the release.");
  }
  const workerLayer = targetLayers.at(-1);
  if (
    !workerLayer?.digest?.startsWith("sha256:") ||
    !Number.isSafeInteger(workerLayer.size) ||
    (workerLayer.size ?? 0) <= 0
  ) {
    throw new Error("Published worker layer descriptor is invalid.");
  }
  const imageSizeBytes = [
    input.targetManifest.config,
    ...targetLayers,
  ].reduce((total, descriptor) => total + (descriptor?.size ?? 0), 0);
  if (!Number.isSafeInteger(imageSizeBytes) || imageSizeBytes <= 0) {
    throw new Error("Published worker image size is invalid.");
  }
  return {
    imageSizeBytes,
    workerLayerDigest: workerLayer.digest,
  };
}

async function rawJson<T>(
  run: CommandRunner,
  regctlPath: string,
  args: string[],
): Promise<T> {
  const result = await run(regctlPath, args);
  return JSON.parse(result.stdout) as T;
}

function sourceRepository(ref: string): string {
  return ref.slice(0, ref.indexOf("@"));
}

async function authenticateRegctl(input: {
  regctlPath: string;
  gcloudPath: string;
  targetRegistry: string;
  configPath: string;
}): Promise<CommandRunner> {
  const tokenResult = await execFileAsync(input.gcloudPath, [
    "auth",
    "application-default",
    "print-access-token",
  ], { maxBuffer: 1024 * 1024 });
  const token = tokenResult.stdout.trim();
  if (!token || /\s/.test(token)) {
    throw new Error("GCP ADC returned an invalid access token.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      input.regctlPath,
      [
        "registry",
        "login",
        input.targetRegistry,
        "--user",
        "oauth2accesstoken",
        "--pass-stdin",
      ],
      {
        env: {
          ...process.env,
          REGCTL_CONFIG: input.configPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `regctl registry login failed (${code}): ${
              stderr.trim() || stdout.trim()
            }`,
          ),
        );
      }
    });
    child.stdin.end(token);
  });
  return (file, args) =>
    execFileAsync(file, args, {
      env: {
        ...process.env,
        REGCTL_CONFIG: input.configPath,
      },
      maxBuffer: 32 * 1024 * 1024,
    });
}

async function publish(
  options: PublishOptions,
  injectedRun?: CommandRunner,
): Promise<WorkerImagePublication> {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "openpond-worker-image-publish-"),
  );
  try {
    const run = injectedRun ?? await authenticateRegctl({
      regctlPath: options.regctlPath,
      gcloudPath: options.gcloudPath,
      targetRegistry: options.targetRepository.split("/")[0]!,
      configPath: path.join(temporaryDirectory, "regctl-config.json"),
    });
    const version = await run(options.regctlPath, ["version"]);
    if (!version.stdout.includes(`VCSTag:     ${PINNED_REGCTL_VERSION}`)) {
      throw new Error(`regctl ${PINNED_REGCTL_VERSION} is required.`);
    }
    const contextSha256 = await hashWorkerImageContext(
      options.projectDirectory,
    );
    const targetRef =
      `${options.targetRepository}:v${options.openpondRelease}-${
        contextSha256.slice(0, 12)
      }`;
    const sourceIndex = await rawJson<ImageManifest>(
      run,
      options.regctlPath,
      ["manifest", "get", PINNED_WORKER_BASE, "--format", "raw-body"],
    );
    const sourceManifestDigest = sourceIndex.manifests?.find(
      (descriptor) =>
        descriptor.platform?.architecture === "amd64" &&
        descriptor.platform?.os === "linux",
    )?.digest;
    if (!sourceManifestDigest?.startsWith("sha256:")) {
      throw new Error("Pinned worker base has no linux/amd64 manifest.");
    }
    const sourceManifestRef =
      `${sourceRepository(PINNED_WORKER_BASE)}@${sourceManifestDigest}`;
    const [sourceManifest, sourceConfig] = await Promise.all([
      rawJson<ImageManifest>(run, options.regctlPath, [
        "manifest",
        "get",
        sourceManifestRef,
        "--format",
        "raw-body",
      ]),
      rawJson<ImageConfig>(run, options.regctlPath, [
        "image",
        "inspect",
        sourceManifestRef,
        "--format",
        "raw-body",
      ]),
    ]);
    const layerTarPath = await stageWorkerLayer(
      options.projectDirectory,
      temporaryDirectory,
      run,
    );
    await run(
      options.regctlPath,
      createRegctlModificationArguments({
        sourceManifestRef,
        targetRef,
        layerTarPath,
        openpondRelease: options.openpondRelease,
        publishedAt: options.publishedAt,
        contextSha256,
      }),
    );
    const [targetManifest, targetConfig, targetDigestResult] =
      await Promise.all([
        rawJson<ImageManifest>(run, options.regctlPath, [
          "manifest",
          "get",
          targetRef,
          "--format",
          "raw-body",
        ]),
        rawJson<ImageConfig>(run, options.regctlPath, [
          "image",
          "inspect",
          targetRef,
          "--format",
          "raw-body",
        ]),
        run(options.regctlPath, ["image", "digest", targetRef]),
      ]);
    const targetDigest = targetDigestResult.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(targetDigest)) {
      throw new Error("Published worker image digest is invalid.");
    }
    const verified = verifyPublishedWorkerImage({
      sourceManifest,
      sourceConfig,
      targetManifest,
      targetConfig,
      contextSha256,
      openpondRelease: options.openpondRelease,
    });
    return {
      schemaVersion: "openpond.workerImagePublication.v1",
      targetRef,
      targetDigest,
      imageSizeBytes: verified.imageSizeBytes,
      contextSha256,
      sourceIndexRef: PINNED_WORKER_BASE,
      sourceManifestDigest,
      sourceLayerCount: sourceManifest.layers?.length ?? 0,
      workerLayerDigest: verified.workerLayerDigest,
      publishedAt: options.publishedAt,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  process.stdout.write(
    `${JSON.stringify(await publish(parseOptions()))}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
