import { promises as fs } from "node:fs";
import path from "node:path";

import {
  parseProfileWorkflowPrompt,
  ProfileWorkflowActionSourceSchema,
  ProfileWorkflowCatalogSchema,
  ProfileWorkflowPromptMetadataSchema,
} from "@openpond/harness";
import { stringify as stringifyYaml } from "yaml";

import type { ChatWorkflow } from "@openpond/contracts";

function packageDirectory(sourcePath: string, workflowId: string): string {
  if (!/^[a-z][a-z0-9_-]{0,119}$/.test(workflowId)) throw new Error("Invalid Profile Workflow identity.");
  return path.join(sourcePath, "workflows", workflowId);
}

function authoredPrompt(input: {
  name: string;
  description: string;
  instructions: string;
  skillPaths: string[];
  assetPaths?: string[];
}): string {
  const metadata = ProfileWorkflowPromptMetadataSchema.parse({
    name: input.name,
    description: input.description,
    ...(input.skillPaths.length ? { skillPaths: input.skillPaths } : {}),
    ...(input.assetPaths?.length ? { assetPaths: input.assetPaths } : {}),
  });
  if (!input.instructions.trim()) throw new Error("Profile Workflow prompt is empty.");
  return `---\n${stringifyYaml(metadata)}---\n${input.instructions}`;
}

async function writePromptPackage(input: {
  sourcePath: string;
  id: string;
  name: string;
  description: string;
  instructions: string;
  skillPaths: string[];
  preserveExistingMetadata?: boolean;
}): Promise<void> {
  const directory = packageDirectory(input.sourcePath, input.id);
  await fs.mkdir(directory, { recursive: true });
  const existing = input.preserveExistingMetadata
    ? await fs.readFile(path.join(directory, "PROMPT.md"), "utf8").catch(() => null)
    : null;
  const metadata = existing ? parseProfileWorkflowPrompt(existing).metadata : null;
  await fs.writeFile(path.join(directory, "PROMPT.md"), authoredPrompt({
    ...input,
    description: metadata?.description ?? input.description,
    skillPaths: metadata?.skillPaths ?? input.skillPaths,
    assetPaths: metadata?.assetPaths,
  }));
}

/** One-way, repeatable migration of the old authoring index. */
export async function migrateLegacyWorkflowCatalog(sourcePath: string): Promise<string[]> {
  const catalogPath = path.join(sourcePath, "workflows", "catalog.json");
  const source = await fs.readFile(catalogPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return [];
  const catalog = ProfileWorkflowCatalogSchema.parse(JSON.parse(source));
  for (const workflow of catalog.workflows) {
    const directory = packageDirectory(sourcePath, workflow.id);
    const existing = await fs.lstat(directory).catch(() => null);
    if (!existing) continue;
    const expected = workflow.invocation.kind === "instructions"
      ? authoredPrompt({ name: workflow.label, description: workflow.description, instructions: workflow.invocation.instructions, skillPaths: workflow.skillPaths })
      : `${JSON.stringify(ProfileWorkflowActionSourceSchema.parse({
          actionId: workflow.invocation.actionId,
          name: workflow.label,
          description: workflow.description,
          inputSchema: workflow.inputSchema,
          skillPaths: workflow.skillPaths,
        }), null, 2)}\n`;
    const actual = await fs.readFile(path.join(directory, workflow.invocation.kind === "instructions" ? "PROMPT.md" : "ACTION.json"), "utf8").catch(() => null);
    if (actual !== expected) throw new Error(`Legacy Workflow ${workflow.id} conflicts with an existing package.`);
  }
  for (const workflow of catalog.workflows) {
    const directory = packageDirectory(sourcePath, workflow.id);
    await fs.mkdir(directory, { recursive: true });
    if (workflow.invocation.kind === "instructions") {
      await writePromptPackage({
        sourcePath, id: workflow.id, name: workflow.label, description: workflow.description,
        instructions: workflow.invocation.instructions, skillPaths: workflow.skillPaths,
      });
    } else {
      const action = ProfileWorkflowActionSourceSchema.parse({
        actionId: workflow.invocation.actionId,
        name: workflow.label,
        description: workflow.description,
        inputSchema: workflow.inputSchema,
        skillPaths: workflow.skillPaths,
      });
      await fs.writeFile(path.join(directory, "ACTION.json"), `${JSON.stringify(action, null, 2)}\n`);
    }
  }
  await fs.rm(catalogPath);
  return catalog.workflows.map((workflow) => workflow.id);
}

export async function saveChatWorkflowPackage(input: { sourcePath: string; workflow: ChatWorkflow }): Promise<void> {
  await migrateLegacyWorkflowCatalog(input.sourcePath);
  const id = input.workflow.profileWorkflowId;
  if (!id) throw new Error("Chat Workflow has no Profile Workflow identity.");
  await writePromptPackage({
    sourcePath: input.sourcePath,
    id,
    name: input.workflow.name,
    description: `Scheduled Chat Workflow ${input.workflow.id}.`,
    instructions: input.workflow.prompt,
    skillPaths: [],
    preserveExistingMetadata: true,
  });
}

export async function readChatWorkflowPackage(input: {
  sourcePath: string;
  workflowId: string;
}): Promise<{ name: string; prompt: string }> {
  const directory = packageDirectory(input.sourcePath, input.workflowId);
  const { metadata, instructions } = parseProfileWorkflowPrompt(await fs.readFile(path.join(directory, "PROMPT.md"), "utf8"));
  if (!instructions.trim()) throw new Error(`Profile Workflow ${input.workflowId} prompt is empty.`);
  return { name: metadata.name ?? input.workflowId.replace(/[-_]/g, " "), prompt: instructions };
}
