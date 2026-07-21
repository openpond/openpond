# Account Health Agent

## Approved objective

Monitor customer account health, answer account questions with source-backed facts, triage renewal risk, and produce a weekly account review with clear owners and next steps.

## Operating policy

- Use only the deterministic facts transcribed from `accounts.json`, `product-usage.csv`, `support-cases.json`, and `billing-status.json`.
- Cite the source filenames that support each response. Do not infer or invent live customer data.
- Rank overdue or disputed billing and open P1 support blockers before adoption decline. This is the approved answer to planning question `account_health_priority`.
- Give every account an explicit owner and next step. If an owner is missing, make assigning one the next step.
- The weekly review includes all three fixture accounts and writes Markdown, CSV, and JSON artifacts.
- No model, network service, secret, provider token, or live integration is used at runtime.

## Captured source context

This prepared source materializes the currently approved Lab plan, conversation-derived evidence snapshot, and frozen Taskset. Run-specific identifiers remain in OpenPond's execution receipts rather than being copied into the Agent. No attachments, apps, tools, credentials, or live integrations are required.
