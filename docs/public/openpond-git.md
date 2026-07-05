# OpenPond Git

OpenPond Git is the source-control layer behind durable OpenPond agents. It keeps agent work backed by commits instead of hidden chat state, so generated agents, edits, cloud runs, and promotions can be reviewed and moved like normal code.

OpenPond Git is not a replacement for local Git. It is the hosted source boundary OpenPond uses when you want cloud sync, OpenPond Cloud execution, cross-device continuity, or managed preview and production workflows.

## What It Provides

- Git-backed ownership for agents created from chat.
- Managed local checkouts for OpenPond projects.
- A hosted OpenPond remote for cloud-backed source.
- Explicit commit, push, preserve, promote, and merge boundaries.
- A shared source reference between the desktop app, CLI, TUI, Agent SDK, and OpenPond Cloud.

## Source Modes

OpenPond can work with source in a few modes:

| Mode | Use when |
| --- | --- |
| OpenPond Git | You want OpenPond-managed hosted source, cloud sync, and OpenPond Cloud handoff. |
| GitHub | Your repo already lives on GitHub and OpenPond should deploy or work from that connected repo. |
| Local project | You want to work in an existing folder without cloud sync or hosted source. |

Local project mode does not require login. OpenPond Git requires an OpenPond account because it creates hosted source and cloud records.

## How It Works

1. You create or open a local project.
2. OpenPond detects the Git root when one exists.
3. Agent work creates or updates source files, not just chat transcript state.
4. You review file changes and commit them.
5. When using OpenPond Git, pushes go to the hosted OpenPond remote.
6. OpenPond Cloud can run, preserve, or promote source from that committed state.

The commit is the durable handoff point. Chat can propose and apply changes, but Git records what actually changed.

## Managed Workspaces

For OpenPond-hosted projects, the desktop app can maintain a managed local checkout. That checkout is where local chat, file tools, terminal work, Codex, and BYOK providers operate.

The app should keep transcripts, runtime events, logs, and local metadata outside the repo so they are not committed by accident. Agent source, manifest files, evals, fixtures, and generated artifacts that belong to the agent can live in Git.

## Cloud Handoff

OpenPond Cloud uses Git-backed source refs to keep hosted work reviewable.

- Preserve saves useful hosted changes into a durable source ref.
- Promote applies a reviewed source ref to the project branch or live workflow.
- Export or merge lets you bring cloud work back into the local repo.

This keeps cloud execution from becoming an invisible fork of the project.

## What Should Not Go In Git

Do not commit:

- Raw API keys, OAuth tokens, cookies, or session secrets.
- Local app state, chat transcripts, or event logs.
- Cloud credential bindings or integration lease ids.
- Temporary runtime logs and generated caches that are not part of the agent contract.

Agent source should declare what it needs. Local settings and OpenPond Cloud bindings provide the actual credentials.

## Why It Matters

OpenPond Git is what makes chat-built agents durable. A good agent should survive outside the conversation that created it: checked into source, validated, evaluated, run locally, handed to the cloud, and reviewed before promotion.
