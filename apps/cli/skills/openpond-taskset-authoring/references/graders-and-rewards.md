# Graders and rewards

- Prefer exact, schema, file, diff, test, runtime-event, and final-state graders.
- Compose graders with explicit weights and hard gates. Infrastructure failures receive no reward.
- Generated verifier code runs without network or broad credentials and has a strict timeout.
- A generated verifier exports one function that receives `{ task, attempt }`. Read policy input from `task.input`, the privileged expected outcome from `task.expectedOutput`, the candidate from `attempt.output`, and infrastructure state from `attempt.infrastructureError`. Flat `input`, `expectedOutput`, `output`, and `infrastructureError` aliases are also available, but new verifier code should use the nested form.
- Return `{ passed, score, feedback, evidenceRefs? }`. `reason` is accepted as a feedback alias, but new verifier code should return `feedback`.
- Test positive, negative, boundary, adversarial, prompt-injection, leakage, and infrastructure-failure fixtures.
- A model judge records provider/model, configuration, rubric version, evidence, structured score, rationale, and calibration status.
- Only frozen graders that pass calibration and hacking tests may be marked reward-eligible.
- SFT uses graders for baselines and frozen evaluation, not as optimizer reward.
