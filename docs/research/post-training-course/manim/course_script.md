# Post-Training from First Principles

Narration and study script for the ManimGL course.

This script accompanies a roughly 24-minute core course plus a short technical appendix. Concrete code, math, and tool examples remain visible in the diagrams while the narration explains the underlying mechanism. Numbers labeled “worked example” or “conceptual” are invented for teaching. Numbers labeled “reported result” come from the cited paper and should be interpreted only inside that paper’s setup.

The companion [research paper](../../2026-07-20-post-training-signal-routing.md) contains the equations, annotated bibliography, implementation proposals, and longer caveats.

## Learning goals

By the end, you should be able to:

1. Explain a policy as a distribution over possible actions and describe what a post-training update changes.
2. Read the policy, rollout, advantage, gradient, ratio, clipping, entropy, KL, and distillation notation used in current papers.
3. Trace one attempted repair through generation, evaluation, credit assignment, and an update.
4. Determine whether a dataset or rollout is on-policy or off-policy.
5. Explain reward, feedback, advantage, credit assignment, entropy, and reference KL.
6. Work a simple GRPO group-relative advantage calculation.
7. Explain why group composition, task difficulty, and clipping matter.
8. Explain hard-label, soft-label, offline, on-policy, and self-distillation.
9. Distinguish OPSD, SDFT, SDPO, and routed variants by their information channels.
10. Design clean Tasksets, verifier audits, matched baselines, and retention tests.
11. Turn the literature into a falsifiable research program.

## Course map

The core course has three parts:

- **Foundations:** what training changes, how to read the notation, where data came from, and how outcomes become credit.
- **Methods:** RLVR, PPO, GRPO, distillation, OPSD, SDFT, and SDPO.
- **The lab:** datasets, information boundaries, baselines, evaluation, compute, and research claims.

Every major method is studied through the same questions: What is it? How does it work? What data does it require? What would you use it for? When is it a poor fit?

| Method | Applies to | Poor fit when |
| --- | --- | --- |
| PPO | multi-step agents, reward-model alignment, learned state values | a value critic is too costly or behavior probabilities are missing |
| GRPO | exact-answer math, executable code checks, multiple candidates per prompt | rollout groups are uniform or sibling rewards are unreliable |
| RLVR | math graders, tests, tool-state checks, simulators | outcomes are subjective or the verifier is gameable |
| Distillation | teacher compression, on-policy guidance, privileged-context transfer | the teacher is unreliable or teacher scoring dominates cost |
| OPSD | verified reasoning solutions kept teacher-only | solutions are untrusted or can leak into student input |
| SDFT | new knowledge and tool protocols with demonstrations | retention cannot be evaluated or plain imitation already suffices |
| SDPO | code and agent failures with structured diagnostics | feedback is vague, adversarial, or only a scalar zero |

The optional advanced appendix contains GRPO normalization and diversity metrics, top-k teacher-logit storage, individual paper-result charts, and SRPO.

---

## Chapter 1 — Choose, judge, update

### 1.1 A policy chooses among possible actions

**Narration**

The coding agent sees a cancellation bug. It does not retrieve one fixed patch; its policy assigns different probabilities to several possible actions. In the worked example, `return None` has probability `0.54`, `raise CancelledError()` has `0.30`, and `retry` has `0.16`. Sampling turns that distribution into one attempted patch.

For a language model, an action may be the next token. For an agent, it can also be a tool call or a complete patch. The course needs only this high-level definition at first: a policy is the model's current distribution over what it might do next.

**Core idea:** post-training changes which actions are likely in similar future situations.

### 1.2 Loss measures the written objective

**Narration**

Tests judge the sampled patch. A loss compresses that training signal into a number the optimizer can reduce. Useful training lowers the objective while held-out behavior improves too. A stalled loss means learning is not progressing. A falling training loss paired with worsening held-out behavior can mean memorization, reward hacking, or an objective that measures the wrong thing.

The optimizer does not infer the intended behavior behind a bad test or reward. It follows the written objective. This is why evaluation and verifier quality will matter as much as the optimization method later in the course.

**Core idea:** lower training loss means better performance on the stated objective; held-out evaluation asks whether that objective captured what we wanted.

### 1.3 Training changes the odds

**Narration**

Suppose the policy samples `raise CancelledError()` and the cancellation test passes. The update makes that successful behavior somewhat more likely in comparable contexts. The next probability chart therefore shifts toward the correct exception and away from competing patches.

Softmax, gradients, and backpropagation implement this change, but they are general neural-network machinery rather than the organizing story of this course. RL-specific math appears later where it explains credit assignment and the PPO or GRPO update.

The loop is now complete: choose a patch, judge it, update the policy, and choose again. A trainable record must also preserve who generated the attempt and what evidence accompanied it.

---

## Chapter 2 — Definitions

This chapter is a reference for the AI, machine-learning, and reinforcement-learning language used in the rest of the course. The later chapters apply these terms to complete mechanisms and experiments.

### 2.1 Policy notation

`πθ(a|s)` is the probability assigned to action `a` in state `s` by a policy with parameters `θ`.

