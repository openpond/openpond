# Model Access

OpenPond separates agent orchestration from the model provider. The same chat-based development environment should work whether you use OpenPond-hosted chat, BYOK providers in the desktop app, Codex, or open source models.

## OpenPond Chat Hosted

OpenPond Chat is the hosted model path. Use it when you want OpenPond-managed model access, cloud runtime coordination, and a smoother default path for OpenPond Cloud workflows.

Hosted chat is useful for:

- Starting quickly without configuring a local provider.
- Running cloud-backed goals and hosted workspace tasks.
- Keeping OpenPond Cloud runs aligned with the model/runtime path.
- Sharing a predictable model setup across devices or team workflows.

## BYOK In Desktop

BYOK lets you bring your own model keys into the desktop app. The goal is to let you keep using your existing subscriptions while still getting OpenPond's agent orchestration, goals, tools, file edits, Git workflows, and Hybrid Mode.

BYOK is useful for:

- Using an existing model subscription.
- Testing multiple OpenAI-compatible providers.
- Keeping local development independent from OpenPond-hosted model access.
- Pairing local model choice with OpenPond Cloud execution when a task needs remote compute.

## Codex Support

OpenPond has first-class support for OpenAI Codex workflows. Codex-backed sessions can use Codex-native behavior while still fitting into the OpenPond desktop environment, project context, Git-backed source model, and goal-oriented workflows.

## Open Source Models

OpenPond's orchestration layer is designed to help open source models operate with stronger agentic structure:

- Goals and continuation.
- Tool and file access.
- Git-backed source edits.
- Evals, traces, and artifacts.
- OpenPond Cloud execution when local compute is not enough.

The model can change; the agent workflow should remain understandable and reviewable.
