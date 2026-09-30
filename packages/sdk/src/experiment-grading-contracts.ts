import { z } from "zod";
import { FailureClassSchema, contentHash } from "@openpond/harness";
import { TaskGradeSchema } from "@openpond/evals/graders";

export const ExperimentAttemptGradeSchema = z.object({
  schemaVersion: z.literal("openpond.experimentAttemptGrade.v1"), selectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  grades: z.array(TaskGradeSchema).min(1).max(100), score: z.number().min(0).max(1).nullable(),
  passed: z.boolean(), rewardEligible: z.boolean(), gradingStatus: z.enum(["scored", "unscorable", "not_configured"]),
  failureClass: FailureClassSchema.nullable(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((grade, context) => {
  const { contentHash: actual, ...body } = grade;
  if (contentHash(body) !== actual) context.addIssue({ code: "custom", message: "Experiment grading integrity failed." });
  const components = grade.grades.flatMap(value => value.components);
  if (components.length !== grade.grades.length || new Set(components.map(component => component.graderId)).size !== components.length)
    context.addIssue({ code: "custom", message: "Each selected criterion requires exactly one distinct grader result." });
  for (const item of grade.grades) {
    const { contentHash: itemHash, ...itemBody } = item;
    if (contentHash(itemBody) !== itemHash) context.addIssue({ code: "custom", message: "A retained criterion changed." });
    for (const component of item.components) {
      const { contentHash: componentHash, ...componentBody } = component;
      if (contentHash(componentBody) !== componentHash) context.addIssue({ code: "custom", message: "A retained grader result changed." });
    }
  }
});
export type ExperimentAttemptGrade = z.infer<typeof ExperimentAttemptGradeSchema>;
