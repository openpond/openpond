import { defineSkill } from "openpond-agent-sdk/skills";

export default defineSkill({
  name: "reply-style",
  description: "Support reply tone, structure, and length guidance.",
  markdown: [
    "Use a direct opening sentence.",
    "Answer the customer's actual question before adding context.",
    "Close with one concrete next step when useful.",
  ].join("\n"),
  files: {
    "references/tone.md": [
      "# Reply Tone",
      "",
      "- Clear over clever.",
      "- Specific over generic.",
      "- One next step is usually enough.",
    ].join("\n"),
  },
});
