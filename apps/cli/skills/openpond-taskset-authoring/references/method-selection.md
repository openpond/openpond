# Method selection

- Changing facts and internal documents: retrieval/context.
- Approved input-output demonstrations: SFT.
- Corrections or chosen/rejected pairs: SFT and/or preference tuning.
- Stable exact labels: classification/SFT; consider RL only after baseline evidence.
- Reliable scalar reward with non-trivial baseline variance: GRPO/RFT.
- Runtime, test, or reviewer feedback on policy attempts: SDPO when a proven backend supports it.
- Teacher-only demonstrations: SDFT/OPSD when the teacher surface exposes the required signal.
- Long processes with tools and state: agentic RL environment.

Choose the method only after the Taskset and baseline expose the available signal. A first small smoke run may use GRPO when rewards are executable, bounded, and show non-trivial baseline variance. SFT remains the simplest path for approved demonstrations, and DPO is appropriate only when trustworthy preference pairs exist. Do not stack SFT, DPO, GRPO, and PPO by default; each method needs a specific signal and reason. A real destination must still prove the chosen execution contract before training starts.