- `π` (pi) is the policy: the whole probability distribution over possible actions.
- `θ` (theta) is the collection of adjustable model parameters or weights.
- `s` is the current state or context available at a decision.
- `a` is an action sampled from the policy. For an LLM this may be a token; for an agent it may be a tool call or another structured decision.

A policy is therefore not the one answer that was sampled. It is the distribution that could have produced many answers.

### 2.2 Logits, softmax, and temperature

The network first emits raw scores called **logits**, usually written `z`. Softmax turns those scores into probabilities:

`p_i = exp(z_i / T) / Σ_j exp(z_j / T)`.

`T` is temperature. Lower temperature sharpens the distribution around the largest logits. Higher temperature spreads probability across more alternatives. Temperature changes how probabilities are formed or sampled; it does not itself update the stored weights.

### 2.3 Rollouts, trajectories, and log-probabilities

A **rollout** or **trajectory**, written `τ`, is the stored interaction record:

`τ = (s0, a0, log μ(a0|s0), o1, s1, …, rT)`.

`μ` is the behavior policy that generated the action. Its log-probability is stored so the trainer can compare the old generating distribution with the current policy. Logs turn products of many token probabilities into sums and make likelihood calculations numerically manageable. Observations `o` come from the environment and condition later decisions, but they are not sampled policy actions.

### 2.4 Reward, return, baseline, and advantage

- **Reward** `r_t` is the scalar emitted at a step or terminal outcome.
- **Return** `G_t` aggregates future reward: `G_t = r_t + γG_(t+1)`, where `γ` is the discount factor.
- A **baseline** estimates expected return without changing which action is preferred in expectation.
- **Advantage** `A_t` asks whether the observed return was better or worse than that baseline.

PPO commonly trains a **critic** or **value function** `Vφ(s)` with separate parameters `φ` and estimates `A_t ≈ G_t − Vφ(s_t)`. GAE means **Generalized Advantage Estimation** and blends value estimates across time steps.

GRPO means **Group Relative Policy Optimization**. It samples `G` sibling responses for one prompt and constructs a baseline from the group's reward mean `μ_G` and standard deviation `σ_G`:

`A_i = (r_i − μ_G) / σ_G`.

If every sibling has the same reward, `σ_G` is zero and the group contains no relative learning signal.

### 2.5 Objectives, gradients, and parameter updates

An **objective** or **loss** `L(θ)` turns the written training rule into a scalar. The gradient `∇θL` is the local slope of that objective with respect to every parameter. Backpropagation computes the gradient. An optimizer applies a learning rate `α` to make a small parameter update, commonly written:

`θ′ = θ − α∇θL`.

In policy-gradient training, the RL method decides which sampled actions receive positive or negative credit inside the loss. Ordinary differentiation and the optimizer perform the resulting weight change.

### 2.6 Probability ratios and clipping

PPO and GRPO compare the current policy with the behavior policy using an importance ratio:

`ρ_t = πθ(a_t|s_t) / μ(a_t|s_t)`.

`ρ_t = 1` means the action probability is unchanged. A value above one means it became more likely; below one means it became less likely. Clipping constrains the ratio to a local range such as `[1−ε, 1+ε]`. `ε` is the clipping threshold. This caps one sampled incentive but does not guarantee that the full model distribution stayed close everywhere.

### 2.7 Entropy, KL divergence, and cross-entropy

- **Entropy** `H(π)` measures the spread of one distribution. High entropy means many actions remain plausible; low entropy means behavior is concentrated.
- **KL divergence** `D_KL(p||q)` compares two distributions. Its direction matters. RL often uses it to measure drift from a frozen reference policy.
- **Cross-entropy** `H(q,p) = −Σ_i q_i log p_i` uses target probabilities `q` to score student probabilities `p`. Distillation minimizes it to move the student toward a teacher distribution.

### 2.8 Acronym reference

| Term | Expansion | What it names |
| --- | --- | --- |
| RL | Reinforcement Learning | learning from actions and outcome signals |
| RFT | Reinforcement Fine-Tuning | RL-style post-training of an already pretrained model |
| RLVR | Reinforcement Learning with Verifiable Rewards | a setting where reproducible checks produce reward |
| PPO | Proximal Policy Optimization | a clipped policy-gradient update with a learned critic |
| GRPO | Group Relative Policy Optimization | a clipped policy update using sibling rewards as the baseline |
| GAE | Generalized Advantage Estimation | a multi-step advantage estimator |
| OPSD | On-Policy Self-Distillation | teacher targets conditioned on a trusted solution and student prefix |
| SDFT | Self-Distillation Fine-Tuning | teacher targets conditioned on a demonstration and student prefix |
| SDPO | Self-Distillation Policy Optimization | teacher targets conditioned on failure feedback and student prefix |
| SRPO | Self-Rewarding Policy Optimization | routed training that treats successful and failed samples differently |
| pass@k | pass within `k` attempts | probability that at least one of `k` samples succeeds |

**On-policy** means the learner generated the training attempt. **Off-policy** means another source—such as a teacher, human, older checkpoint, or fixed dataset—generated it.

