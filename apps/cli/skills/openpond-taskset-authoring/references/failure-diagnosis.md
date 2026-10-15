# Diagnose failed attempts

Use existing run results and observable evidence to explain failures before
recommending more data or training. Diagnosis is separate from scoring: a
suspected grader defect does not authorize changing a recorded result.

First check whether the task could have been solved with the exact instructions,
context, tools, permissions, and resource limits available during the attempt.
A reference solution that used unavailable information does not establish this.
If solvability is unclear, preserve that uncertainty rather than assigning a
model capability failure.

Compare the task, expected outcome, rubric, and actual model-visible inputs.
Then inspect outputs, tool calls and results, errors, state transitions, and
produced artifacts around the failure. Do not request or infer private reasoning.
Use only evidence permitted in the current context: frozen eval details remain
outside candidate authoring and repair. Work from permitted aggregate reports
or report that detailed diagnosis requires a separate authorized evaluation
context; do not expose held-out answers to generate a fix.

Use the smallest useful set of likely causes:

| Likely cause | Evidence to look for | Targeted next step |
| --- | --- | --- |
| Task or prompt | Ambiguity, conflicting instructions, or missing requirements | Clarify the task without changing its intended capability |
| Tools or environment | Missing context, broken tools, stale state, truncation, or a failed handoff | Repair the environment and verify the affected path |
| Grader | A defensibly correct outcome rejected, or an unstated criterion enforced | Review the grader with independent valid and invalid fixtures |
| Data | Incorrect demonstrations or inconsistent labels supported by source inspection | Correct the evidenced examples and preserve their provenance |
| Model | A solvable task and supported grading, with an observable incorrect action or result | Investigate a representative pattern before selecting an intervention |

Allow multiple contributing causes or an unresolved finding. A matching behavior
alone does not prove that training data caused it. State the observation,
supporting task/run/trace or artifact references, likely explanation, and what
would distinguish it from alternatives. Prioritize the first evidenced defect
that makes later outcomes uninterpretable rather than blaming every downstream
step independently.

Summarize recurring causes with counts and the reviewed denominator. Keep
environment failures visible and separate from model mistakes; do not silently
drop them to improve a headline success rate. Do not extrapolate a selected
sample of failures to the entire dataset or treat automated cause labels as
human-validated findings.

For Improve, make the targeted authorized repair, validate the affected task or
grader, and run the smallest relevant experiment within the existing execution
scope and budget. Retain the original result and identify changed versions or
conditions. If rerunning is unavailable or unauthorized, finish independent
review or repair work and report the specific verification still needed.
