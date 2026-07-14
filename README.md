<div align="center">
  <h1>OpenPond</h1>
  <p><strong>Team-based agents that turn chats into trainable datasets.</strong></p>
  <p>
    <a href="https://github.com/openpond/openpond/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/openpond/openpond/actions/workflows/ci.yml/badge.svg" /></a>
    <a href="https://www.npmjs.com/package/openpond"><img alt="npm package version" src="https://img.shields.io/npm/v/openpond?logo=npm&logoColor=white" /></a>
  </p>
</div>

OpenPond is an open-source agent harness, desktop app, and CLI that turns conversations into **durable, team-based agents** and **training-ready tasks and jobs**. Use whichever model path fits your work: BYOK providers, hosted OpenPond models, open-source models, or the LLM subscriptions you already pay for.

- We aim to provide feature parity with the Codex desktop app while remaining fully open source and focused on turning your work into trainable agents and models.
- Use this repository as a drop-in replacement for the Codex app with OpenAI/Codex, Z.ai, or another API- or subscription-based LLM service.
- Premium features include in-app team communication, agent hosting on OpenPond sandbox infrastructure, OAuth connections, and a managed training service (coming soon). Learn more in [OpenPond Cloud](docs/public/cloud.md).

Explore Desktop, CLI, TUI, model access, goals, Cloud, Connect, and other capabilities in the [public docs](docs/public/README.md).

## Agents & Skills

Agents and skills are first-class, Git-backed parts of an OpenPond Profile and follow the Agent SDK package. Sync your profile with OpenPond Premium to share it with your team. This lets you ship software to nontechnical teammates, chat with people and agents in the app, and use agents directly in a Slack-like team experience.

Learn how they are stored and when to use each one in the [Agents and skills guide](docs/public/agents-and-skills.md).

## Training From Real Work

Select useful chats, add them to a dataset, and let OpenPond recommend the training approach—such as SFT, RL, or GRPO—that best fits the work. The aim is to reduce repeated frontier-model mistakes, speed up the job, and lower costs. Training currently targets local models, while Tasksets can be exported for RunPod or Prime-hosted training, or used with OpenPond Managed Training when it becomes available.

See how conversations become reviewable Tasksets and training bundles in [Training from real work](docs/public/training.md).

## Hybrid: Local <> Cloud

Hybrid mode lets you use your existing subscriptions on your local machine while editing code in OpenPond cloud sandboxes. OpenPond spins up a sandbox for each coding session, and the harness routes file operations and commands through sandboxed tools instead of local ones.

Learn what stays local and how sandbox changes come back in the [Hybrid execution guide](docs/public/local-cloud.md).


## Contributions

Contributions are not currently being accepted. Potential contributors will be reviewed on an ongoing basis. This policy helps ensure code quality and keeps AI-assisted contributions aligned with the project's direction and standards.

## License

OpenPond is available under the [MIT License](LICENSE).