---

## Chapter 3 — Where data came from

### 3.1 The label identifies the data source

**Narration**

On-policy data comes from the learner being updated. If policy version 12 generates a patch that is used to update policy version 12, the attempt is on-policy for that learner.

Off-policy data comes from another generator: a teacher, a human, or an older checkpoint such as policy version 8. The distinction describes provenance rather than quality. Both sources can provide useful evidence.

### 3.2 A rollout preserves the trainable record

**Narration**

An RL rollout stores the task state, sampled actions, behavior checkpoint and probabilities, environment observations, masks, terminal status, and reward. In the displayed repair, policy version 12 samples `raise CancelledError()`, the tests pass, and reward is one.

The final patch string is not enough for an RL update. The trainer needs to know which actions the policy controlled, how likely they were when sampled, and what the environment returned.

### 3.3 Stored fields determine the objective

**Narration**

A teacher example carries target tokens or logits and supports imitation or distillation. A chosen `raise CancelledError()` patch paired with rejected `return None` supports a preference objective. An older RL rollout must preserve its original action probabilities, observations, and reward if it will be replayed or corrected.

This is why dataset structure matters. Generator, actions, observations, probabilities, labels, and information boundaries should be machine-readable rather than inferred from an untyped response string.

### 3.4 Source changes the update

**Narration**

PPO and GRPO usually generate attempts from the learner and score them in an environment. Offline distillation trains from stored teacher examples. On-policy distillation combines the two: the student produces its current prefix and a teacher labels that exact state.

Inside any RL rollout, the final response is only one part of a longer sequence of actions and observations.

---

## Chapter 4 — From outcomes to credit

### 4.1 A rollout is a trajectory through an environment

**Narration**

Reinforcement learning is easiest to understand as a sequence. The state contains the information available now. The policy samples an action. The environment applies that action and returns the next observation. Repeating that process creates a trajectory.

For code repair, the initial state can contain an issue and repository. Inspecting a file is an action. File contents are the next observation. Writing a patch is another action. Running tests reaches a terminal state.

The policy controls its actions. The environment controls transitions and observations. Tool output is not a policy action even though it appears in the same text transcript.

### 4.2 A trajectory record separates actions from observations

**Narration**

A useful trajectory can be written:

`τ = (s0, a0, log μ(a0|s0), o1, s1, a1, …, rT)`.

States contain available context. Actions are sampled by the behavior policy. Behavior log-probabilities preserve provenance. Observations come from the environment. Terminal reward summarizes the outcome.

Action masks identify which transcript positions were controlled by the policy. Tool output should condition later actions, but it should not receive a policy-gradient term as though the model sampled it.

### 4.3 Reward and feedback are different

**Narration**

This failed patch receives reward zero, but the environment knows much more. Eight tests passed. The cancellation test failed. The error says the code should have raised `CancelledError`.

Reward is a scalar used by the optimization objective. Feedback is the evidence produced by the environment. A training method can compress rich feedback to a scalar, or preserve the feedback for a teacher, critic, or corrective target.

GRPO usually operates on the scalar. SDPO is built around using the richer explanation. This single distinction explains much of the difference between them.

### 4.4 Terminal reward leaves the cause ambiguous

**Narration**

The terminal reward arrives after many actions and tokens. Which choice caused failure? Was it inspecting the wrong file, choosing the timeout branch, returning `None`, or failing to run a particular test?

Response-level credit applies one outcome to the whole sequence. Step-level credit evaluates tool calls or reasoning steps. Token-level objectives can provide a learning value at each position, but density does not guarantee causal correctness.

A final reward tells us that the trajectory failed; it does not reveal the true contribution of each token.

### 4.5 Return carries future rewards backward

**Narration**

Reward is attached to a particular transition. Return aggregates future rewards from a time step:

`Gt = Σk γ^k r(t+k)`.

With discount `γ = 0.9`, no immediate reward, and success two steps later, the earlier action receives return `0.9² = 0.81`. Discounting gives more weight to nearby outcomes while still propagating terminal success backward.

PPO critics, generalized advantage estimation, and multi-step agent RL rely on return estimates. A one-step reasoning task can simplify return to the terminal score, but interactive environments cannot always do so.

### 4.6 Advantage means better or worse than expected

**Narration**

Raw return alone lacks context. A return of 0.8 may be excellent on a hard prompt and mediocre on an easy one. An advantage subtracts a baseline.

In this example, observed return is 0.8 and expected return is 0.5, so advantage is positive 0.3. The update raises the probability of the sampled action. If return were 0.2 with the same baseline, advantage would be negative 0.3 and the probability would fall.

PPO often learns a value model to estimate the baseline. GRPO replaces that learned critic with statistics from several answers to the same prompt.

### 4.7 Advantage changes future sampling

**Narration**

The safe patch received positive advantage, so its sampled tokens become more likely in similar contexts. Other probabilities must fall because the distribution sums to one.

The update does not copy the successful response verbatim. It generalizes through shared parameters. That is powerful, but it can also create interference: a gradient learned from one domain can alter behavior elsewhere.

