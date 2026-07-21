# Post-Training as Signal Routing

## A field guide to reinforced fine-tuning, on-policy distillation, clean data, and the 2025–2026 research frontier

Date: 2026-07-20
Status: Literature synthesis and experimental blueprint
Companion artifacts:

- [Post-Training Research Lab working doc](../working-docs/training/2026-07-20-post-training-research-lab.md)
- [ManimGL Post-Training Course](post-training-course/manim/README.md)
- [Course narration and study script](post-training-course/manim/course_script.md)

## Abstract

The post-training literature can look like an alphabet soup: PPO, DPO, GRPO, DAPO, Dr. GRPO, GSPO, GMPO, OPD, OPSD, SDFT, SDPO, SRPO, and several more. The names emphasize optimizers, but the most important differences are usually elsewhere. A post-training process decides which behavior to sample, what information to reveal while evaluating it, how to turn that information into credit, and which distribution the next update should imitate.

This paper proposes **signal routing** as a practical way to reason about the field. Every method is located along five axes:

1. **trajectory provenance** — expert data, an older policy, the current policy, or an environment;
2. **feedback information** — target tokens, pairwise preference, a scalar reward, a privileged solution, or rich textual feedback;
3. **credit granularity** — sequence, token, step, or localized error;
4. **teacher access** — no teacher, external teacher, or a context-enhanced copy of the student;
5. **environment structure** — static prompts, exact verifiers, tools, code execution, search, or multi-turn state.

Seen this way, the field is not a contest to find one universally superior acronym. Sparse reinforcement learning is powerful when outcomes are reliable and exploration matters. On-policy distillation is attractive when a model can generate its own trajectories but a privileged context can explain how those trajectories should change. Rich environment feedback can make failed attempts useful, but dense signals can also accelerate drift and forgetting. Dataset quality is therefore not a preprocessing detail: it determines the validity of the reward, the information available to the teacher, the integrity of held-out evaluation, and ultimately the scientific meaning of a run.

The recommended laboratory program begins with fair SFT and GRPO controls, then introduces privileged-solution and feedback-conditioned self-distillation. It conserves rollout, teacher, optimizer, and environment budgets separately; reports pass@1 and pass@k; measures retention and behavior diversity; audits verifier exploitability; and binds every run to immutable data and code provenance. Hugging Face dataset support is worth adding to OpenPond, but only as an auditable import path into canonical Tasksets rather than a shortcut that trains directly from mutable remote data.

---

## 1. The mental model

A model is a conditional distribution \(\pi_\theta(y \mid x)\). Post-training changes that distribution after broad pretraining. The central design question is:

> For the behavior we want, what evidence can tell the model which probability mass to move, and what information is safe to expose while doing so?

There are four recurring objects:

- A **prompt or state** \(x\).
- A **trajectory or response** \(y\), often containing many tokens or actions.
- A **signal** \(s\), such as a demonstration, preference, scalar reward, verified solution, compiler error, or judge critique.
- An **update rule** that changes \(\theta\).

The simplest taxonomy is based on the signal:

| Signal | Typical method | What the update learns |
| --- | --- | --- |
| Expert target tokens | SFT | Imitate this response |
| Chosen/rejected pair | DPO | Prefer one response over another |
| Scalar outcome | PPO, GRPO, RLVR | Increase probability of rewarded trajectories |
| External teacher distribution | GKD / OPD | Match the teacher on student-generated states |
| Privileged solution | OPSD | Match the same model when it can see the solution |
| Expert demonstration in teacher context | SDFT | Recover demonstrated knowledge without forcing one target sequence |
| Rich failure feedback | SDPO | Match the same model when it can see why an attempt failed |
| Routed scalar or dense signal | SRPO | Use outcome reward for successes and explanatory feedback for failures |

This table immediately exposes a common mistake: two methods can share an optimizer and still be different training systems. Conversely, two papers can present different optimizer names while making the same deeper bet about where useful information comes from.

### 1.1 Five axes for comparing methods

**Trajectory provenance.** Off-policy methods learn from trajectories produced elsewhere. On-policy methods train on states or outputs sampled from the current student. The latter reduces train–inference mismatch but requires repeated generation.

**Feedback information.** A single scalar says which result was better, but usually not why. A privileged solution, unit-test trace, or textual critique can carry far more information. More information is not automatically better: it may be noisy, leak answers, or drive the policy away from useful prior capabilities.

**Credit granularity.** Sequence-level reward gives every token in a long response the same eventual sign unless a value model or other estimator redistributes credit. Token-level distillation supplies a target distribution at each position. Step-level process reward sits between them.

**Teacher access.** Some methods require a stronger external model. OPSD, SDFT, and SDPO instead construct a stronger *context* for the same model. This is the decisive idea behind their efficiency: the teacher need not have different weights if privileged information makes its conditional distribution better.

**Environment structure.** Exact math answers, code tests, web pages, search tools, and multi-turn software tasks create different failure modes. “RL” is not a portable scalar detached from an environment; the environment defines what is observable, verifiable, exploitable, and expensive.

### 1.2 Exploration, selection, and transmission

Post-training methods do three conceptually different jobs:

- **Exploration** discovers trajectories the current model rarely produces.
- **Selection** shifts mass toward better trajectories already sampled.
- **Transmission** transfers information available to a demonstration, teacher, or feedback channel into the student.

GRPO is primarily a selection mechanism and sometimes an exploration mechanism. SFT is primarily transmission from demonstrations. On-policy distillation combines selection of student-generated states with dense transmission from a teacher distribution. Many disputed results in RLVR become easier to understand after asking which of these jobs the experiment actually demonstrated.

---

## 2. The mathematical spine

The equations below are intentionally compact. Their purpose is to show what information each objective consumes.

### 2.1 Supervised fine-tuning

