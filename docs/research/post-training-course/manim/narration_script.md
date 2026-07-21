# Post-Training from First Principles — Production Narration

This is the recording script for the ManimGL course. It complements the visible text rather than reading it aloud. Each chapter is generated separately so its pacing can be fitted to the rendered chapter without changing the video.

The narration voice is AI-generated with the OpenAI Speech API and identified in the audio-stream metadata.

## Chapter 1 — Choose, judge, update

Target window: `00:00.000–01:09.334`
Visuals: OpenPond reveal, course title, full chapter timestamp map, one cancellation-policy choice, useful versus misleading loss curves, and a plain-language choose-test-update loop.

<!-- BEGIN VOICEOVER: Chapter01Policy -->
Post-training changes what a model is likely to do. An input creates a distribution over possible actions, evaluation supplies evidence, and an optimizer changes that distribution.

Here a cancellation test is failing. The policy assigns chances to return None, raise the cancellation error, or retry. Those probabilities describe the available behavior; sampling produces one actual patch.

Loss is a number saying how bad behavior looks under the training rule. Useful training lowers both training loss and held-out error. If training loss falls while held-out error rises, the model is learning the wrong thing.

The sampled patch passes. Training makes the exception-raising action slightly easier to choose in similar states. Ordinary backpropagation implements the change; reinforcement learning determines which sampled behavior receives credit.

A usable training record must also identify who generated the attempt and what evidence accompanied it.
<!-- END VOICEOVER -->

## Chapter 2 — Definitions

Target window: `01:09.334–05:50.001`
Visuals: annotated policy notation, logits transformed through softmax, a rollout tuple, reward-to-advantage relationships, a gradient step, probability ratios and clipping, distribution metrics, and full RL and teacher-method acronym maps.

<!-- BEGIN VOICEOVER: Chapter02Definitions -->
The expression pi theta of a given state is a compact description of model behavior. Pi names the policy: a probability distribution, not one completed answer. Theta means all adjustable model parameters. The state is the context available now, and an action can be one token, one tool call, or another sampled decision.

Before sampling, the network produces raw scores called logits. Softmax exponentiates and normalizes those scores so the resulting probabilities add to one. Temperature divides the logits before softmax. A lower temperature sharpens the distribution; a higher temperature spreads probability across more alternatives. Temperature changes sampling behavior without changing the stored model weights.

A rollout, also called a trajectory and written tau, is the interaction record used for learning. The behavior policy mu generated each sampled action. Its log-probability is stored beside the action so training can later compare the old behavior distribution with the current policy. Environment observations affect later states, but only the model's sampled actions receive policy-gradient terms.

Reward, return, and advantage are related but not interchangeable. Reward is the scalar emitted at a step or at the end. Return, G at time t, combines future rewards and can discount distant outcomes with gamma. Advantage subtracts a baseline from that return. Positive advantage means the action did better than expected; negative advantage means it did worse. PPO learns a value baseline, while GRPO estimates one from sibling responses.

The baseline is an estimate of expected return. PPO trains a second network, called a critic or value function, with its own parameters phi. Generalized Advantage Estimation, or GAE, combines value estimates across several time steps. GRPO removes that critic. It samples a group of responses for the same prompt, computes the group mean and standard deviation of reward, then normalizes each response relative to its siblings. A zero-variance group provides no relative advantage.

An objective, often written L of theta, turns the training goal into one number. The gradient is the local slope of that objective with respect to every adjustable parameter. Backpropagation computes those slopes. The optimizer applies a learning rate alpha to make a small update from theta to theta prime. In policy-gradient training, the RL method determines the credit weights inside the loss; ordinary differentiation performs the parameter update.

PPO and GRPO use a probability ratio. The numerator is the current policy's probability for the stored action. The denominator is the behavior probability recorded during rollout. A ratio above one means that action became more likely. Clipping with epsilon caps the incentive once the ratio moves too far in one update. It limits this sampled term, but does not prove that the entire model stayed close.

