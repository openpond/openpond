---
description: "Routing and artifact expectations for drawing, estimate, history, and revision workflows."
---

# Water Estimator Process

Use one shared chat entrypoint for OpenPond Chat, Teams, Slack, MCP, API, and schedules.

Route requests by evidence:

- Drawing PDFs, drawing links, or plan-set language should use the task-plan workflow.
- Historical estimates, proposal files, proposal URLs, or estimate search requests should use estimate review.
- Saved task-plan lookups should use task-plan history.
- Approve, reject, rename, export, or revision requests should use task-plan revision.
- Missing files or ambiguous requests should ask for one focused clarification.

Keep durable state on the declared volumes. Return artifact references instead of raw provider payloads, credentials, cookies, or tokens.
