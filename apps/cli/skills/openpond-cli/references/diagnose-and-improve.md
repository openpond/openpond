# Diagnose and improve

Use the selected resource and the user's objective. Diagnose inspects evidence and explains the cause and next step without changing the resource or starting a new run. Improve carries the requested change through validation, using the supported CLI and the attached model, execution destination, and authorized budget.

## Dataset

Inspect representative examples, provenance, grader expectations, and relevant experiment results. Fix incorrect examples or missing coverage while preserving source references and held-out evaluation boundaries. Validate the saved revision, then run an experiment to assess the change. Compare with the baseline and explain when changed inputs prevent a direct score comparison.

## Grader

Inspect the rubric or verifier, fixtures, and misgraded outputs. Repair the grader and test known-good, known-bad, boundary, and adversarial cases. Preserve the intended success criteria; do not weaken checks or relabel failures merely to obtain passing tests. After fixture checks pass, run an experiment on the linked dataset to check grading on real model outputs. A passing fixture suite alone is not evidence of model quality. Save a new revision and retain the baseline.

“Fix this grader until it works” authorizes iterative repairs and tests within the requested scope and existing budget. Continue until the intended checks pass or a concrete blocker requires input. If experiment execution lacks a required model, supported destination, or budget, finish independent fixture work and report that missing requirement rather than inventing successful validation.

## Experiment

Inspect status, coverage, individual outcomes, grader behavior, and execution failures. Identify whether the problem is the dataset, grader, prompt/harness, model, or infrastructure. Make a targeted supported change, validate it, then run a new experiment and compare retained results. For a perfect result, investigate coverage and generalization instead of inventing failures.

Use the existing CLI operations for the selected resource owner. Do not route general improvement to the legacy source-component `openpond improve` workflow. Training is a separate action, not the default implementation of Improve.

## Execution

Honor the draft's executionLocation and evaluationModel when present; otherwise inspect the current scope. Local orchestration may call a hosted inference model. Hosted execution requires supported models and publication of the required saved dataset/grader assets; retain the local working copy and exact uploaded version. Never silently change destination, model, resource owner, or spending ceiling to make a run succeed. Training preparation targets OpenPond hosted training unless the user explicitly requests a verified supported local training path.
