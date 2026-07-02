# Examples

These examples use the published `openpond` package. Make sure
`OPENPOND_API_KEY` is set before running them.

- `runtime-vibecode-platform/` shows an app or generic runtime driving a
  vibecoding flow with file writes, command execution, checkpoint hints, and
  wait-for-user state.
- `sandbox-templates/deepseek-streaming-wait-for-user/` is a DeepSeek V4 Flash
  chat-agent sandbox template that streams a response, writes workflow events,
  waits for user input, and emits a checkpoint hint when no reply arrives.
