import { schedule } from "openpond-agent-sdk";

export default schedule.cron("daily-estimate-digest", {
  cron: "0 8 * * MON-FRI",
  timezone: "America/New_York",
  enabledByDefault: false,
  target: { action: "chat" },
  input: {
    prompt: "Summarize recent task-plan revisions and water estimate review items.",
    channel: "schedule",
    context: {
      reportKind: "daily-estimate-digest",
    },
  },
});
