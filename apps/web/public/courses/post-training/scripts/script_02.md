# Definitions

Post-training from first principles · Lesson 2 of 10 · 6:14

## Learning objective

Decode the notation, objectives, estimators, and acronyms used throughout modern reinforcement fine-tuning.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

OpenPond lesson intro, annotated policy notation, separate logits and softmax explainers, a rollout tuple, concrete reward examples, reward-to-advantage relationships, PPO and GRPO definition cards, baseline estimators, a gradient step, probability ratios and clipping, distribution metrics, and full acronym maps.

## Narration transcript

The expression pi theta of a given state is a compact description of model behavior. Pi names the policy: a probability distribution, not one completed answer. Theta means all adjustable model parameters. The state is the context available now, and an action can be one token, one tool call, or another sampled decision.

Before sampling, the network produces raw scores called logits. A logit is not a percentage and logits do not need to add to one. They can be positive or negative. Only their relative differences matter: a larger logit means the model prefers that action compared with the alternatives available at that position.

Softmax converts logits into probabilities. It exponentiates each logit, then divides by the sum of all exponentiated logits. This makes every result positive and makes the distribution sum to one. In the example, logits three, one, and point two become probabilities of roughly eighty-four, eleven, and five percent. Temperature divides the logits before softmax. Lower temperature sharpens the distribution; higher temperature flattens it.

A rollout, also called a trajectory and written tau, is the interaction record used for learning. The behavior policy mu generated each sampled action. Its log-probability is stored beside the action so training can later compare the old behavior distribution with the current policy. Environment observations affect later states, but only the model's sampled actions receive policy-gradient terms.

Reward is the scalar number emitted by an evaluator. A math checker might return one for an exact answer and zero otherwise. A code environment might return one only when every hidden test passes. A tool task might inspect whether the final database state matches a target. The rule can be binary or graded, but the optimizer sees the number, not the evaluator's full explanation. That richer explanation is feedback.

Reward, return, and advantage are related but not interchangeable. Reward is the scalar emitted at a step or at the end. Return, G at time t, combines future rewards and can discount distant outcomes with gamma. Advantage subtracts a baseline from that return. Positive advantage means the action did better than expected; negative advantage means it did worse. PPO learns a value baseline, while GRPO estimates one from sibling responses.

PPO means Proximal Policy Optimization. It is a policy-gradient method that trains a second network, called a critic or value function, to estimate expected return. The observed return minus that expectation becomes advantage. PPO also clips the probability-ratio incentive so one sampled action cannot drive an arbitrarily large update.

GRPO means Group Relative Policy Optimization. It removes the learned critic and samples several sibling responses for the same prompt. Each response is compared with the group's reward mean and standard deviation. Better-than-group responses receive positive advantage; worse responses receive negative advantage. GRPO keeps policy ratios and clipping.

Both methods need a baseline because raw reward lacks context. PPO's baseline comes from the critic, and Generalized Advantage Estimation combines value predictions across time. GRPO's baseline comes from sibling rewards. If every sibling receives the same reward, the group standard deviation is zero and there is no relative advantage to learn from.

An objective, often written L of theta, turns the training goal into one number. The gradient is the local slope of that objective with respect to every adjustable parameter. Backpropagation computes those slopes. The optimizer applies a learning rate alpha to make a small update from theta to theta prime. In policy-gradient training, the RL method determines the credit weights inside the loss; ordinary differentiation performs the parameter update.

PPO and GRPO use a probability ratio. The numerator is the current policy's probability for the stored action. The denominator is the behavior probability recorded during rollout. A ratio above one means that action became more likely. Clipping with epsilon caps the incentive once the ratio moves too far in one update. It limits this sampled term, but does not prove that the entire model stayed close.

Entropy measures how spread out one policy distribution is. KL divergence compares two distributions and is commonly used to measure movement from a reference model or mismatch between teacher and student. Its direction matters. Cross-entropy uses target probabilities q to weight the log of student probabilities p. Distillation usually minimizes this quantity so the student assigns probability where the teacher does.

RL means reinforcement learning. RFT means reinforcement fine-tuning: applying an RL-style objective to an already pretrained model. RLVR adds verifiable rewards, such as executable tests. PPO and GRPO are policy update rules. PPO is Proximal Policy Optimization. GRPO is Group Relative Policy Optimization. GAE is Generalized Advantage Estimation. Pass-at-k asks whether at least one of k sampled attempts succeeds. On-policy and off-policy describe who generated the data.

The teacher-guided methods use dense distributions instead of only scalar outcomes. OPSD is On-Policy Self-Distillation and conditions the teacher on a trusted solution. SDFT is Self-Distillation Fine-Tuning and supplies a demonstration. SDPO is Self-Distillation Policy Optimization and supplies failure feedback. In each case the student creates the prefix and the frozen teacher receives extra evidence. SRPO, Self-Rewarding Policy Optimization, routes successful and unsuccessful samples through different signals.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