Entropy measures how spread out one policy distribution is. KL divergence compares two distributions and is commonly used to measure movement from a reference model or mismatch between teacher and student. Its direction matters. Cross-entropy uses target probabilities q to weight the log of student probabilities p. Distillation usually minimizes this quantity so the student assigns probability where the teacher does.

RL means reinforcement learning. RFT means reinforcement fine-tuning: applying an RL-style objective to an already pretrained model. RLVR adds verifiable rewards, such as executable tests. PPO and GRPO are policy update rules. PPO is Proximal Policy Optimization. GRPO is Group Relative Policy Optimization. GAE is Generalized Advantage Estimation. Pass-at-k asks whether at least one of k sampled attempts succeeds. On-policy and off-policy describe who generated the data.

The teacher-guided methods use dense distributions instead of only scalar outcomes. OPSD is On-Policy Self-Distillation and conditions the teacher on a trusted solution. SDFT is Self-Distillation Fine-Tuning and supplies a demonstration. SDPO is Self-Distillation Policy Optimization and supplies failure feedback. In each case the student creates the prefix and the frozen teacher receives extra evidence. SRPO, Self-Rewarding Policy Optimization, routes successful and unsuccessful samples through different signals.
<!-- END VOICEOVER -->

## Chapter 3 — Where data came from

Target window: `05:50.001–06:51.668`
Visuals: on- and off-policy sources, a concrete rollout record, stored-data schemas, and objective routing.

<!-- BEGIN VOICEOVER: Chapter02OnOffPolicy -->
On-policy data comes from the learner being updated. Policy version twelve generates an attempt that will update version twelve.

Off-policy data comes from a teacher, human, or older checkpoint. These labels describe source, not quality.

An RL rollout stores the problem, sampled actions, generating checkpoint, behavior probabilities, environment observations, and reward.

Text alone cannot connect evaluated behavior to an update. The missing record matters as much as the final response.

Other sources carry different signals: teacher targets, chosen and rejected responses, or old actions with original probabilities and rewards.

PPO and GRPO usually score learner attempts. Offline distillation uses teacher examples. On-policy distillation labels the student's current prefix.

Inside any RL rollout, the final patch is only one part of a sequence of actions and observations.
<!-- END VOICEOVER -->

## Chapter 4 — From outcomes to credit

Target window: `06:51.668–09:46.802`
Visuals: trajectories, rollout tuples, feedback versus reward, credit assignment, discounted return, advantage, entropy, pass@k, reference KL.

<!-- BEGIN VOICEOVER: Chapter03RLSignals -->
An RL rollout is a sequence, not only a final response. Credit assignment asks which decisions inside that sequence should become more or less likely.

The issue and repository form state zero. The behavior policy samples “inspect files.” File contents are an environment observation, not another sampled action. The next state contains those contents. The policy then writes raise Cancelled Error, and test output closes the trajectory.

The tuple makes those roles explicit. Tau contains states, sampled actions, behavior log-probabilities, observations, and terminal reward. Gradients apply to action positions controlled by the policy. Observations condition later actions but are masked out of the policy-gradient loss.

Reward and feedback carry different information. A patch can receive reward zero while the environment still knows that eight tests passed, cancellation failed, and the expected exception was Cancelled Error. Reward is the scalar consumed by an objective. Feedback is the richer evidence the environment produced.

A terminal score also leaves the cause ambiguous. Was the wrong file inspected? Was the timeout branch incorrect? Was “None” the decisive token? Response-level credit applies one outcome broadly. Step- or token-level signals can be denser, but density alone does not prove causal accuracy.

For multi-step problems, return carries future rewards backward. G at time t is the discounted sum of later rewards. With gamma point nine and success two steps later, the earlier action receives return point eight one. PPO critics and Generalized Advantage Estimation, or GAE, build on this idea.

Advantage then asks: better than what was expected? If observed return is point eight and the baseline is point five, advantage is positive point three. A return of point two gives negative point three.

Positive advantage raises the sampled behavior’s probability; negative advantage lowers it. PPO learns a critic for the baseline. GRPO replaces that critic with statistics from sibling responses.

