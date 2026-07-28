# Integrations and Setup

External systems must be explicit.

- Declare connection and setup requirements instead of reading arbitrary environment state during module import.
- Never write credentials, tokens, cookies, private keys, or copied environment values into source.
- Keep provider-specific event normalization in channel adapters; route normalized natural language to `chat`.
- Use direct actions for explicit UI or API operations.
- Bound network effects and require the declared approval policy for consequential writes.
- Make missing setup actionable through clear requirement labels and errors.
- Cover integration-independent behavior with deterministic evals; use connected or live checks only when authorization and fixtures exist.

If the request does not require an integration, do not add one speculatively.
