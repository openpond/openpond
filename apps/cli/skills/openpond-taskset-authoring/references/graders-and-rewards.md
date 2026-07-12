# Graders and rewards

- Prefer exact, schema, file, diff, test, runtime-event, and final-state graders.
- Compose graders with explicit weights and hard gates. Infrastructure failures receive no reward.
- Generated verifier code runs without network or broad credentials and has a strict timeout.
- Test positive, negative, boundary, adversarial, prompt-injection, leakage, and infrastructure-failure fixtures.
- A model judge records provider/model, configuration, rubric version, evidence, structured score, rationale, and calibration status.
- Only frozen graders that pass calibration and hacking tests may be marked reward-eligible.
- SFT uses graders for baselines and frozen evaluation, not as optimizer reward.