Learning also changes exploration. Pass-at-one can rise while entropy and pass-at-k fall if the model collapses onto one strategy. Reliability and breadth therefore need separate metrics.

Finally, a frozen reference policy anchors behavior outside the optimized task. Kullback–Leibler divergence, shortened to KL, measures distribution shift. Too little constraint permits drift and reward exploits; too much prevents useful learning.

A test-based reward is useful only when the test measures the intended outcome reliably.
<!-- END VOICEOVER -->

## Chapter 5 — Verifiable rewards

Target window: `09:46.802–12:34.636`
Visuals: the cancellation test as verifier, RLVR definition, verifier equation, executable loop, secondary applications, verifier errors, reward hacking, and hidden evaluation.

<!-- BEGIN VOICEOVER: Chapter04RLVR -->
Every reward-based update depends on whether its evaluator measures the right thing. This is the verifier problem.

RLVR means Reinforcement Learning with Verifiable Rewards. For our repair, the verifier applies the patch, runs the cancellation tests, and returns a reproducible outcome. The same idea applies to checked math answers, tool states, and agent environments.

A preference such as “patch A is cleaner” depends on a judge. A verifiable reward applies an explicit rule. Verifiable does not mean infallible; it means the same patch should receive the same result under the same evaluator state.

Write the rule as r equals V of x, y, and e. X is the public task. Y is the sampled attempt. E is evaluator-only state such as hidden tests. For a binary verifier, reward is zero or one.

This equation separates the setting from the optimizer. RLVR supplies reward. PPO, GRPO, or another policy optimizer supplies the update. DeepSeek-R1 is an important example of reasoning training built from this combination.

The full loop is prompt, policy attempt, execution, verification, reward, and policy update. Automatic checks scale because a person does not need to score every trajectory. The verifier also becomes both the task specification and an attack surface.

RLVR applies beyond short math answers. Code can compile and run tests. Tool agents can be checked against a target database state. Search can verify retrieved evidence. Scientific tasks can use simulators and constraints. It is a poor fit when quality is inherently subjective, outcomes cannot be reproduced, or the checker is easy to game.

Verifier errors have two directions. A false negative rejects a valid solution. A false positive is more dangerous under optimization because a wrong solution receives positive gradient and can become an exploit.

Suppose visible tests cover only three examples. Hard-coding those outputs and implementing the general rule both receive reward one. The optimizer cannot distinguish them. Hidden tests, randomized cases, invariants, and shadow verifiers make the measured objective closer to the intended task.

That requires an information boundary. The policy sees the public task and allowed observations. The evaluator alone sees hidden checks and anti-cheat state. Training-only teacher evidence belongs in a third protected channel.

So “RLVR with GRPO” is precise: the first term names how outcomes are labeled, and the second names how those labels become an update.
<!-- END VOICEOVER -->

## Chapter 6 — PPO and GRPO

Target window: `12:34.636–15:23.536`
Visuals: PPO's critic on the cancellation trajectory, GRPO sibling patch attempts, worked group advantages, clipping, mixed-group probability, zero-variance groups, and direct comparison.

<!-- BEGIN VOICEOVER: Chapter05GRPO -->
A trustworthy reward still has to become a learning signal. PPO and GRPO differ mainly in how they decide whether an outcome was better or worse than expected.

PPO means Proximal Policy Optimization. For the successful inspect, patch, and test trajectory, observed return is point eight. A learned critic expected point five. Their difference, positive point three, is the advantage. PPO combines that advantage with a clipped probability ratio and updates the policy.

GRPO means Group Relative Policy Optimization. It keeps rollouts, rewards, probability ratios, and clipping, but removes the critic. Instead, it samples several patches for the same cancellation bug and compares their verifier scores.

Our six sibling patches produce rewards one, zero, zero, one, one, zero. The mean is one half and the standard deviation is one half. Normalizing gives every passing patch advantage positive one and every failing patch negative one.

