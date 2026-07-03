# Continuous Insights

The Continuous Insights Agent watches OpenPond work over time so useful follow-ups do not disappear inside chat history.

It is designed to surface:

- Repeated errors and blocked runs.
- Open follow-ups from chats and goals.
- Patterns across recent agent activity.
- Work that may need a retry, cleanup, or handoff.

## Local First

Insights can run against local OpenPond activity without making login a prerequisite for the desktop app. Cloud-backed projects and Sandboxes can add hosted run context when the user chooses to sign in.

## Evidence Based

Insights should point back to the run, chat, goal, file, artifact, or error that created the signal. The goal is not another notification stream; it is a reviewable layer over actual agent work.

## Common Uses

- Find failed or stale agent runs.
- Summarize active issues across chats.
- Track recurring errors while developing an agent.
- Reopen useful work that was left unfinished.
- Ask questions about recent OpenPond activity.
