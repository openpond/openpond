import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createTasksetDraft, createTasksetDraftWorkspace, validateTasksetDraftWorkspace, type TasksetDraftWorkspace } from "openpond-sdk/taskset-drafts";
import { OpenPondDatasetWorkspaceClient } from "openpond-sdk/dataset-workspaces";
import { readAccountConfiguration } from "../../../packages/persistence/src/accounts.js";

const { values } = parseArgs({ options: {
  root: { type: "string" }, home: { type: "string" }, team: { type: "string" },
  account: { type: "string", default: "openpondai" }, "api-base-url": { type: "string", default: "https://api.openpond.ai" },
  apply: { type: "boolean", default: false },
} });
if (!values.root || !values.home || !values.team) throw new Error("Provide --root, --home and --team; --apply performs the production upload.");
const root = path.resolve(values.root), teamId = values.team;
const apiBaseUrl = values["api-base-url"];
const revision = "639865fd3374018d6cb29b9fb82dd531406fcf5f";
const repository = "XiaomiMiMo/MiMo-V2.6-RL-oss";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const titles = { code: "Code", cyber: "Cyber", general: "General", music: "Music", webdev: "Webdev" };
const output = path.join(root, "workspaces");
await mkdir(output, { recursive: true });

async function buildWorkspace(domain: keyof typeof titles): Promise<TasksetDraftWorkspace> {
  const retained = path.join(output, `${domain}.json`);
  try {
    const existing = validateTasksetDraftWorkspace(JSON.parse(await readFile(retained, "utf8")));
    if (existing.draft.profileId !== teamId || existing.draft.metadata.sourceRevision !== revision) throw new Error("Retained source upload belongs to a different workspace or revision.");
    return existing;
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const prepared = JSON.parse(await readFile(path.join(root, "prepared", `${domain}.json`), "utf8"));
  if (prepared.repository !== repository || prepared.revision !== revision || prepared.tasks.length !== prepared.descriptor.rows) throw new Error("Prepared source identity/count mismatch.");
  const bytes = await readFile(path.join(root, "source", prepared.descriptor.file));
  if (hash(bytes) !== prepared.descriptor.sha256 || bytes.length !== prepared.descriptor.bytes) throw new Error("Original source file changed after preparation.");
  const timestamp = new Date().toISOString();
  const id = `mimo-${domain}-${revision.slice(0, 12)}-draft`;
  const sourcePath = `source-artifacts/${revision}/${prepared.descriptor.file}`;
  const base = createTasksetDraft({ profileId: teamId, id, name: `MiMo V2.6 RL — ${titles[domain]}`, now: timestamp });
  const workspace = createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", files: [
    { path: sourcePath, contentHash: hash(bytes), sizeBytes: bytes.length, base64: bytes.toString("base64") },
    ...await Promise.all(["README.md", "image-mapping.jsonl"].map(async name => {
      const file = await readFile(path.join(root, "source", name));
      return { path: `source-artifacts/${revision}/${name}`, contentHash: hash(file), sizeBytes: file.length, base64: file.toString("base64") };
    })),
  ], draft: {
    ...base, objective: `Original Xiaomi MiMo ${titles[domain]} tasks. Native source scoring requires the original task environments and graders.`,
    tasks: prepared.tasks,
    sourceRefs: [{ schemaVersion: "openpond.huggingFaceDatasetSource.v1", kind: "huggingface", id: `mimo-${domain}-source`, profileId: teamId,
      title: `Xiaomi MiMo V2.6 RL ${titles[domain]}`, sourceHash: prepared.descriptor.sha256, occurredAt: timestamp,
      repositoryId: repository, repositoryUrl: `https://huggingface.co/datasets/${repository}`, revision, configuration: domain,
      upstreamSplits: ["train"], gated: false, private: false, declaredLicense: "Apache-2.0", sourceFileHashes: [prepared.descriptor.sha256],
      licensingStatus: "review", secretScanStatus: "pending", piiScanStatus: "pending",
      metadata: { originalSourceFile: prepared.descriptor.file, originalRowCount: prepared.descriptor.rows, capturedSourcePath: sourcePath },
    }],
    policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput", "privilegedContextRef"], hiddenGraderRefs: [], connectedAppScopes: [] },
    environment: { ...base.environment, kind: domain === "music" ? "program" : "stateful_harness", entrypoint: `mimo-native-${domain}`,
      stateful: domain !== "music", resources: [{ id: `mimo-${domain}-source`, kind: "file", path: sourcePath,
        mediaType: "application/vnd.apache.parquet", visibility: "privileged", required: true, metadata: { originalSource: true } }],
      metadata: { runtimeReadiness: "native_adapter_required", sourceImageMapping: `source-artifacts/${revision}/image-mapping.jsonl` } },
    capabilities: { ...base.capabilities, taskKind: domain === "music" ? "custom_program" : "single_agent",
      supportedSignals: ["reward"], requiresTools: domain !== "music", requiresState: domain !== "music",
      portabilityBlockers: ["Original native environment and private grading dependency closure must be captured and qualified before scoring."] },
    metadata: { sourceRepository: repository, sourceRevision: revision, sourceDomain: domain, sourceRowCount: prepared.descriptor.rows,
      originalSourceFile: prepared.descriptor.file, sourceFileHash: prepared.descriptor.sha256, buildIntent: "discovery",
      importStatus: "source_captured", runtimeQualification: "pending", nativeGraderStatus: "adapter_required",
      missingAssets: domain === "general" ? ["Original General task-specific environment and verifier assets"] : [],
      sourceHarnesses: { mimoagent: "467f0a19016f0ac4d63b8d17a1f0da9ba07f232c", verl: "a2ad9f6160b03ff2d47e59832bfb6b289f37c917" },
      sourceTaxonomy: prepared.descriptor,
    },
  } });
  await writeFile(retained, JSON.stringify(workspace));
  return workspace;
}

