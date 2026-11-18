import { z } from "zod";

const id = z.string().min(1).max(240);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const DatasetWorkspaceSourcesSchema = z.object({
  teamId: id,
  datasetId: id,
  revision: count,
  indexHash: digest,
  files: z.array(z.object({
    fileId: id,
    relativePath: z.string().min(1).max(500),
    sizeBytes: count,
    sha256: digest,
    use: z.enum(["tasks", "sources"]),
  }).strict()).min(1).max(100)
    .refine(files => new Set(files.map(file => file.fileId)).size === files.length),
}).strict();

export type DatasetWorkspaceSources = z.infer<typeof DatasetWorkspaceSourcesSchema>;
