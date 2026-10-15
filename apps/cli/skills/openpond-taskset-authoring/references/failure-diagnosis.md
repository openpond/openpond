# Review experiment results and diagnose attempts

## Interpret the run before choosing an intervention

Use this review for completed or partial experiments, including evaluation
attached to training. Match its depth to the user's question; it does not
automatically require a new run, a grader rewrite or a full readiness audit.

- Identify the evaluated model/checkpoint, task and grader revisions, execution
  destination, and whether results are training rewards, development evaluation
  or frozen evaluation. Optimizer completion does not establish model quality.
- Establish coverage: distinct tasks and families, attempts per task, completed
  outputs, scored outcomes, unresolved answers and execution/grader failures.
  Repeated attempts on one task do not establish broader task coverage. State
  denominators and distinguish missing results from observed incorrect answers.
- Derive useful component metrics from the task's success criteria and available
  evidence. Inspect distributions and meaningful task groups alongside the
  aggregate. Use existing fields/feedback where possible; a diagnostic report
  does not require changing the model's output schema. Report unavailable
  metrics as missing rather than inferring them from a headline score.
- Read the actual aggregation, weights, gates and thresholds before interpreting
  reward. Separate raw component scores, shaped training reward and acceptance.
  High partial credit can be intentional; it is not a correctness percentage or
  proof of a defective grader. Check whether tradeoffs and relative rankings
  represent the user's objective.
- Inspect permitted representative outputs across success, partial credit and
  failure, including high scores with potentially important mistakes and low
  scores with potentially valid alternative answers. Tie each concern to the
  output, source/reference evidence and grader decision. State sample selection
  and size; a targeted sample does not estimate the whole run's error rate.
- Compare baseline and candidate on matched cases with common scoring rules.
  Explain changed tasks, graders, prompts, budgets or execution conditions
  before attributing a difference to learning. Preserve original results; scores
  under different reward formulas are not directly comparable. Regrading needs
  a supported owning-backend operation; fixture replay is separate evidence.

Use the diagnosis below to distinguish a model mistake from a task, data,
grader or execution problem. For a suspected reward mismatch, first compare
saved outputs and controlled fixtures against independently grounded expected
judgments. This can establish scoring alignment, not improved learning.
Recommend a model experiment or training comparison only when it answers a
specific unresolved question and its execution is within the user's scope and
budget. Reuse suitable retained evidence rather than defaulting to extra runs.

Finish with the measured outcome and coverage, the most important supported
findings with example references, uncertainties, and the smallest justified
next action. Keeping the current setup and collecting the already-planned
evaluation is a valid conclusion when no material defect is established.
Separate changes needed before the next run from observations to review after
it. Preserve frozen-evaluation boundaries when inspecting any examples below.

## Diagnose an observed problem

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