Clipping, KL, small learning rates, and retention data limit the size or consequences of that movement.

### 4.8 Exploration versus exploitation

**Narration**

Training often raises pass@1 while entropy falls. The model learns to repeat a reliable solution. That is exploitation. But if diversity falls too far, the model may lose alternate strategies that would succeed under multiple samples.

Pass@1 measures one-shot reliability. Pass@k measures whether at least one of k samples succeeds. A policy can improve pass@1 and harm pass@k if it collapses onto one partially reliable mode.

Track entropy and both metrics. Do not infer healthy exploration from a benchmark average alone.

### 4.9 Reference KL measures drift

**Narration**

The current policy changes every update. A frozen reference policy anchors the behavior that existed before training. KL divergence measures how different the two token distributions are.

Adding a KL penalty makes drift expensive. Too little constraint can lead to reward exploits, forgetting, or language degradation. Too much constraint can prevent learning. Reference KL is also useful as a reported metric even when it is not part of the loss.

---

## Chapter 5 — Verifiable rewards

### 5.1 A verifier applies a reproducible rule

**Narration**

The cancellation trajectory ended with a test result. Before optimizing it, ask whether that test deserves our trust. RLVR means reinforcement learning with verifiable rewards. The defining property is that task outcomes can be checked automatically.

A preference such as “response A is clearer” depends on an evaluator. A verification rule such as “all hidden tests pass” should return the same result for the same artifact. Verifiability is a continuum: symbolic equality is often stronger than a model judge, while flaky tests are weaker than they appear.

RLVR is a setting, not an optimizer.

### 5.2 A verifier maps an attempted outcome to reward

**Narration**

Write the verifier as:

`r = V(x, y, e)`.

Here `x` is the public cancellation issue and repository, `y` is the sampled patch, and `e` is evaluator-only state such as hidden tests. For binary verification, the result belongs to `{0,1}`.

This equation separates two ideas that are often conflated. RLVR supplies the reward function. PPO, GRPO, or DAPO supplies the update rule. The same verifier can therefore support multiple optimizers.

DeepSeek-R1 is an important large-scale example of reasoning training with verifiable outcomes and group-relative optimization.

### 5.3 Executable checks close the training loop

**Narration**

The policy samples an attempt. The environment executes or parses it. The verifier checks the outcome and emits a reward. An optimizer turns that reward into an update, and the new policy produces the next rollouts.

Automatic checks allow many labels without human evaluation of every sample. That scale is the attraction. The verifier also becomes part of the specification and the attack surface.

### 5.4 Verifiable outcomes across task families

**Narration**

Math can use exact answers, symbolic equivalence, or proof assistants. Code can use compilers, unit tests, integration tests, and performance limits. Tool agents can be checked against a target database or API state. Search agents can be evaluated on evidence retrieval and answer correctness. Scientific tasks can use simulators and constraints. Games expose score and terminal state.