Given demonstrations \((x,y^*)\), SFT minimizes token cross-entropy:

\[
\mathcal{L}_{\text{SFT}}(\theta)
=
-\mathbb{E}_{(x,y^*) \sim D}
\sum_t \log \pi_\theta(y_t^* \mid x,y_{<t}^*).
\]

SFT has dense, low-variance credit because each target token is known. It is also off-policy and teacher-forced: the model trains on expert prefixes rather than the prefixes it will produce at inference. A single demonstration commits to one surface form even when many valid solutions exist.

### 2.2 Direct preference optimization

DPO learns from a preferred response \(y_w\) and rejected response \(y_l\) relative to a reference policy:

\[
\mathcal{L}_{\text{DPO}}
=
-\mathbb{E}
\log \sigma
\left(
\beta
\left[
\log \frac{\pi_\theta(y_w \mid x)}{\pi_{\text{ref}}(y_w \mid x)}
-
\log \frac{\pi_\theta(y_l \mid x)}{\pi_{\text{ref}}(y_l \mid x)}
\right]
\right).
\]

The important data object is not a scalar label but a preference pair. DPO avoids an online reward-model-and-PPO loop, but it inherits the coverage and staleness of the offline preference data.

### 2.3 Policy-gradient reinforcement learning

For a trajectory reward \(r(x,y)\), the idealized objective is:

\[
J(\theta)
=
\mathbb{E}_{x \sim D,\ y \sim \pi_\theta(\cdot \mid x)}
[r(x,y)]
-
\beta\,D_{\mathrm{KL}}(\pi_\theta \Vert \pi_{\text{ref}}).
\]

The gradient uses a return or advantage estimate. PPO constrains large changes with a clipped importance ratio. RL with verifiable rewards, or RLVR, replaces a learned preference reward with an exact or programmatic verifier when possible.

### 2.4 Group relative policy optimization

