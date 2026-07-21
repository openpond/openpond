# Definitions

Post-training from first principles · Lesson 2 of 10 · 4:41

## Learning objective

Decode the notation, objectives, estimators, and acronyms used throughout modern reinforcement fine-tuning.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

annotated policy notation, logits transformed through softmax, a rollout tuple, reward-to-advantage relationships, a gradient step, probability ratios and clipping, distribution metrics, and full RL and teacher-method acronym maps.

## Narration transcript

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

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
