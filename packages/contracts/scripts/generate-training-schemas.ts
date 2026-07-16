import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  SftRecipeSchema,
  SftTrainingRecordSchema,
  TasksetSchema,
  TrainingArtifactSchema,
  TrainingBundleManifestSchema,
  TrainingJobEventSchema,
} from "../src/index.js";

const outputDirectory = path.resolve(
  import.meta.dirname,
  "../../../python/openpond-training/src/openpond_training/schemas",
);

const schemas = {
  "sft-recipe.schema.json": SftRecipeSchema,
  "sft-training-record.schema.json": SftTrainingRecordSchema,
  "taskset.schema.json": TasksetSchema,
  "training-artifact.schema.json": TrainingArtifactSchema,
  "training-bundle.schema.json": TrainingBundleManifestSchema,
  "training-job-event.schema.json": TrainingJobEventSchema,
};

await mkdir(outputDirectory, { recursive: true });
for (const [fileName, schema] of Object.entries(schemas)) {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    unrepresentable: "any",
  });
  await writeFile(
    path.join(outputDirectory, fileName),
    `${JSON.stringify(jsonSchema, null, 2)}\n`,
    "utf8",
  );
}