GRPO, introduced in [DeepSeekMath](https://arxiv.org/abs/2402.03300) and popularized by [DeepSeek-R1](https://arxiv.org/abs/2501.12948), samples a group of \(G\) outputs for the same prompt and normalizes rewards within the group:

\[
A_i
=
\frac{r_i - \operatorname{mean}(r_1,\ldots,r_G)}
{\operatorname{std}(r_1,\ldots,r_G)+\epsilon}.
\]

A clipped policy objective then increases the probability of above-group responses and decreases the probability of below-group responses. This removes the separate learned value model used in conventional PPO, but it creates a strict data requirement: a prompt whose group always receives the same reward provides no relative signal. Group size, output length, and reward variance become part of the effective training budget.

### 2.5 On-policy distillation

Given a student context \(c_s\), an enhanced teacher context \(c_t\), and a student-generated prefix \(y_{<t}\), distillation can minimize:

\[
\mathcal{L}_{\text{KD}}
=
\mathbb{E}_{y \sim \pi_\theta(\cdot \mid c_s)}
\sum_t
D_{\mathrm{KL}}
\left(
\pi_T(\cdot \mid c_t,y_{<t})
\;\Vert\;
\pi_\theta(\cdot \mid c_s,y_{<t})
\right).
\]

The teacher may be an external model, a frozen copy of the student, or the current model queried with extra context. The decisive advantage is dense token-level information on prefixes the student actually visits. The decisive risk is that a confident or poorly conditioned teacher can densify the wrong signal.

---

## 3. Foundations: what each base method contributes

### 3.1 PPO and RLHF

[Proximal Policy Optimization](https://arxiv.org/abs/1707.06347) supplied a practical clipped policy-gradient algorithm. [InstructGPT](https://arxiv.org/abs/2203.02155) made a three-stage language-model pipeline canonical: collect demonstrations for SFT, collect human comparisons to train a reward model, then optimize the policy against that reward while constraining drift.

The important lesson is architectural, not historical. RLHF separates the desired behavior from the update through a learned reward model. That allows optimization beyond fixed demonstrations, but any error or exploitable proxy in the reward becomes an optimization target.

### 3.2 DPO

[Direct Preference Optimization](https://arxiv.org/abs/2305.18290) showed that the constrained reward-maximization solution can be reparameterized into a direct classification-like objective over preference pairs. Its lasting contribution is making preference alignment operationally simpler.

DPO should not be treated as “RL without rollouts” in every sense. It cannot react to the current policy’s newly exposed failures unless the preference dataset is refreshed. It is best when preference pairs are high quality, cover the behavior of interest, and online environment interaction is unnecessary or too expensive.

### 3.3 GKD and on-policy distillation

[Generalized Knowledge Distillation](https://arxiv.org/abs/2306.13649) emphasizes learning from teacher distributions on student-generated sequences. The most important idea is exposure correction: the student receives guidance on the prefixes it actually creates, including its mistakes, instead of only on teacher-forced expert prefixes.

This is the conceptual parent of the 2026 self-distillation family. OPSD, SDFT, and SDPO differ chiefly in how they construct the enhanced teacher context.

### 3.4 GRPO

GRPO’s practical importance is that it makes grouped online reinforcement learning relatively simple for verifiable tasks. It avoids a separate critic, supports repeated sampling per prompt, and fits the exact-answer regime that drove 2025 reasoning work.

Its limitations follow directly from its information channel:

- binary outcome reward is sparse;
- all-zero or all-one groups have little or no relative learning signal;
- long trajectories make token-level credit difficult;
- normalization and length conventions can create unintended biases;
- repeated rollouts are expensive;
- a verifier can be correct on ordinary outputs yet exploitable under optimization.

---

## 4. The scalar-reward branch: making RLVR work

### 4.1 DeepSeek-R1 and Kimi k1.5

[DeepSeek-R1](https://arxiv.org/abs/2501.12948) established that large-scale RL on verifiable reasoning tasks can produce strong reasoning behavior and that a reasoning-first model can be distilled into smaller models. [Kimi k1.5](https://arxiv.org/abs/2501.12599) emphasized long-context reinforcement learning, careful data and reward design, and scaling.

The key lesson from both is not that one recipe can be copied into a small lab. Their results arise from a system: capable base models, large and diverse prompt pools, reliable verifiers, significant rollout budgets, training stability work, and evaluation discipline.

### 4.2 DAPO

[DAPO](https://arxiv.org/abs/2503.14476) isolates four changes that make large-scale RLVR more stable and effective:

- **clip-higher**, which permits more upward probability movement for useful low-probability tokens;
- **dynamic sampling**, which filters prompts whose sampled groups carry no useful reward variation;
- **token-level policy-gradient loss**, avoiding sequence-length distortions from sample-level averaging;
- **overlong reward shaping**, which makes truncation penalties less abrupt.

The reported open-source system reached 50 points on AIME 2024 with a Qwen2.5-32B base model. The broader research contribution is to show that “GRPO performance” is highly sensitive to sampling, normalization, and length accounting.

### 4.3 Dr. GRPO

[Understanding R1-Zero-Like Training: A Critical Perspective](https://arxiv.org/abs/2503.20783), often discussed as Dr. GRPO, argues that common GRPO choices can introduce response-length bias. Removing question-level reward standardization and length-dependent normalization produced a minimalist recipe whose 7B model reached a reported 43.3 on AIME 2024.

The most important part is the diagnostic method: inspect what quantity the objective actually weights. If two equally rewarded answers receive different effective gradient mass because one is longer, the training system is optimizing more than correctness.

### 4.4 GSPO and GMPO

[GSPO](https://arxiv.org/abs/2507.18071) moves the importance ratio and clipping logic toward the sequence level, motivated by stability and alignment between the unit of reward and the unit of optimization. [GMPO](https://arxiv.org/abs/2507.20673) uses geometric-mean aggregation to reduce length-related distortions in sequence probabilities.

These papers matter because they challenge the idea that token-wise clipping is an implementation detail. In long autoregressive trajectories, the aggregation unit changes which responses dominate the update.

### 4.5 Scaling behavior

[Scaling Behaviors of LLM Reinforcement Learning Post-Training](https://arxiv.org/abs/2509.25300) studies how model size, rollout scale, and training interact. The laboratory implication is to avoid extrapolating from a tiny model or short run. A method may fail because the base policy cannot use the signal, succeed briefly before collapse, or require a rollout regime that a small pilot never reaches.

---

## 5. What does RLVR actually add?

The most important scientific dispute of 2025 was whether RLVR creates new reasoning capability or mostly makes already-available correct responses more likely.

### 5.1 The pass@1 versus pass@k distinction

Pass@1 asks whether the most likely or one sampled response succeeds. Pass@k asks whether at least one of \(k\) samples succeeds. A model can improve pass@1 by concentrating probability on a known-good mode while reducing diversity, leaving pass@k flat or worse.

[Does Reinforcement Learning Really Incentivize Reasoning Capacity Beyond the Base Model?](https://arxiv.org/abs/2504.13837) argues that observed gains are often bounded by capabilities already present in the base model’s sampling distribution. [RLVR Implicitly Incentivizes Correct Reasoning in Base LLMs](https://arxiv.org/abs/2506.14245) similarly studies how RL shifts existing reasoning patterns. [The Debate on the RLVR Reasoning Capability Boundary](https://arxiv.org/abs/2510.04028) frames and tests the disagreement.

The clean interpretation is not “RL never creates capability.” It is:

> A pass@1 gain alone does not identify whether training discovered a new strategy, selected a rare existing strategy, compressed a search procedure, or merely reduced entropy.

### 5.2 Entropy minimization

[The Unreasonable Effectiveness of Entropy Minimization in LLM Reasoning](https://arxiv.org/abs/2505.15134) shows that reducing entropy can reproduce a surprising fraction of apparent reasoning improvement. This provides a critical control experiment. A lab should compare reward learning against an entropy-only or no-semantic-reward baseline where feasible.

Entropy is neither intrinsically good nor bad. Reducing it can turn a fragile, low-probability correct behavior into a reliable answer. Excessive reduction can collapse diversity, harm pass@k, and make recovery from distribution shift harder.

### 5.3 One example and spurious reward

[Reinforcement Learning for Reasoning with One Training Example](https://arxiv.org/abs/2504.20571) demonstrates that very small training sets can trigger broad changes. That makes RL look remarkably data efficient, but also warns that data count is a poor proxy for information or compute: one prompt can generate many rollouts and updates.

[Spurious Rewards](https://arxiv.org/abs/2506.10947) shows that even rewards unrelated to semantic correctness can sometimes induce benchmark gains. This means benchmark improvement does not automatically validate the intended causal story. The policy may exploit correlations in format, length, confidence, or the base model’s own latent structure.

### 5.4 ProRL and curriculum evidence

[ProRL](https://arxiv.org/abs/2505.24864) presents evidence that prolonged reinforcement learning can extend reasoning performance when training is stabilized and scaled. [Curriculum RL Can Incentivize Reasoning Capacity Beyond the Base Model](https://arxiv.org/abs/2606.22317) argues that a curriculum can move the capability boundary by keeping learning near productive difficulty.

Together with the capacity-limit papers, these results suggest a conditional view: RL is most likely to expand capability when training maintains a frontier of solvable-but-not-mastered tasks, preserves exploration, and runs long enough to bootstrap new strategies. Fixed sets dominated by impossible or already-solved prompts mostly provide noise or entropy pressure.

---

## 6. Data is part of the algorithm

### 6.1 The useful difficulty band

For grouped binary reward, a prompt with empirical pass rate \(p\) has the most outcome uncertainty near \(p=0.5\). When \(p\) is close to zero, groups often contain no successes. When \(p\) is close to one, they often contain no failures. Both cases weaken relative credit.

This motivates difficulty targeting, but “always pick 50% pass-rate prompts” is too simple. Hard examples may become useful later, easy examples can preserve foundations, and the pass rate is policy- and sampling-dependent.

### 6.2 Online selection and replay

[Difficulty-Targeted Online Data Selection and Rollout Replay](https://arxiv.org/abs/2506.05316) reports reaching comparable performance in roughly 25–65% less training time across its studied settings. The lasting contribution is the combination of two controls:

- spend new rollouts where the current policy has informative uncertainty;
- reuse previously informative trajectories instead of paying to regenerate everything.

Replay introduces off-policy drift, so a receipt must identify which policy generated each rollout and how stale it is.

[Towards High Data Efficiency in RLVR](https://arxiv.org/abs/2509.01321) continues the focus on extracting more signal per rollout. These methods reinforce a practical rule: report generated tokens and environment executions, not just optimizer steps.

### 6.3 Self-generated tasks

[Absolute Zero](https://arxiv.org/abs/2505.03335) studies a system that proposes tasks and improves from executable feedback without relying on a fixed human-authored task set. Its central importance is moving curriculum generation into the learning loop.

The risk is circularity. A proposer can learn to generate tasks that are easy to verify, easy to exploit, or unrepresentative of deployment. Self-generated data therefore needs external frozen evaluation and diversity controls.

### 6.4 Pass-rate-weighted self-distillation

[Restoring the Sweet Spot](https://arxiv.org/abs/2605.27765) applies pass-rate weighting to self-distillation, using a factor related to \(\sqrt{p(1-p)}\). It connects the RLVR curriculum insight to dense teacher signals: even when every token can receive a KL target, examples at the capability frontier can still be the most useful.

---

## 7. The self-distillation branch

### 7.1 The shared mechanism

On-policy self-distillation creates two views of the same trajectory:

- the **student view**, containing only information available at deployment;
- the **teacher view**, containing extra evidence such as a solution, demonstration, or failure explanation.

The student generates the trajectory. The teacher evaluates the same prefix with richer context. The update makes the deployment-time student distribution resemble that enhanced distribution.

This is a form of information removal: train with privileged context, infer without it.

### 7.2 OPSD: privileged solutions

[Self-Distilled Reasoner](https://arxiv.org/abs/2601.18734) introduces on-policy self-distillation with a privileged verified solution. The teacher and student share model weights, but the teacher sees the reference solution while assigning token distributions to the student’s sampled trajectory.

The most important result is that a same-weight teacher can be useful because **conditioning**, not parameter count, creates the advantage. On the paper’s reported aggregate:

| Model | Base | SFT | GRPO | OPSD |
| --- | ---: | ---: | ---: | ---: |
| Qwen3-8B | 61.8 | 59.8 | 64.0 | **64.8** |
| Qwen3-4B | 61.2 | 58.6 | 62.7 | **63.6** |
| Qwen3-1.7B | 37.1 | 35.8 | 37.7 | **43.4** |

The paper also reports an illustrative efficiency contrast using one shorter rollout for OPSD versus grouped long rollouts for GRPO in its setup. This should not be universalized into a fixed cost ratio, but it highlights why rollout-token accounting matters.

Important implementation details include full-vocabulary forward KL, pointwise clipping, and a fixed initial teacher. OPSD requires a verified solution or reasoning trace that must remain privileged: if it leaks into the student prompt or frozen evaluation, the experiment is invalid.

### 7.3 SDFT: demonstrations and continual learning

[Self-Distillation Enables Continual Learning](https://arxiv.org/abs/2601.19897) uses an expert demonstration in the teacher context. The model samples from its own student context, while a demonstration-conditioned teacher provides a dense distribution on those sampled prefixes.

This differs subtly from SFT. SFT imitates one demonstration token by token. SDFT asks, “Given this demonstration, how would the teacher distribute probability over the continuation of the student’s own attempt?” That can preserve multiple valid forms and correct states the student actually encounters.

The paper’s reported knowledge-acquisition aggregate is:

| Method | Strict | Lenient | OOD |
| --- | ---: | ---: | ---: |
| SFT | 80 | 95 | 80 |
| SDFT | **89** | **100** | **98** |
| Oracle RAG | 91 | 100 | 100 |
| Continued pretraining | 9 | 37 | 7 |

Its most important claim is about retention. Continual post-training should measure both newly acquired skill and old capabilities. The study evaluates domains including scientific knowledge, tools, medicine, and new events while tracking a retention suite. Any OpenPond SDFT experiment should make retention evaluation mandatory, not optional.

### 7.4 SDPO: rich failure feedback

[Reinforcement Learning via Self-Distillation](https://arxiv.org/abs/2601.20802) conditions the self-teacher on rich textual feedback from the environment. Instead of representing a failed code attempt as reward 0, the teacher may receive compiler output, failed-test evidence, or a judge explanation and supply token-level guidance.

The paper reports:

| Evaluation | GRPO | SDPO |
| --- | ---: | ---: |
| Aggregate across standard RLVR tasks and studied model families | 66.6 | **70.2** |
| LiveCodeBench v6 | 41.2 | **48.8** |

The key insight is counterfactual: a failed rollout can be highly informative if the environment explains the failure. Sparse RL often discards that structure.

The method depends on the model’s in-context learning strength and on feedback quality. It also needs access to teacher probabilities. The paper compresses these using top-k logits with a tail approximation, showing a practical path that avoids storing full-vocabulary distributions.

### 7.5 The three methods are not aliases

| Dimension | OPSD | SDFT | SDPO |
| --- | --- | --- | --- |
| Teacher’s extra context | Verified solution | Expert demonstration | Feedback on current attempt |
| Best fit | Exact-answer reasoning | Knowledge/tool acquisition and retention | Code, tools, and explainable failures |
| Main data asset | Privileged solution | Demonstration | Structured feedback |
| Principal leakage risk | Answer reaches student | Demo contaminates held-out tasks | Hidden test details become policy-visible |
| Principal failure mode | Weak self-teacher or bad solution | Forgetting or imitation mismatch | Dense drift from noisy feedback |

The distinctions define different dataset schemas. A generic `text` column is not enough.

### 7.6 Follow-on methods

[On-Policy Context Distillation](https://arxiv.org/abs/2602.12275) generalizes the idea of learning from an enhanced context while operating without it. [Embarrassingly Simple Self-Distillation Improves Code Generation](https://arxiv.org/abs/2604.01193) demonstrates a simple self-distillation path for code.

[Sample-Routed Policy Optimization](https://arxiv.org/abs/2604.02288) routes successful samples through GRPO-style outcome learning and failed samples through SDPO-style dense learning. It reports a Qwen3-8B average improvement of 3.4 points over GRPO and 6.3 over SDPO in its studied settings, with cost reductions up to 17.2%. The contribution is not merely mixing losses: it allocates the signal based on what each sample reveals. A verified success supplies positive selection evidence; a failed attempt plus feedback supplies corrective information.

[Reflective On-Policy Self-Distillation](https://arxiv.org/abs/2605.28014) localizes errors and conditions guidance on reflection. [Guided On-Policy Distillation for Multi-Turn Agents](https://arxiv.org/abs/2606.15912) extends the family to interactive trajectories where guidance must respect evolving state.

[Denser Is Not Better](https://arxiv.org/abs/2607.01763) is essential counterevidence. Dense self-distillation can cause distribution drift, forgetting, or collapse. A denser gradient is only more informative when the teacher context and divergence direction are aligned with the behavior we want. This paper is why every dense-distillation run needs reference drift, retention, entropy, and per-domain evaluation.

---

## 8. Agentic reinforcement learning

Agent training changes the unit of success from an answer to a trajectory through state. Credit assignment becomes harder, but the environment can return richer evidence.

### 8.1 Software engineering

[SWE-RL](https://arxiv.org/abs/2502.18449) applies reinforcement learning to software-engineering tasks and reports 41 on SWE-bench Verified for its 70B model in the paper. Its importance lies in training on repository-scale interactions rather than isolated code completion.

For a lab, SWE tasks are expensive and contamination-prone. Each episode needs a pinned repository revision, deterministic setup where possible, isolated execution, patch and test receipts, and protection against hidden-test leakage.

### 8.2 Search

[Search-R1](https://arxiv.org/abs/2503.09516) trains language models to use search with reinforcement learning and reports substantial improvements, including gains of up to 26% in a studied Qwen-7B setting. Search introduces partial observability: the policy decides both what evidence to retrieve and how to answer.

Evaluation must distinguish retrieval success, evidence use, citation fidelity, and final-answer correctness. Rewarding only the final answer can accidentally train unsupported guessing.

### 8.3 Multi-turn state

[RAGEN](https://arxiv.org/abs/2504.20073) studies reinforcement learning for generalizable agents in multi-turn environments. The central challenge is trajectory-level credit: early tool choices change later observations, and an outcome reward may arrive long after the causal action.

[WebAgent-R1](https://arxiv.org/abs/2505.16421) reports large improvements for web agents in its environment, from 6.1 to 33.9 for a 3B model and 8.5 to 44.8 for an 8B model. These numbers demonstrate opportunity, not automatic generalization to the open web. A benchmark browser, its DOM representation, allowed actions, and reward rules are part of the learned task.

### 8.4 Why rich feedback matters more for agents

An exact final reward treats these failures alike:

- selecting the wrong tool;
- forming the wrong arguments;
- losing state after a correct action;
- encountering an environment fault;
- reaching the correct state but formatting the answer incorrectly.

Structured feedback can separate them. This makes agent environments a natural target for SDPO and routed objectives, provided hidden state and privileged evaluator evidence never leak into deployment-time inputs.

---

## 9. Verifiers are attack surfaces

RLVR is often described as objective because a program checks the answer. Under optimization, “programmatic” does not mean “correct.”

[RLVR with Verifiable Yet Noisy Rewards](https://arxiv.org/abs/2510.00915) studies learning when supposedly verifiable rewards are noisy. [An Imperfect Verifier Is Good Enough](https://arxiv.org/abs/2604.07666) provides evidence that useful learning can remain possible under some verifier imperfection. [LLMs Gaming Verifiers](https://arxiv.org/abs/2604.15149) examines exploitative behavior.

The practical synthesis is:

- random verifier error adds variance and reduces sample efficiency;
- systematic false positives create an exploitable target;
- false negatives can suppress valid diverse solutions;
- visible verifier details can turn evaluation into answer leakage;
- a verifier validated on ordinary model outputs may fail on adversarial outputs produced after training against it.

A serious verifier suite should include:

1. fixtures for valid and invalid outputs;
2. metamorphic cases that preserve semantics while changing form;
3. adversarial formatting and injection cases;
4. an independently implemented shadow grader;
5. human audit of high-reward novelty;
6. frozen holdout tasks not used for online selection;
7. versioned code and environment hashes.

Reward design should separate task success, format compliance, safety constraints, and infrastructure health. An environment crash must not become a positive or negative task label.

---

## 10. Clean datasets: the experimental contract

“Clean” should not mean merely deduplicated or free of profanity. A clean post-training dataset is one whose provenance, information boundaries, splits, labels, and evaluation relationship are explicit.

### 10.1 Canonical semantic fields

A reusable row can contain:

| Field | Visible to policy? | Purpose |
| --- | --- | --- |
| `prompt` / `messages` | Yes | Deployment-time input |
| `demonstration` | Method-dependent | SFT target or SDFT teacher context |
| `chosen`, `rejected` | Trainer only | Preference learning |
| `expectedOutcome` | Usually no | Evaluation |
| `privilegedSolution` | Teacher only | OPSD |
| `scalarReward` or grader | No direct leakage | GRPO/RLVR |
| `richFeedback` | Teacher only unless deployment exposes it | SDPO |
| `clusterId` | No | Leakage-safe splitting |
| provenance and license | No | Governance and reproduction |

The same prompt may support several methods, but the training export must reveal only the fields allowed by that method.

### 10.2 Split by source clusters, not rows

Near duplicates, template variants, repeated repositories, and multiple conversations about one incident must remain in one split. Otherwise evaluation can measure memory of the same underlying example.

Use at least:

- `train`;
- `validation` for model and checkpoint selection;
- `frozen_eval`, never used for data selection, prompt tuning, or stopping;
- optionally an external benchmark and a retention suite.

### 10.3 Contamination has several forms

- **Exact contamination:** identical prompt or answer.
- **Semantic contamination:** paraphrase or equivalent task.
- **Procedural contamination:** the hidden evaluator logic appears in training.
- **Benchmark-family contamination:** generated variations reproduce a known benchmark.
- **Teacher leakage:** the privileged solution or feedback enters the student context.
- **Selection leakage:** frozen-eval performance affects which data is trained next.

Hashing catches only the first. Cluster-aware similarity, source lineage, benchmark registries, and review are required for the others.

### 10.4 Baselines belong to the dataset revision

For RLVR, record per-example and aggregate baseline pass rates under the exact base model, tokenizer, template, sampler, and verifier. A dataset is not “good for GRPO” in the abstract. It is informative relative to a policy.

For distillation, also measure teacher advantage: if the enhanced teacher context does not improve token likelihood or task outcome over the student context, dense matching has no reason to help.

---

## 11. Should OpenPond support Hugging Face datasets?

Yes. It would materially improve the Lab by making public datasets easier to inspect, adapt, and reproduce. The correct feature is **Hugging Face import into an immutable OpenPond Taskset**, not direct training from an arbitrary Hub identifier.

### 11.1 Why it is worth doing

- Public post-training corpora commonly live on the Hub.
- Dataset cards, configurations, splits, and viewer previews accelerate discovery.
- Immutable revisions make external results easier to reproduce.
- A typed mapper can convert varied column names into method-neutral semantic fields.
- Streaming and Parquet access can preview large datasets without downloading everything.

### 11.2 Required safeguards

An import receipt should retain:

- repository ID and immutable commit SHA;
- selected configuration and upstream split;
- dataset-card hash and declared license;
- gated-access state;
- source file and content hashes;
- row identity or deterministic selection rule;
- importer and mapping versions;
- consent, PII, secret, and license review decisions;
- deduplication and cluster report;
- local split and artifact hashes.

The first version should not execute arbitrary remote dataset code. It should prefer inspectable formats and bounded preview/materialization. Mutable branches such as `main` can be explored, but a Taskset cannot become approved until resolved to an immutable revision.

### 11.3 Mapping presets

The importer should offer presets, then require an explicit review:

- prompt-only for RLVR;
- prompt plus demonstration for SFT;
- prompt plus chosen/rejected for DPO;
- prompt plus privileged solution for OPSD;
- prompt plus demonstration for SDFT teacher context;
- prompt plus environment-feedback schema for SDPO.

No preset can infer that a field is safe for policy visibility merely from its name.

---

## 12. A fair experimental program

### 12.1 Conserve the right resources

Compare at least four budgets:

- **rollout tokens** generated by policies;
- **teacher tokens** and forward passes used for distillation;
- **optimizer tokens** receiving gradients;
- **environment executions**, wall time, accelerator time, and cost.

An optimizer-step comparison can hide an order-of-magnitude rollout difference. Report both equal-resource curves and each method’s best stable configuration.

### 12.2 Required controls

Every campaign should include:

- the untouched base model;
- SFT when demonstrations exist;
- a no-semantic-reward or entropy control where meaningful;
- the strongest simple GRPO/Dr. GRPO baseline;
- equal prompt pools and immutable evaluation;
- at least three seeds for claims about method superiority;
- final and best-checkpoint results;
- confidence intervals or bootstrap intervals;
- reference-distribution drift and retention.

### 12.3 Core metrics

**Capability**

- pass@1, pass@k, and calibration;
- out-of-distribution task families;
- step or tool success where observable;
- human audit for novel successful strategies.

**Optimization dynamics**

- reward and pass-rate distribution;
- group reward variance;
- output length and truncation;
- entropy and distinct strategy proxies;
- KL to the base/reference model;
- gradient and clipping statistics.

**Reliability**

- verifier disagreement;
- exploit rate;
- environment error rate;
- result variance across seeds;
- retention by domain.

**Efficiency**

- tokens, forward passes, executions, time, memory, and dollars to a target score.

### 12.4 Campaign A: verified mathematical reasoning

**Question:** When a verified solution exists, does dense same-model guidance beat sparse relative reward at equal compute?

Compare base, SFT, Dr. GRPO, OPSD, and an entropy control on the same cluster-safe math Taskset. Use exact-answer grading plus a shadow symbolic or human audit. Evaluate both pass@1 and pass@k. Vary model size because self-teacher quality may have a threshold.

The central ablations are:

- fixed versus moving self-teacher;
- forward versus reverse KL;
- full-vocabulary versus top-k teacher targets;
- equal rollout tokens versus equal total forward tokens;
- solution quality and solution visibility.

### 12.5 Campaign B: continual tool learning

**Question:** Can SDFT acquire a new tool protocol while preserving unrelated capabilities better than SFT?

Build demonstrations for a bounded tool environment. Compare SFT and SDFT at matched student optimizer tokens, then matched total compute. Require a retention suite and novel task compositions. Track tool selection, argument validity, recovery, and final outcome separately.

### 12.6 Campaign C: code and rich feedback

**Question:** How much value is contained in failed rollouts when compiler and test feedback are available?

Compare GRPO, SDPO, and SRPO. Separate public feedback available to the deployed agent from privileged hidden-test feedback available only to the teacher. Audit whether the student learns hidden-test artifacts. Route environment faults away from task reward.

### 12.7 Campaign D: curriculum

Compare uniform sampling, difficulty bands, online pass-rate selection, replay, and a staged curriculum under the same rollout budget. Measure whether gains come from faster selection of existing behavior or expansion of pass@k.

### 12.8 Campaign E: verifier robustness

Train against a deliberately imperfect verifier with controlled false-positive and false-negative modes. Keep a shadow verifier hidden. Measure when policies discover systematic exploits and whether rich feedback makes exploitation easier or harder.

---

## 13. The most important research questions

The following questions are more durable than any current method name.

### 13.1 When does dense feedback add information rather than confidence?

Compare the enhanced teacher’s distribution to the student’s on the same prefixes. If the teacher is only sharper but not more correct, self-distillation may reproduce entropy minimization. Measure teacher advantage, calibration, and downstream success.

### 13.2 When does RL discover versus select?

Track pass@k, strategy clusters, and previously unseen valid solution forms. A new high-probability answer is not evidence of discovery if the base model already produced it under broad sampling.

### 13.3 How should signals be routed by sample state?

Successes, near misses, invalid outputs, and environment faults contain different evidence. SRPO suggests routing by success/failure, but a richer router could use verifier confidence, teacher advantage, novelty, and estimated exploit risk.

### 13.4 What is the smallest sufficient teacher representation?

Full logits are expensive. Top-k with a tail approximation is practical, but the approximation may erase useful uncertainty. Study the tradeoff among full vocabulary, top-k, sampled alternatives, and logit-free pairwise targets.

### 13.5 How does privileged information leak through optimization?

Even if a solution never appears in the student prompt, the model can internalize dataset-specific answer patterns or hidden-test structure. Evaluate equivalent tasks with different hidden implementations and audit memorization of privileged strings.

### 13.6 What does “equal compute” mean across methods?

There is no single perfect scalar. Publish a resource vector and performance frontier instead of collapsing policy generation, teacher inference, optimization, and environment execution into one opaque step count.

---

## 14. Annotated 2025–2026 reading map

This is the shortest statement of why each paper belongs in the lab curriculum.

### Scalar-reward reasoning

- [Kimi k1.5](https://arxiv.org/abs/2501.12599) — long-context RL is a full data-and-systems problem, not only an objective.
- [DeepSeek-R1](https://arxiv.org/abs/2501.12948) — large-scale verifiable RL and reasoning distillation established the modern reference point.
- [DAPO](https://arxiv.org/abs/2503.14476) — sampling, clipping, token aggregation, and overlong handling materially change results.
- [Dr. GRPO](https://arxiv.org/abs/2503.20783) — normalization can create length bias; audit the effective weighting.
- [GSPO](https://arxiv.org/abs/2507.18071) — align optimization and clipping with sequence-level reward.
- [GMPO](https://arxiv.org/abs/2507.20673) — geometric aggregation offers another route around length distortion.
- [Scaling Behaviors](https://arxiv.org/abs/2509.25300) — small or short runs do not reliably predict scaled behavior.

### Capability, entropy, and causality

- [The RLVR capability-limit study](https://arxiv.org/abs/2504.13837) — ask whether gains lie within the base distribution.
- [One-example RL](https://arxiv.org/abs/2504.20571) — example count can be tiny while rollout information and compute are large.
- [Entropy Minimization](https://arxiv.org/abs/2505.15134) — include a control for probability concentration.
- [ProRL](https://arxiv.org/abs/2505.24864) — sustained, stabilized RL can tell a different story from short runs.
- [Spurious Rewards](https://arxiv.org/abs/2506.10947) — benchmark gains do not prove the reward’s intended semantics caused them.
- [RLVR Implicitly Incentivizes Correct Reasoning](https://arxiv.org/abs/2506.14245) — study redistribution of base-model reasoning modes.
- [The RLVR Debate](https://arxiv.org/abs/2510.04028) — capability-boundary claims depend on metrics and experimental regime.
- [Curriculum RL](https://arxiv.org/abs/2606.22317) — a moving difficulty frontier can matter more than a fixed prompt pool.

### Data efficiency

- [Absolute Zero](https://arxiv.org/abs/2505.03335) — task generation itself can enter the reinforcement loop.
- [Difficulty-Targeted Selection and Replay](https://arxiv.org/abs/2506.05316) — spend rollouts on informative prompts and reuse them carefully.
- [High Data Efficiency in RLVR](https://arxiv.org/abs/2509.01321) — optimize signal per expensive rollout.
- [Pass-Rate-Weighted Self-Distillation](https://arxiv.org/abs/2605.27765) — the useful difficulty band applies to dense learning too.

### Self-distillation

- [OPSD](https://arxiv.org/abs/2601.18734) — a same-weight teacher becomes stronger through access to a verified solution.
- [SDFT](https://arxiv.org/abs/2601.19897) — demonstration-conditioned on-policy targets can improve acquisition and retention.
- [SDPO](https://arxiv.org/abs/2601.20802) — textual failure feedback can become dense token-level credit.
- [OPCD](https://arxiv.org/abs/2602.12275) — enhanced-context behavior can be distilled into a context-free policy.
- [Simple code self-distillation](https://arxiv.org/abs/2604.01193) — code is a tractable domain for direct self-teaching experiments.
- [SRPO](https://arxiv.org/abs/2604.02288) — route successful and failed samples to the signal they can support.
- [ROSD](https://arxiv.org/abs/2605.28014) — localize errors before distilling corrections.
- [Guided OPD for agents](https://arxiv.org/abs/2606.15912) — multi-turn state requires trajectory-aware guidance.
- [Denser Is Not Better](https://arxiv.org/abs/2607.01763) — dense guidance can accelerate the wrong distribution shift.

### Agents

- [SWE-RL](https://arxiv.org/abs/2502.18449) — repository-scale software tasks make environment reproducibility central.
- [Search-R1](https://arxiv.org/abs/2503.09516) — retrieval policy and answer policy can be trained together.
- [RAGEN](https://arxiv.org/abs/2504.20073) — generalizable multi-turn agents need stateful credit assignment.
- [WebAgent-R1](https://arxiv.org/abs/2505.16421) — interactive web policies can improve dramatically inside a defined environment.

### Verifiers

- [Verifiable Yet Noisy Rewards](https://arxiv.org/abs/2510.00915) — objective-looking rewards still carry label noise.
- [An Imperfect Verifier Is Good Enough](https://arxiv.org/abs/2604.07666) — some verifier error is tolerable, depending on its structure.
- [LLMs Gaming Verifiers](https://arxiv.org/abs/2604.15149) — optimize against a verifier only after treating it as an adversarial interface.

### Surveys

- [LLM Post-Training: A Deep Dive into Reasoning Large Language Models](https://arxiv.org/abs/2502.21321) — broad reasoning-oriented background.
- [A Survey on Post-Training of Large Language Models](https://arxiv.org/abs/2503.06072) — broad post-training taxonomy.
- [A Survey of On-Policy Distillation](https://arxiv.org/abs/2604.00626) — focused map of the rapidly growing OPD family.
- [A Unified View of Off-Policy and On-Policy Learning](https://arxiv.org/abs/2604.07941) — relates the families through data and policy provenance.

---

## 15. Recommended learning path

1. Read the SFT, PPO/RLHF, DPO, GRPO, and GKD sections until you can identify the data object each objective requires.
2. Work through DAPO and Dr. GRPO together. They teach how seemingly small normalization choices change the experiment.
3. Read the capability-boundary, entropy, spurious-reward, and ProRL papers as a debate. Write down what evidence would distinguish selection from discovery.
4. Study OPSD, SDFT, and SDPO side by side. For each, draw the student context, teacher context, trajectory source, and divergence target.
5. Read SRPO and Denser Is Not Better together. One motivates signal routing; the other prevents assuming dense guidance is automatically safe.
6. Study one agent domain and the verifier papers. Define what information is public, privileged, hidden, noisy, and exploitable.
7. Design the immutable dataset and experiment receipt before launching a paid run.

The companion [ManimGL course](post-training-course/manim/README.md) follows this order and uses animated examples for the concepts whose temporal structure is easiest to understand in motion.

---

## 16. Glossary

**Advantage** — an estimate of how much better an action or trajectory was than a baseline.

**Behavior policy** — the policy that generated the training trajectory.

**Credit assignment** — deciding which choices should receive responsibility for a later outcome.

**Distillation** — training a student distribution to match information from a teacher distribution.

**Forward KL** — \(D_{\mathrm{KL}}(T\Vert S)\); heavily penalizes the student for missing probability mass supported by the teacher.

**GRPO** — group relative policy optimization; uses within-prompt reward comparisons instead of a learned value critic.

**On-policy** — data is generated by the current or near-current policy being trained.

**OPD** — on-policy distillation; teacher targets are evaluated on student-generated trajectories.

**OPSD** — on-policy self-distillation with a privileged solution.

**Pass@k** — probability that at least one of \(k\) sampled responses succeeds.

**Policy-visible** — information available to the model at deployment-time inference.

**Privileged information** — evidence allowed for training or evaluation but unavailable to the deployed policy.

**Reverse KL** — \(D_{\mathrm{KL}}(S\Vert T)\); often encourages mode-seeking behavior and behaves differently when teacher support is broad.

**RLHF** — reinforcement learning from human feedback, usually involving a learned reward model.

**RLVR** — reinforcement learning with verifiable rewards.

**SDPO** — self-distillation policy optimization using rich feedback about the current attempt.

**SDFT** — self-distillation fine-tuning using a demonstration-conditioned same-model teacher.

**SFT** — supervised fine-tuning on target demonstrations.

**SRPO** — sample-routed policy optimization, routing samples between sparse-reward and dense-distillation updates.

**Teacher advantage** — the measurable improvement produced by the teacher’s extra context over the student view.

**Verifier** — a program, model, or process that determines whether an output satisfies the task.

---

## Conclusion

The most useful organizing idea for modern post-training is not “Which optimizer wins?” It is:

> What information does this task produce, and how should that information be routed into updates on the states the model actually visits?

GRPO routes relative scalar outcomes from grouped exploration. OPSD routes a verified solution through a privileged same-model teacher. SDFT routes a demonstration into the student’s own prefixes. SDPO routes explanatory failure feedback. SRPO routes each sample according to whether success or failure contains the more useful evidence.

This view also explains why clean datasets, immutable provenance, protected fields, and fair resource accounting are not support work around the research. They are the conditions that make the research interpretable. The first credible OpenPond experiments should therefore be deliberately modest in method count and unusually strict in controls: one base model, one versioned Taskset, one reliable environment, explicit information boundaries, conserved resource vectors, and evaluation that distinguishes probability concentration from genuine capability expansion.

That foundation will make later experiments on curricula, agents, verifier robustness, and adaptive signal routing scientifically cumulative instead of another collection of incomparable training runs.