The 2025 literature extended verifiable-reward training beyond short math answers. [Search-R1](https://arxiv.org/abs/2503.09516) trained multi-turn search behavior, and [SWE-RL](https://arxiv.org/abs/2502.18449) used software-evolution data and executable evaluation.

### 5.5 Verifier errors have two directions

**Narration**

A false positive is dangerous under optimization: the verifier accepts a wrong solution, so the policy receives positive evidence for an exploit. A false negative rejects a valid solution and suppresses useful diversity.

Before RL, test the verifier on adversarial and manually audited outputs. During RL, sample high-reward trajectories for human or shadow-verifier review. Optimization changes the output distribution, so a verifier validated only on base-model answers may fail later.

### 5.6 Reward hacking

**Narration**

If a genuine fix and a shortcut both receive reward one, RL has no signal that distinguishes them. The model may skip a test, hard-code visible examples, or exploit parser behavior.

This is not the model disobeying the objective. It is the model following the measured objective more literally than the designer intended. Hidden tests, invariant checks, multiple verifier implementations, and exploit audits make the measurement closer to the real task.

### 5.7 Hidden evaluation protects the task

**Narration**

The policy may see the task, public examples, and allowed tool observations. The evaluator alone should see hidden tests, private answers, anti-cheat checks, and independent random seeds.

Self-distillation adds a third category: training-only privileged context. The teacher may see it, but the deployment-time student must not. Store those fields separately and enforce access in code.

### 5.8 RLVR supplies reward; the optimizer supplies the update

**Narration**

The same verifiable environment can train PPO, GRPO, DAPO, REINFORCE variants, or dense feedback methods. Saying “RLVR plus GRPO” is precise: RLVR names the reward source, and GRPO names the group-relative update.

This separation lets us compare algorithms without silently changing the task.

---

## Chapter 6 — PPO and GRPO

### 6.1 PPO learns its baseline with a value model

**Narration**

With the cancellation verifier fixed, the remaining question is how to turn its reward into an update. PPO does this with a learned critic. The inspect–patch–test trajectory has observed return `0.8`; the critic `Vψ(state)` predicts expected return `0.5`. Their difference gives advantage `+0.3`.

The policy ratio

`ρt = πθ(action | state) / πold(action | state)`

measures how the sampled action’s probability changed since rollout collection. PPO optimizes the smaller of the ordinary ratio-weighted advantage and a clipped version. Gradients flow through the current policy; the critic is trained with its own value objective.

This clipped surrogate is the central mechanism in [Proximal Policy Optimization](https://arxiv.org/abs/1707.06347). GRPO inherits the policy-ratio update but replaces PPO’s learned value baseline.

### 6.2 One prompt produces G current-policy rollouts

**Narration**

GRPO stands for Group Relative Policy Optimization. For a cancellation prompt, the current policy samples G patches. A verifier assigns a reward to each. The method compares each patch to its siblings.

The key engineering attraction is that the group statistics replace a separately learned value model. GRPO still requires rollouts, rewards, behavior probabilities, a reference or old policy, and stable optimization.

[DeepSeekMath](https://arxiv.org/abs/2402.03300) introduced this GRPO construction. [DeepSeek-R1](https://arxiv.org/abs/2501.12948) later used group-relative reasoning training at much greater visibility and scale.

### 6.3 Group-relative advantage: a worked example

**Narration**

Here the six sibling patches receive rewards one, zero, zero, one, one, and zero. Their mean is 0.5 and standard deviation is 0.5. Subtracting the mean and dividing by the standard deviation gives advantages of positive one for the three passing patches and negative one for the three failures.

Positive-advantage sampled tokens are pushed up. Negative-advantage tokens are pushed down. Real implementations add a small epsilon and differ in whether normalization happens by group, token, or batch.

Notice what the calculation does not know: two failed responses can receive the same negative advantage even if one is nearly correct and the other is nonsense.

### 6.4 Importance ratios and clipping

**Narration**

The graph shows the positive-advantage branch of PPO’s clipped objective. Without clipping, the incentive rises linearly with the importance ratio. With a maximum ratio of `1.20`, the objective becomes flat beyond that point.

Suppose an action had probability `0.10` under the rollout policy and `0.13` under the current policy. The importance ratio is `1.30`. The action can reach that probability, but the objective uses `1.20`, so this sample supplies no additional positive incentive beyond the clip boundary.

Clipping makes large policy changes less attractive. It does not guarantee that the new distribution is globally close, and it introduces bias. Track actual KL and clip fractions in addition to the objective.

GRPO adopts this PPO-style clipped policy update. The group statistic changes the advantage estimator, not the need for ratios and stability controls.

### 6.5 Mixed groups contain a relative learning signal

**Narration**

For binary rewards, a group is informative only when it contains at least one success and one failure. If each sample succeeds independently with probability p, the probability of a mixed group is:

`1 − p^G − (1 − p)^G`.

The first subtracted term is the chance every sample succeeds. The second is the chance every sample fails. Larger groups widen the region with useful contrast, but they cost more rollout tokens. Even with a large group, prompts at almost zero or one success probability remain uninformative.

### 6.6 The learning frontier

**Narration**

All-one and all-zero groups have no within-group winner. Dynamic curricula select prompts near the model’s current frontier, where mixed outcomes occur.

[DAPO](https://arxiv.org/abs/2503.14476) uses dynamic sampling among its stability changes. The broader lesson is that data selection and optimizer design are coupled: the best loss cannot recover information that a homogeneous group does not contain.

### 6.7 Length normalization changes gradient weight

> **Advanced appendix:** implementation-level normalization choice.

**Narration**

Two correct answers can have equal reward but very different lengths. Depending on how token losses are aggregated, the long answer may contribute more total gradient, or the short answer may receive disproportionately large per-token weight.

DAPO and analyses such as [Understanding R1-Zero-Like Training](https://arxiv.org/abs/2503.20783) show that length, group standard deviation, clipping, overlong-response handling, and aggregation conventions materially change training.

The exact denominator belongs in the method specification. “GRPO” alone does not reproduce the objective.

### 6.8 Pass@1 and pass@k

> **Advanced appendix:** evaluation and diversity detail.

**Narration**

Model A has lower one-shot reliability but retains a wide solution set. Model B has higher pass@1 but almost no gain from eight samples. Which is better depends on deployment, but the pair of metrics reveals more than either alone.

Report temperature and sampling settings with pass@k. Otherwise changes in decoding can masquerade as changes in model diversity.

### 6.9 PPO and GRPO differ mainly in baseline construction

**Narration**

Both PPO and GRPO use current-policy rollouts, environment rewards, stored behavior log-probabilities, clipped policy ratios, and gradients through the current policy.

PPO learns `Vψ`, predicts expected value per state, commonly uses generalized advantage estimation, and requires value-model optimization. GRPO uses the mean and standard deviation of rewards from G responses to the same prompt. It compares siblings and removes the separate critic.

GRPO removes a learned critic. It does not remove the need for careful rollout infrastructure, trustworthy verifiers, reference tracking, or compute accounting. Uniform groups are a specific failure mode of its baseline estimator.

**Paper lineage:** [PPO](https://arxiv.org/abs/1707.06347) supplies the clipped policy update; [DeepSeekMath](https://arxiv.org/abs/2402.03300) introduces GRPO; [DeepSeek-R1](https://arxiv.org/abs/2501.12948) demonstrates the broader reasoning-training family.

---

## Chapter 7 — Distribution matching

### 7.1 Hard targets discard plausible alternatives

**Narration**

The verifier in Chapter 5 compressed a complete patch into one scalar. A teacher can expose a denser signal at each token. At the cancellation prefix, a one-hot target gives `CancelledError` all target mass. Distillation can expose the teacher’s full distribution: perhaps 55 percent on `CancelledError`, 25 percent on `TimeoutError`, and smaller probabilities on alternatives such as `return`.

That soft distribution reveals similarity and uncertainty. It can preserve multiple valid continuations, but it can also transfer teacher mistakes and biases.

### 7.2 Distillation weights every token by teacher probability

**Narration**

Let `qT(v)` be the teacher probability for vocabulary token `v`, and `pS(v)` the student probability. The token-level cross-entropy is:

`H(qT, pS) = −Σv qT(v) log pS(v)`.

Unlike a one-hot target, every teacher-supported token contributes in proportion to its probability. Gradients flow through the student distribution, not the frozen teacher.

Because teacher entropy is constant with respect to the student, minimizing this cross-entropy is equivalent to minimizing forward `KL(qT || pS)`.

This same distribution-matching mechanism applies to generalized on-policy distillation, OPSD, SDFT, and SDPO. What differs is where the prefix and teacher evidence come from.

### 7.3 The student distribution moves toward the teacher

**Narration**

The student initially favors `return`, while the teacher favors `CancelledError`. A distillation update reduces a divergence between those distributions. The student moves toward the teacher without necessarily matching it in one step.

This comparison repeats at every token position, commonly on a sequence of prefixes. Dense token targets can make learning more sample-efficient than a single terminal reward.

### 7.4 Temperature reveals or hides uncertainty

**Narration**

Low temperature sharpens teacher probabilities until distillation resembles hard-label imitation. Higher temperature exposes relationships in the tail. Very high temperature can flatten meaningful distinctions or magnify noise.

Temperature in teacher-target construction is conceptually separate from the temperature used to sample student trajectories. Record both.

### 7.5 KL direction matters

**Narration**

Forward KL, `KL(teacher || student)`, takes an expectation over teacher-supported tokens and penalizes the student for missing that support. Reverse KL, `KL(student || teacher)`, takes an expectation over student-supported tokens and strongly penalizes mass where the teacher assigns little probability.

The directions have different behavior around multiple modes and low-probability tails. Support truncation, top-k storage, temperature, and clipping further change the effective objective.

A reproducible KL objective specifies direction, token support, reduction, temperature, and clipping.

### 7.6 Prefix provenance determines exposure mismatch

**Narration**

In offline distillation, the teacher generates or labels data first, and the student learns from fixed teacher prefixes. It is stable and reusable but can miss the student’s own error states.

In on-policy distillation, the current student samples prefixes and the teacher supplies targets on those exact prefixes. This corrects exposure mismatch: the teacher must answer, “what should happen next from the state this student actually reached?”

[Generalized Knowledge Distillation](https://arxiv.org/abs/2306.13649) is an important conceptual predecessor.

### 7.7 Extra context creates a same-weight teacher

**Narration**

A teacher need not be a larger model. Use the same frozen weights twice. The student view contains only deployment information. The teacher view contains the same student prefix plus a solution, demonstration, or failure explanation.

Conditioning makes the teacher distribution more useful. Training removes that privileged context by teaching the student view to approximate the teacher view.

This is the shared mechanism behind OPSD, SDFT, and SDPO.

### 7.8 Top-k logits trade fidelity for storage

> **Advanced appendix:** systems and storage detail.

**Narration**

A modern vocabulary may contain roughly 150,000 tokens. Storing a logit for every vocabulary item at every trajectory position is expensive.

Top-k compression stores the highest-probability logits and approximates the remaining tail mass. It saves memory and bandwidth, but changes the target. Measure divergence from the full distribution on a validation sample and include storage and teacher-forward cost in the systems results.

---

## Chapter 8 — Teacher evidence

### 8.1 One student trajectory creates two contexts

**Narration**

The student has already sampled the failed `return None` repair. At each student prefix, a same-model teacher receives extra evidence and produces a token distribution. The update moves the student toward that distribution.

OPSD gives the teacher a verified solution. SDFT gives it an expert demonstration. SDPO gives it feedback about the current attempt. The method names are not aliases: they require different data assets and protect different information boundaries.

### 8.2 Teacher conditioning defines the method family

**Narration**

At a student-generated prefix, the deployment policy is:

`pθ(v | x, y<t)`.

The frozen teacher sees the same prefix plus evidence `e`:

`q(v | x, y<t, e)`.

Training minimizes a divergence from `q` to `pθ`. The student does not receive `e` at deployment. The evidence channel determines the named method: a verified solution gives OPSD, a demonstration gives SDFT, and failure feedback gives SDPO.

This equation is the bridge from the general distillation objective to the three papers that follow.

### 8.3 OPSD: privileged solutions

**Narration**

In the animation, the student sees only the cancellation issue and its failed prefix. The teacher additionally sees a verified repair, `raise CancelledError()`, plus cleanup context. With the same weights, the teacher can assign more useful next-token probabilities because it knows where a correct path ends. The OPSD paper itself evaluates reasoning tasks; the code example maps its information flow into the course's shared setting.

The [Self-Distilled Reasoner](https://arxiv.org/abs/2601.18734) paper uses full-vocabulary forward KL, pointwise clipping, and a fixed initial teacher. A bad reference solution can densify bad guidance. A leaked reference solution invalidates the deployment claim.

Use case: exact-answer reasoning—or another task with trusted reference solutions—where those solutions can be kept training-only.

### 8.4 SDFT: demonstrations and continual learning

**Narration**

Offline token imitation would train directly on an expert cancellation repair. SDFT instead lets the student attempt the related task and asks a demonstration-conditioned teacher to guide the student's own failed `return None` state. The teacher can raise the probability of exception-raising tokens without forcing the student to replay the demonstration word for word.

[Self-Distillation Enables Continual Learning](https://arxiv.org/abs/2601.19897) emphasizes knowledge acquisition and retention. This is why a SDFT experiment needs an old-capability suite. Improving the new tool while forgetting unrelated tools is not a complete success.

### 8.5 SDPO: feedback on failures

**Narration**

The failed patch has reward zero, but its test trace explains the error. SDPO conditions the teacher on that explanation and the student’s failed prefix, producing dense corrective targets.

[Reinforcement Learning via Self-Distillation](https://arxiv.org/abs/2601.20802) applies this idea across reasoning and code tasks. It depends on feedback quality and the model’s ability to interpret the feedback in context.

Use case: code, tools, and interactive tasks where the environment emits structured diagnostics.

### 8.6 Available evidence determines the applicable method

**Narration**

OPSD requires a trusted solution. SDFT uses demonstrations that encode new knowledge or protocols. SDPO requires explanatory feedback about current attempts.

The primary risks differ: solution leakage for OPSD, forgetting or mismatch for SDFT, and noisy dense drift for SDPO. A generic text column cannot represent these distinctions safely.

### 8.7 OPSD’s reported scaling result

> **Advanced appendix:** paper-reported result.

**Narration**

The graph reproduces aggregate values reported by the OPSD paper for Qwen3 models. At 1.7 billion parameters, the reported base score is 37.1, GRPO is 37.7, and OPSD is 43.4. At four and eight billion parameters, the reported OPSD gains over GRPO are smaller.

This does not prove a universal model-size law. It suggests a hypothesis: privileged-context self-teaching may help small models differently, and teacher-context quality may have capacity thresholds. Replicate across seeds, datasets, and model families.

### 8.8 Reported results measure different claims

> **Advanced appendix:** cross-paper reading guidance.

**Narration**

The SDFT paper reports strict knowledge-acquisition aggregate 80 for its token-imitation baseline and 89 for SDFT, with out-of-distribution values 80 and 98. The SDPO paper reports 41.2 for GRPO and 48.8 for SDPO on LiveCodeBench v6 in its setup.

These bars are not a head-to-head comparison between SDFT and SDPO. They come from different tasks and studies. Their value here is to identify the claim each method asks us to reproduce.

### 8.9 Successes and failures carry different evidence

> **Advanced appendix:** SRPO and routed optimization.

**Narration**

A verified success supplies outcome evidence: increase the probability of what worked. A failed attempt with diagnostics supplies corrective evidence: explain what should change.

[Sample-Routed Policy Optimization](https://arxiv.org/abs/2604.02288) routes these cases differently, combining a GRPO-style success path with an SDPO-style failure path. The general principle is signal routing: do not force every sample through the same information bottleneck.

### 8.10 Dense feedback failure modes

**Narration**

Dense targets feel informative, but they can be confidently wrong. Privileged information can leak. The teacher can misread a critique. New skill can overwrite old capability. Entropy can collapse. A fixed teacher can become stale. Efficiency claims can omit teacher-forward cost.

[Denser Is Not Better](https://arxiv.org/abs/2607.01763) is valuable counterevidence. Treat dense self-distillation as a hypothesis to audit, not an automatic upgrade.

---

## Chapter 9 — Credible experiments

### 9.1 A Taskset defines three information domains

**Narration**

One repair is an example; many versioned repairs make a study. Separate policy-visible issues and repositories, training-only expert repairs or feedback, and evaluator-only hidden tests. Record source revision, license, split, repository cluster, verifier version, and a content hash.

Cluster-related examples before splitting. For code, split by repository or issue family. For math, split templated or paraphrased problem families. Row-level random splits can put near duplicates on both sides and inflate results.

An immutable Taskset is the unit a run references. It is more precise than “we used this dataset name.”

### 9.2 Hugging Face imports need immutable provenance

**Narration**

Yes, connecting the lab to Hugging Face datasets is worthwhile. It gives access to established data, community metadata, and reproducible revisions.

The safe boundary is an importer. Pin the repository revision, inspect license and schema, apply an explicit transform, log rejected rows, compute hashes, and materialize an immutable Taskset snapshot. A training run should never silently follow a mutable `main` branch.

Support `repo`, `revision`, `config`, `split`, streaming mode, gated-access status, column mappings, and provenance. Preserve original row identifiers so every example can be traced back.

### 9.3 A new method needs the simplest credible baseline

**Narration**

The baseline ladder begins with the base model and the simplest token-imitation objective supported by the data, adds offline distillation or DPO when relevant, then includes GRPO or another RLVR baseline before the proposed OPSD, SDFT, or SDPO treatment.

Use the same train prompts, evaluation, verifier, decoding settings, and checkpoint family. Report two matched comparisons: equal optimizer tokens and equal total compute. Distillation may use fewer rollouts but extra teacher passes; the two controls reveal different tradeoffs.

### 9.4 Evaluation spans capability, diversity, retention, and integrity

**Narration**

Capability includes pass@1, outcome reward, and intermediate tool success. Diversity includes pass@k, entropy, and distinct solution strategies. Retention includes old-domain evaluations, reference KL, and regression counts. Integrity includes exploit rate, leakage audits, and a shadow verifier.

Report per-domain results and confidence intervals. A mean can improve while an important domain regresses.

### 9.5 Total compute has four visible components

**Narration**

Count student rollout tokens, teacher-scored tokens, backward tokens, verifier or sandbox time, external calls, failed jobs, peak memory, and wall clock.

Then report quality per GPU-hour, quality per million processed tokens, time to target quality, and storage cost. This prevents a method from looking efficient merely because part of its compute is outside the optimizer.

### 9.6 One study and two replications isolate the signals

**Narration**

The primary study uses code repair to compare the base model, GRPO, SDPO, and a routed method. Keep public diagnostics separate from hidden tests. Measure final success, recovery after failure, feedback use, exploit rate, and leakage.

A verified-math replication compares the base model, GRPO, and OPSD with exact and shadow symbolic graders. It checks whether the solution-evidence result survives a different task family.

A tool-protocol replication compares offline token imitation and SDFT, then tests novel compositions and an unrelated retention suite. It checks demonstration evidence and forgetting.

Together the main study and replications isolate failure evidence, solution evidence, and demonstration evidence without pretending that results from different task families are directly interchangeable.

### 9.7 Every claim maps to evidence

**Narration**

An auditable paper binds one causal question to an immutable Taskset, information boundary, exact objective, matched baselines, results, failures, manifests, verifier versions, seeds, configurations, and run identifiers.

A claim table should connect each claim to a metric, dataset revision, run set, confidence interval, and ablation. This structure makes it difficult to drift from “the evidence supports X in this setup” to “method X is universally better.”

### 9.8 Evidence determines the training target

**Narration**

Demonstrations route into token imitation or SDFT. Preferences route into DPO or reward-model RL. Verified outcomes route into RLVR optimizers such as GRPO and DAPO. Privileged solutions route into OPSD. Failure explanations route into SDPO or a routed objective.

Available evidence determines the target, the target determines the update, and the update changes future behavior. Evaluation measures both the intended capability and the behavior that changed elsewhere.

That is the central idea of the course: post-training methods are routes for evidence into a changing policy distribution.

---

## Suggested reading order

1. [Proximal Policy Optimization](https://arxiv.org/abs/1707.06347) for clipped policy updates.
2. [InstructGPT](https://arxiv.org/abs/2203.02155) for the demonstration, preference, and RLHF pipeline.
3. [Direct Preference Optimization](https://arxiv.org/abs/2305.18290) for preference learning without an explicit online RL loop.
4. [Generalized Knowledge Distillation](https://arxiv.org/abs/2306.13649) for on-policy teacher targets on student prefixes.
5. [DeepSeekMath](https://arxiv.org/abs/2402.03300) for GRPO.
6. [DeepSeek-R1](https://arxiv.org/abs/2501.12948) for large-scale reasoning RL and downstream distillation.
7. [DAPO](https://arxiv.org/abs/2503.14476) and [Understanding R1-Zero-Like Training](https://arxiv.org/abs/2503.20783) for GRPO stability and bias.
8. [Self-Distilled Reasoner / OPSD](https://arxiv.org/abs/2601.18734).
9. [Self-Distillation Enables Continual Learning / SDFT](https://arxiv.org/abs/2601.19897).
10. [Reinforcement Learning via Self-Distillation / SDPO](https://arxiv.org/abs/2601.20802).
11. [Sample-Routed Policy Optimization](https://arxiv.org/abs/2604.02288).
12. [Denser Is Not Better](https://arxiv.org/abs/2607.01763) as counterevidence.

Use the companion paper’s annotated bibliography for the larger 2025–2026 reading list, including Kimi k1.5, Search-R1, SWE-RL, GSPO, GMPO, OPD variants, context distillation, reflective self-distillation, and multi-turn agent extensions.