That comparison is useful but coarse. Raise Timeout Error and return None both failed, so binary GRPO treats them alike even if one was closer. The group says which siblings did better; it does not explain why.

The clipping graph controls how much one sampled action can influence a single update. If its probability moves from point one zero to point one three, the ratio is one point three. With a cap at one point two, additional positive credit stops growing. Clipping limits a local incentive; it does not guarantee that the whole policy stayed close.

A group teaches only when it contains contrast. If one patch succeeds with probability p, a group of size G is mixed with probability one minus p to the G minus one minus p, all to the G. That subtracts all-success and all-failure groups.

Near zero success, almost every group fails. Near one, almost every group passes. Either case produces little relative signal. Larger groups widen the useful middle but require more patch generation and test execution.

This is why prompts need to sit near the learning frontier: difficult enough to fail, possible enough to solve. If every cancellation patch receives the same reward, normalized group advantage is zero.

Both PPO and GRPO need trajectories, rewards, behavior log-probabilities, clipped ratios, and gradients. PPO learns expected value with a critic. GRPO estimates a baseline from sibling patches. The cancellation environment stays the same; only the baseline estimator changes.
<!-- END VOICEOVER -->

## Chapter 7 — Distribution matching

Target window: `15:23.536–18:00.503`
Visuals: cancellation-token hard and soft targets, token cross-entropy, student update, teacher temperature, KL direction, prefix provenance, and privileged teacher context.

<!-- BEGIN VOICEOVER: Chapter06Distillation -->
Outcome rewards compress an attempt to a scalar. Distillation supplies richer guidance by specifying a probability distribution over plausible next tokens.

A one-hot target says “Cancelled Error” and assigns every alternative zero. A teacher distribution can say that “Cancelled Error” is most likely, “Timeout Error” is also plausible, “return” is weak, and “retry” is unlikely. That structure contains more information than the one sampled token.

Teacher probability q weights the log of student probability p over the vocabulary. Minimizing that cross-entropy moves the student toward the teacher. In our example, the student initially favors “return,” while the teacher favors “Cancelled Error.” After an update, the two distributions move closer.

Teacher temperature controls how much of that structure is visible. Low temperature makes the target almost one-hot. Higher temperature reveals alternatives in the tail; too much can magnify noise. Teacher-target temperature is separate from the rollout temperature used to sample behavior.

KL direction changes the lesson too. Forward KL penalizes the student for missing teacher-supported alternatives. Reverse KL strongly penalizes student probability where the teacher assigns little mass, often favoring a narrower mode. “We used KL” is incomplete without direction and temperature.

Prefix provenance determines which states receive teacher targets. Offline distillation uses fixed teacher trajectories. On-policy distillation lets the student reach its own strange cancellation state, then asks the teacher what should come next there.

The teacher does not need larger weights. The same frozen model can see the student's failed prefix plus extra training-only evidence: a verified repair, an expert demonstration, or a test explanation. That evidence changes the teacher distribution.

Training transfers the useful part of that privileged view into student weights. Deployment removes the evidence. A verified solution, demonstration, or failure explanation produces a different teacher target.
<!-- END VOICEOVER -->

## Chapter 8 — Teacher evidence

Target window: `18:00.503–20:38.937`
Visuals: one failed cancellation patch with three teacher evidence channels, OPSD/SDFT/SDPO worked examples, evidence comparison, and shared failure modes.

<!-- BEGIN VOICEOVER: Chapter07Methods -->
OPSD, SDFT, and SDPO share one mechanism. A frozen teacher scores the student's prefix while receiving additional evidence. The evidence source defines the method.

The student distribution is p theta given the issue and its prefix. Teacher target q scores the same next token at the same prefix, but also conditions on evidence e. Training matches q into p; deployment removes e.

On-Policy Self-Distillation, or OPSD, gives the teacher a trusted solution. Here that is the verified repair: preserve cleanup and raise Cancelled Error. The teacher uses it to guide the student's own prefix without placing the privileged patch in the deployed student's prompt. The OPSD paper evaluated this mechanism on reasoning tasks; the animation maps the information flow onto our code case.

