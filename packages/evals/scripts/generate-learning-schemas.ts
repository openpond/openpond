import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { learningResourceSchemas, LearningCommandRequestSchema, LearningReadRequestSchema, TaskExampleSubmissionSchema, TaskFeedbackSubmissionSchema } from "../src/learning/index.js";

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas/learning/v1");
await mkdir(target, { recursive: true });
for (const [name, schema] of Object.entries({ ...learningResourceSchemas, "command-request": LearningCommandRequestSchema, "read-request": LearningReadRequestSchema, "example-submission": TaskExampleSubmissionSchema, "feedback-submission": TaskFeedbackSubmissionSchema })) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12", reused: "ref", cycles: "ref" });
  await writeFile(path.join(target, `${name}.schema.json`), `${JSON.stringify({ ...jsonSchema, $id: `urn:openpond:learning:v1:${name}`, $comment: "Generated from @openpond/evals. Cross-resource identity, authorization, idempotency, admission, grading and split constraints are enforced by the shared domain service in addition to this structural schema." }, null, 2)}\n`);
}
