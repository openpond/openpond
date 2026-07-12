# Method selection

- Changing facts and internal documents: retrieval/context.
- Approved input-output demonstrations: SFT.
- Corrections or chosen/rejected pairs: SFT and/or preference tuning.
- Stable exact labels: classification/SFT; consider RL only after baseline evidence.
- Reliable scalar reward with non-trivial baseline variance: GRPO/RFT.
- Runtime, test, or reviewer feedback on policy attempts: SDPO when a proven backend supports it.
- Teacher-only demonstrations: SDFT/OPSD when the teacher surface exposes the required signal.
- Long processes with tools and state: agentic RL environment.

The initially executable OpenPond recipe is LoRA SFT. Other methods remain recommendations until a real destination proves their execution contract.
