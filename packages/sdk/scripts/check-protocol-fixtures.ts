import { readFile } from "node:fs/promises";

import { ZodError } from "zod";

import {
  parseAndVerifyTrainingJobSubmission,
  trainingJobSubmissionHash,
} from "../src/training.js";

const fixtureUrl = new URL(
  "../fixtures/training/v2/policy-optimize.valid.json",
  import.meta.url,
);
const negativeFixtureUrl = new URL(
  "../fixtures/training/v2/policy-optimize.unknown-field.invalid.json",
  import.meta.url,
);

const valid = JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<
  string,
  unknown
>;
const parsed = await parseAndVerifyTrainingJobSubmission(valid);
const recomputed = await trainingJobSubmissionHash(parsed);
if (recomputed !== parsed.contentHash) {
  throw new Error(
    `Valid fixture hash ${parsed.contentHash} did not match ${recomputed}.`,
  );
}

const negative = JSON.parse(
  await readFile(negativeFixtureUrl, "utf8"),
) as {
  extends: string;
  mutation: { path: string[]; value: unknown };
  expectedError: string;
};
if (negative.extends !== "policy-optimize.valid.json") {
  throw new Error("Negative fixture must extend the published valid fixture.");
}
if (negative.mutation.path.length !== 1) {
  throw new Error("The current fixture checker supports one top-level mutation.");
}
const invalid = structuredClone(valid);
invalid[negative.mutation.path[0]!] = negative.mutation.value;
try {
  await parseAndVerifyTrainingJobSubmission(invalid);
  throw new Error("Negative fixture unexpectedly passed validation.");
} catch (error) {
  if (!(error instanceof ZodError)) throw error;
  const issueCode = error.issues[0]?.code;
  if (issueCode !== negative.expectedError) {
    throw new Error(
      `Negative fixture expected ${negative.expectedError} but received ${issueCode}.`,
    );
  }
}

console.log(
  `Verified OpenPond training fixtures (${parsed.contentHash}, negative=${negative.expectedError}).`,
);
