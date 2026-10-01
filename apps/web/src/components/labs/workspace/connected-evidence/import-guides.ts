export const agentImportGuides = {
  codex: { name: "Codex", instruction: "On the machine running Codex, finish the turn and select its rollout file from ~/.codex/sessions/. A configured Codex home changes this location. Archived rollout files can be selected separately.",
    fileType: "rollout-*.jsonl or .jsonl.zst", command: "~/.codex/sessions/", url: "https://github.com/openai/codex/blob/main/codex-rs/rollout/src/lib.rs" },
  claude_code: { name: "Claude Code", instruction: "Finish the turn and select the structured transcript from the matching project folder. /export produces readable text and is not this structured transcript. Select related child transcripts explicitly; preview reports missing context.",
    fileType: "<session-id>.jsonl", command: "~/.claude/projects/<project>/", url: "https://code.claude.com/docs/en/sessions#export-and-locate-session-data" },
  hermes: { name: "Hermes", instruction: "Find the session with hermes sessions list, export the full session, and select the resulting file. Run the command on the machine or container holding the session.",
    fileType: "Full-session JSONL export", command: "hermes sessions export session.jsonl --session-id <session-id> --redact", url: "https://hermes-agent.nousresearch.com/docs/user-guide/sessions/" },
  openclaw: { name: "OpenClaw", instruction: "Run /export-trajectory in the selected session and complete OpenClaw's export approval. Select the generated folder in the agent workspace; keep relative filenames together.",
    fileType: "Bundle containing manifest.json, events.jsonl and session-branch.json", command: "/export-trajectory\n.openclaw/trajectory-exports/", url: "https://docs.openclaw.ai/tools/trajectory" },
} as const;
