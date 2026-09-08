import { z } from "zod";

import { contentHash, type ImmutableReleaseRef } from "./common.js";
import { harnessSourcePackageFiles, validateHarnessSourcePackage } from "./source-package.js";

export const HARNESS_SOURCE_READ_TOOL_NAME = "harness_read_file";
const ReadInputSchema = z.object({
  path: z.string().min(1).max(2_000),
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().positive().max(65_536).default(16_384),
}).strict();

export const HARNESS_SOURCE_READ_TOOL = {
  type: "function" as const,
  function: {
    name: HARNESS_SOURCE_READ_TOOL_NAME,
    description: "Read a byte range from a policy-visible file in the selected immutable Harness release. Paths are relative to that release; private files are unavailable.",
    parameters: {
      type: "object", properties: {
        path: { type: "string" }, offset: { type: "integer", minimum: 0 },
        length: { type: "integer", minimum: 1, maximum: 65_536 },
      }, required: ["path"], additionalProperties: false,
    },
  },
};

type RuntimeTool = { name: string; inputSchema: Record<string, unknown>; definition: Record<string, unknown> };

/** Compile released instructions and Skills into an admitted context. Resource
 * reads use the captured package, never the current workspace or channel. */
export function createHarnessSourceRuntime(input: {
  sourcePackage: unknown;
  expectedRelease: ImmutableReleaseRef;
  baseSystemPrompt: string;
  runtimeId: string;
  tools: RuntimeTool[];
  capabilities?: Array<{ id: string; scopes: string[] }>;
  dependencies?: Record<string, string>;
  maxContextCharacters: number;
}) {
  const source = validateHarnessSourcePackage(input.sourcePackage, input.expectedRelease);
  const files = harnessSourcePackageFiles(source);
  const { agentSnapshot, harnessRelease } = source;
  const text = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`Released Harness source is missing: ${path}`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`Released Harness instruction source is not UTF-8: ${path}`); }
  };
  const program = z.object({ runtimeProtocol: z.literal("openpond.agent-runtime.v1") }).strict();
  if (!program.safeParse(JSON.parse(text(harnessRelease.program.path))).success
    || harnessRelease.metadata.runtimeProtocol !== "openpond.agent-runtime.v1") {
    throw new Error("Released Harness program requires a different execution adapter.");
  }
  if (agentSnapshot.agents.length) throw new Error("This Harness runtime does not execute released subagent programs.");
  const lock = z.object({ dependencies: z.record(z.string(), z.string()) }).strict()
    .parse(JSON.parse(text(agentSnapshot.dependencyLock.path)));
  for (const [name, version] of Object.entries(lock.dependencies)) {
    if (input.dependencies?.[name] !== version) throw new Error(`Released Harness dependency is unavailable: ${name}@${version}`);
  }
  const omittedCapabilities: string[] = [];
  for (const requirement of agentSnapshot.capabilityRequirements) {
    const available = input.capabilities?.find(capability => capability.id === requirement.id);
    if (available && requirement.scopes.every(scope => available.scopes.includes(scope))) continue;
    if (requirement.required) throw new Error(`Released Harness capability is unavailable: ${requirement.id}`);
    omittedCapabilities.push(requirement.id);
  }
  if (input.tools.some(tool => tool.name === HARNESS_SOURCE_READ_TOOL_NAME)) throw new Error("Harness source reader conflicts with a runtime tool.");
  for (const declared of [...agentSnapshot.toolDeclarations, ...harnessRelease.tools]) {
    const available = input.tools.find(tool => tool.name === declared.name);
    if (!available || contentHash(available.inputSchema) !== declared.inputSchemaHash
      || contentHash(declared.inputSchema) !== declared.inputSchemaHash) {
      throw new Error(`Released Harness tool is unavailable or has a different schema: ${declared.name}`);
    }
  }
  const policyFiles = harnessRelease.files.filter(asset => asset.visibility === "policy"
    && asset.path !== harnessRelease.program.path && asset.path !== agentSnapshot.dependencyLock.path);
  const instructionSections = agentSnapshot.instructions.map(asset => `Released instruction (${asset.path}):\n${text(asset.path)}`);
  const skillSections = agentSnapshot.skills.map(asset => `Released Skill (${asset.path}):\n${text(asset.path)}`);
  const systemPrompt = [input.baseSystemPrompt,
    ...instructionSections,
    skillSections.length ? "Apply the following released Skills when relevant to the task. Read their referenced resources from the selected release with harness_read_file." : "",
    ...skillSections,
    policyFiles.length ? `Selected Harness files (paths relative to the release):\n${policyFiles.map(asset => asset.path).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  if (!Number.isSafeInteger(input.maxContextCharacters) || input.maxContextCharacters <= 0
    || systemPrompt.length > input.maxContextCharacters) throw new Error("Released Harness context exceeds the runtime's admitted context limit.");
  const readerFiles = new Map(policyFiles.map(asset => [asset.path, asset]));
  const tools = policyFiles.length ? [HARNESS_SOURCE_READ_TOOL] : [];
  const receipt = {
    schemaVersion: "openpond.harnessSourceRuntimeReceipt.v1" as const,
    runtimeId: input.runtimeId,
    harnessRelease: { id: harnessRelease.id, contentHash: harnessRelease.contentHash },
    sourcePackageHash: source.contentHash,
    systemPromptHash: contentHash(systemPrompt),
    instructionAssets: agentSnapshot.instructions.map(asset => ({ path: asset.path, contentHash: asset.contentHash })),
    skillAssets: agentSnapshot.skills.map(asset => ({ path: asset.path, contentHash: asset.contentHash })),
    readableAssets: policyFiles.map(asset => ({ path: asset.path, contentHash: asset.contentHash })),
    toolContractHash: contentHash([...input.tools.map(tool => tool.definition), ...tools]),
    omittedCapabilities,
  };
  return {
    systemPrompt,
    tools,
    receipt: { ...receipt, contentHash: contentHash(receipt) },
    readFile(value: unknown) {
      const request = ReadInputSchema.parse(value);
      const asset = readerFiles.get(request.path);
      if (!asset) throw new Error("Harness source file is not policy-visible in the selected release.");
      const bytes = files.get(request.path)!;
      if (request.offset > bytes.length) throw new Error("Harness source read offset exceeds the file size.");
      const end = Math.min(bytes.length, request.offset + request.length);
      const chunk = bytes.subarray(request.offset, end);
      let content: string;
      let encoding: "utf8" | "base64" = "utf8";
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(chunk); }
      catch { encoding = "base64"; content = btoa(Array.from(chunk, byte => String.fromCharCode(byte)).join("")); }
      return { path: asset.path, contentHash: asset.contentHash, mediaType: asset.mediaType,
        sizeBytes: asset.sizeBytes, offset: request.offset, nextOffset: end, eof: end === bytes.length, encoding, content };
    },
  };
}