const workspaces = [];
for (const domain of Object.keys(titles) as Array<keyof typeof titles>) {
  const workspace = await buildWorkspace(domain);
  workspaces.push({ domain, workspace });
  console.log(JSON.stringify({ domain, datasetId: workspace.draft.id, tasks: workspace.draft.tasks.length, bytes: Buffer.byteLength(JSON.stringify(workspace)), workspaceHash: workspace.contentHash }));
}
if (values.apply) {
  const config = await readAccountConfiguration(values.home);
  const account = config.accounts?.find(candidate => candidate.handle === values.account && candidate.apiBaseUrl === apiBaseUrl);
  if (!account?.apiKey) throw new Error("The specified local account has no credential for the specified API origin.");
  const accountResponse = await fetch(`${apiBaseUrl}/v1/account`, { headers: { Authorization: `Bearer ${account.apiKey}` }, redirect: "error" });
  const identity = await accountResponse.json();
  if (!accountResponse.ok || identity.account?.handle !== values.account) throw new Error("Production account identity differs from the intended publisher.");
  const client = new OpenPondDatasetWorkspaceClient({ baseUrl: apiBaseUrl, apiKey: account.apiKey, teamId });
  const receipts = [];
  for (const { domain, workspace } of workspaces) {
    const operationId = `mimo-source-upload-${domain}-${revision}-${workspace.contentHash.slice(0, 16)}`;
    const saved = await client.save({ operationId, expectedRevision: 0, workspace, ownerScope: "workspace" });
    const verified = await client.get(saved.datasetId);
    if (verified.workspace.contentHash !== workspace.contentHash || verified.workspace.draft.tasks.length !== workspace.draft.tasks.length) throw new Error("Production readback changed source bytes or task count.");
    const receipt = { domain, apiBaseUrl, publisher: identity.account.handle, teamId, operationId, datasetId: saved.datasetId,
      revision: saved.revision, workspaceHash: verified.workspace.contentHash, taskCount: verified.workspace.draft.tasks.length, status: verified.workspace.draft.status };
    receipts.push(receipt);
    await writeFile(path.join(output, "production-upload-receipts.json"), JSON.stringify(receipts, null, 2));
    console.log(JSON.stringify({ uploaded: true, ...receipt }));
  }
}