Self-Distillation Fine-Tuning, or SDFT, gives the teacher an expert demonstration. A related repair shows the sequence inspect the flag, run cleanup, then raise the exception. Unlike offline imitation, SDFT scores the current student's return-None prefix, so the demonstration guides the state the student actually reached.

Self-Distillation Policy Optimization, or SDPO, gives the teacher feedback about the current failure. The scalar reward is zero, but the test trace says test-cancel failed, expected Cancelled Error, and return skipped cancellation. The teacher converts that explanation into dense token probabilities along the failed prefix.

The choice follows the evidence. A trusted solution supports OPSD. A demonstration supports SDFT. An explanatory failure trace supports SDPO. If all you have is a binary outcome, GRPO may be the honest baseline; inventing a generic “feedback” field would hide these different trust boundaries.

None of the dense methods is automatically safe. A privileged patch can leak. A demonstration can be irrelevant. A teacher can misread feedback and densify an error. New capability can overwrite old behavior, entropy can collapse, and teacher forward passes can erase claimed efficiency savings.

So the durable comparison is not acronym against acronym. Hold the student prefix fixed, vary the evidence, record the cost, and measure both the cancellation repair and unrelated retained capability.
<!-- END VOICEOVER -->

## Chapter 9 — Credible experiments

Target window: `20:38.937–24:06.171`
Visuals: Taskset boundaries, Hugging Face import, baselines, evaluation, compute, experimental campaigns, claim table, synthesis.

<!-- BEGIN VOICEOVER: Chapter08Research -->
A research result requires many versioned tasks, protected information boundaries, matched baselines, and held-out evaluation.

Policy-visible input includes the issue, repository revision, allowed tools, and public tests. Training-only evidence may contain an expert repair, privileged patch, or public diagnostic. Evaluator-only hidden tests, anti-exploit checks, and held-out repository clusters must remain outside both.

The Taskset preserves those boundaries together with source revision, license, split, verifier version, and content hash. Related issues from the same repository should be clustered before splitting; otherwise memorization can look like generalization.

Hugging Face support is worthwhile when it behaves as a reproducible importer. Pin the repository revision. Inspect the dataset card and license. Choose configuration and split explicitly. Map columns through a reviewed transform, log rejected rows, preserve original identifiers, and materialize an immutable snapshot. A training run should never silently follow a changing main branch.

Every proposed method needs a simple credible baseline. Begin with the base model and the most direct token-imitation objective supported by the data. Add offline distillation or preference learning when those signals are relevant. Compare with GRPO or another RLVR baseline before claiming value from OPSD, SDFT, or SDPO.

Equal optimizer tokens and equal total compute answer different questions. A distillation method may use fewer rollouts while spending additional teacher forward passes. Report both controls.

Evaluation should span four dimensions. Capability measures task success. Diversity measures pass-at-k, entropy, and distinct strategies. Retention tests old domains and distribution drift. Integrity audits reward exploits, leakage, and disagreement with a shadow verifier. A single average can hide serious regressions.

Compute accounting includes student rollout tokens, teacher-scored tokens, backward tokens, verifier time, external calls, failed jobs, memory, storage, and wall clock.

The primary study compares GRPO, SDPO, and a routed success-and-failure method on code repair while separating public diagnostics from hidden tests. Verified math can replicate the GRPO and OPSD claims with exact graders. A tool protocol can replicate token imitation and SDFT while measuring retention. The extra domains test whether a conclusion transfers; they do not replace the main story halfway through it.

The paper should bind every claim to a dataset revision, metric, run set, seed, confidence interval, and ablation. That structure keeps a local result from turning into a universal claim.

The final map is simple. Demonstrations produce imitation targets. Preferences produce relative targets. Verifiable outcomes produce rewards. Privileged solutions and failure explanations produce context-conditioned teacher distributions.

Evidence determines the target. The target determines the update. The update changes future behavior. Evaluation measures what improved—and what changed elsewhere.
<!-- END VOICEOVER -->
