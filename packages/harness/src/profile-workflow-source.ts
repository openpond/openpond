import { parseDocument } from "yaml";
import { z } from "zod";

import { ProfileWorkflowCatalogSchema, validateProfileWorkflowCatalog, type ProfileWorkflowCatalog } from "./profile-workflows.js";

const PortablePathSchema = z.string().min(1).max(2_000).refine((value) =>
  !value.includes("\\") && !value.includes(":") && !value.startsWith("/")
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "source paths must be portable relative paths",
);
const WorkflowIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,119}$/);
const EmptyInputSchema = { type: "object", properties: {}, additionalProperties: false };

/** Prompt packages need only PROMPT.md. Frontmatter is optional display
 * metadata; the Markdown body is the exact instruction text. */
export const ProfileWorkflowPromptMetadataSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(4_000).optional(),
  skillPaths: z.array(PortablePathSchema).max(100).optional(),
  assetPaths: z.array(PortablePathSchema).max(100).optional(),
}).strict();

/** Code-backed Workflows need an explicit Agent action reference. */
export const ProfileWorkflowActionSourceSchema = z.object({
  actionId: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(240),
  description: z.string().max(4_000).default(""),
  inputSchema: z.record(z.string(), z.unknown()).default(EmptyInputSchema),
  skillPaths: z.array(PortablePathSchema).max(100).default([]),
  assetPaths: z.array(PortablePathSchema).max(100).default([]),
}).strict();

export function parseProfileWorkflowPrompt(markdown: string): {
  instructions: string;
  metadata: z.infer<typeof ProfileWorkflowPromptMetadataSchema>;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) return { instructions: markdown, metadata: {} };
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid Workflow prompt frontmatter: ${document.errors[0]!.message}`);
  return {
    instructions: markdown.slice(match[0].length),
    metadata: ProfileWorkflowPromptMetadataSchema.parse(document.toJS()),
  };
}

/** Pure package compiler: the filesystem adapter supplies relative files. */
export function compileProfileWorkflowPackages(input: {
  files: ReadonlyMap<string, string>;
  skillPaths: ReadonlySet<string>;
  actionIds: ReadonlySet<string>;
}): { catalog: ProfileWorkflowCatalog; referencedPaths: string[] } {
  const primaryPaths = [...input.files.keys()]
    .filter((file) => /^workflows\/[^/]+\/(PROMPT\.md|ACTION\.json)$/.test(file))
    .sort();
  const workflows: ProfileWorkflowCatalog["workflows"] = [];
  const referencedPaths = new Set<string>();
  const ids = new Set<string>();
  for (const file of primaryPaths) {
    const id = file.split("/")[1]!;
    WorkflowIdSchema.parse(id);
    if (ids.has(id)) throw new Error(`Profile Workflow ${id} has multiple primary files.`);
    ids.add(id);
    referencedPaths.add(file);
    const directory = `workflows/${id}`;
    const source = input.files.get(file)!;
    const prompt = file.endsWith("/PROMPT.md") ? parseProfileWorkflowPrompt(source) : null;
    const action = prompt ? null : ProfileWorkflowActionSourceSchema.parse(JSON.parse(source));
    if (prompt && (!prompt.instructions.trim() || prompt.instructions.length > 100_000)) {
      throw new Error(`Profile Workflow ${id} needs a nonempty Markdown prompt under 100000 characters.`);
    }
    const assetPaths = prompt?.metadata.assetPaths ?? action?.assetPaths ?? [];
    for (const asset of assetPaths) {
      const assetPath = `${directory}/${asset}`;
      if (!input.files.has(assetPath)) throw new Error(`Profile Workflow ${id} references missing asset ${assetPath}.`);
      referencedPaths.add(assetPath);
    }
    workflows.push({
      id,
      label: prompt?.metadata.name ?? action?.name ?? id.replace(/[-_]/g, " "),
      description: prompt?.metadata.description ?? action?.description ?? "",
      inputSchema: action?.inputSchema ?? EmptyInputSchema,
      invocation: prompt
        ? { kind: "instructions", instructions: prompt.instructions }
        : { kind: "agent_action", actionId: action!.actionId },
      skillPaths: prompt?.metadata.skillPaths ?? action?.skillPaths ?? [],
    });
  }
  for (const file of input.files.keys()) {
    if (!file.startsWith("workflows/") || file === "workflows/catalog.json" || /^workflows\/[^/]+\/evals\//.test(file)) continue;
    if (!referencedPaths.has(file)) throw new Error(`Unreferenced Profile Workflow source ${file}.`);
  }
  const catalog = validateProfileWorkflowCatalog({
    catalog: ProfileWorkflowCatalogSchema.parse({ schemaVersion: "openpond.profileWorkflows.v1", workflows }),
    sourcePaths: input.skillPaths,
    actionIds: input.actionIds,
  });
  return { catalog, referencedPaths: [...referencedPaths].sort() };
}
