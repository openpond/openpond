# Graders and rewards

- Prefer exact, schema, file, diff, test, runtime-event, and final-state graders.
- Compose graders with explicit weights and hard gates. Infrastructure failures receive no reward.
- Generated verifier code runs without network or broad credentials and has a strict timeout.
- Run private or tamper-sensitive verifier logic outside the policy-controlled
  environment. Transfer only declared task artifacts or signed Harness
  receipts into that verifier boundary.
- A generated verifier exports one function that receives `{ task, attempt }`. Read policy input from `task.input`, the privileged expected outcome from `task.expectedOutput`, the candidate from `attempt.output`, and infrastructure state from `attempt.infrastructureError`. Flat `input`, `expectedOutput`, `output`, and `infrastructureError` aliases are also available, but new verifier code should use the nested form.
- Return `{ passed, score, feedback, evidenceRefs? }`. `reason` is accepted as a feedback alias, but new verifier code should return `feedback`.
- Test positive, negative, boundary, adversarial, prompt-injection, leakage, and infrastructure-failure fixtures.
- A model judge records provider/model, configuration, rubric version, evidence, structured score, rationale, and calibration status.
- Only frozen graders that pass calibration and hacking tests may be marked reward-eligible.
- SFT uses graders for baselines and frozen evaluation, not as optimizer reward.

## Check what the grader measures

Compare the task instruction, model-visible context and tools, expected outcome,
and rubric or verifier side by side. Flag contradictions, unavailable evidence,
and requirements introduced only by the grader. Evaluate observable outcomes
and explicitly required actions; accept alternative valid methods. Formatting
or a particular method should affect the score only when the task requires it.

Make independently judgeable criteria separate so a strong result on one cannot
hide a failure on another. Avoid mechanical prose rules such as rejecting every
criterion containing "and"; decide whether it combines distinct requirements.

Use the existing fixture and grader-test operations to check a known-good
answer, a valid alternative, a plausible wrong answer, and a partial completion
where partial credit applies, alongside the boundary and adversarial fixtures
above. For model judges, add meaning-preserving style, length, or answer-order
variations when those could influence scoring. Preserve the declared objective
when repairing the grader; do not tune it to make the current model pass.

Tie criterion decisions to output passages, artifact locations, or observable
tool events. If the review lacks the records needed to assess a criterion, mark
the assessment unresolved; do not invent a pass or model failure. An observed
failure to produce an explicitly required artifact can still fail that criterion.
Use the supported result contract and explain uncertainty in feedback or the
review rather than inventing verdict fields. Separate grader or environment
errors from scored model outcomes in the report.

Compare model-judge decisions with available qualified human judgments on a
representative sample. Agent-generated labels are fixture hypotheses, not
human calibration. If human evidence is unavailable, say so and limit the claim
to the fixture checks actually run. Record sample counts and denominators for
reported disagreements; a deliberately selected stress sample does not estimate
the error rate of the whole dataset. Never use frozen eval cases for calibration.
