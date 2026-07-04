# Credentials And Models

OpenPond separates model orchestration from credential ownership. You should be able to chat with the model you choose, inject the credentials a task needs, and keep raw secrets out of agent source code.

## Model Access

OpenPond is designed for:

- BYOK providers and OpenAI-compatible APIs.
- First-class OpenAI Codex support.
- OpenPond-hosted model access where available.
- Open source models that need stronger agentic orchestration around them.

The orchestration layer should keep goals, tools, context, evals, traces, and source edits consistent even when the underlying model changes.

## Credential Injection

Agent source can declare required capabilities, integrations, env vars, and secret slots. The selected credential value is a platform or local binding, not source code.

Examples include:

- Google Drive or document access.
- Twitter/X or social account access.
- Slack, model providers, databases, and internal APIs.
- Project-specific env vars and secret refs.

The exact providers available depend on the configured OpenPond environment and installed connectors.

## Local Boundary

Local use should not require login. Local credentials stay in local settings, local secret storage, or environment-backed configuration. The renderer should receive only redacted status and derived capability information, not raw API keys.

## Cloud Boundary

Cloud features such as OpenPond Cloud, cross-device sync, shared credentials, and hosted runs require cloud bindings. Hosted sandboxes receive credential access through explicit secret refs or integration leases, and those values should stay redacted from source, logs, artifacts, and chat output.

## Agent Source Boundary

Commit declarations, not secrets.

Good source-owned declarations:

- "This agent needs Google Drive access."
- "This action requires `OPENAI_API_KEY`."
- "This workflow needs a persistent volume."
- "This schedule exists but starts disabled until setup is complete."

Platform-owned bindings:

- The selected OAuth connection.
- The raw API key.
- The provisioned volume id.
- The enabled schedule row.
- The hosted sandbox runtime id.
