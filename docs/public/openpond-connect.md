# OpenPond Connect

OpenPond Connect is the website-based flow for connecting OAuth providers and third-party services to OpenPond.

Use OpenPond Connect when an agent needs access to external systems such as Google Drive, Twitter/X, Slack, docs, calendars, or other provider-backed APIs. The connection is created through the OpenPond website, then made available to local or cloud workflows as an authorized capability.

## What It Does

- Connects third-party providers through OpenPond-managed OAuth or provider setup.
- Stores provider authorization outside agent source code.
- Exposes connection status and capabilities to OpenPond workflows.
- Lets agents request provider access without committing raw tokens.
- Supports local and OpenPond Cloud use when the connection is available to that environment.

## How It Works

1. You open the OpenPond website.
2. You choose the provider to connect.
3. You authorize the provider through its normal OAuth or account flow.
4. OpenPond stores the resulting connection as a managed provider binding.
5. Local or cloud workflows can reference that connection by capability, not by raw secret value.

Agent source should declare what it needs. OpenPond Connect supplies the authorized provider binding.

## Examples

- A research agent reads selected Google Drive documents.
- A social agent drafts or schedules Twitter/X work.
- A support agent reads Slack context.
- A reporting agent uses connected docs, sheets, or calendar data.

The exact providers available depend on the OpenPond environment and enabled connectors.

## Source Boundary

Commit declarations, not credentials.

Good source-owned declarations:

- "This agent needs Google Drive access."
- "This workflow needs a connected Twitter/X account."
- "This action needs Slack context."

OpenPond Connect owns:

- OAuth grants.
- Provider account bindings.
- Connection refresh.
- Redacted connection status.
- Provider-specific authorization details.

Raw provider tokens, cookies, and OAuth payloads should not be committed to Git, written into agent source, or surfaced in chat output.
