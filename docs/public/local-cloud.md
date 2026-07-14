# Hybrid: Local Control, Cloud Execution

Hybrid keeps the OpenPond experience on your computer while moving the execution environment into an OpenPond sandbox. You continue the conversation in the local app, keep using the model or subscription you already selected, and approve sensitive actions from the same place. The sandbox handles the file operations, shell commands, dependency installs, and long-running work.

That split is useful when a job needs a clean environment, different dependencies, more time, or cloud compute, but you still want the local app to remain the control center.

## What Stays Local

Your local app keeps the conversation, model and provider selection, approval policy, subagent placement, and review experience. Local provider credentials stay on your machine instead of being copied into the sandbox.

The sandbox receives the source and scoped capabilities needed for the run. Integrations should be provided through explicit OpenPond connections rather than by placing raw API keys, OAuth tokens, cookies, or session secrets in the repository.

## What Runs in the Sandbox

The agent can read and write the sandbox workspace, run commands, install dependencies, use hosted actions, and run longer-lived commands in a remote environment. This gives the work a clean execution boundary without forcing you to change the model path driving the conversation.

Sandbox changes remain remote while the work is in progress. They do not silently modify your local checkout.

## Reviewing and Bringing Work Back

Hybrid keeps the handoff explicit:

1. Start from the project and conversation in your local app.
2. Select Hybrid as the place where the work should run.
3. Let the agent work inside the isolated sandbox.
4. Review the resulting file changes and execution evidence.
5. Export, apply, preserve, or merge only the work you want to keep.

Git-backed source references make that review durable. You can see what changed, preserve a useful sandbox result, and decide when it is ready to become part of the project.

## Accounts and Connections

Hybrid uses OpenPond Cloud resources, so it requires an OpenPond account. If the work needs Google Drive, Slack, GitHub, or another external service, authorize it through [OpenPond Connect](openpond-connect.md) so the sandbox receives scoped access rather than your raw credentials.

## Related Guides

- [OpenPond Cloud](cloud.md)
- [OpenPond Git](openpond-git.md)
- [OpenPond Connect](openpond-connect.md)
