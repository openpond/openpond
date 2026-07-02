# Runtime vibecode platform example

This example shows how a platform developer can use OpenPond sandboxes as the runtime behind a vibecoding product. The platform keeps its own chat and product UI, then uses the SDK to create or attach a runtime, write files into the sandbox, run commands, checkpoint work, and wait for the next user prompt.

Run it with an API key:

```bash
OPENPOND_API_KEY=opk_... bun run examples/runtime-vibecode-platform/vibecode-platform-example.ts "build a tiny status endpoint"
```

Useful environment variables:

```bash
OPENPOND_SANDBOX_API_URL=https://api.staging-api.openpond.ai
OPENPOND_TEAM_ID=team_...
OPENPOND_APP_ID=app_...
OPENPOND_BASE_BRANCH=main
```

If `OPENPOND_APP_ID` is set, the example starts an app-backed `feature` runtime. If it is omitted, the example creates a generic `attempt` runtime and materializes a sandbox directly. In both cases the platform code uses the same runtime handle after startup.

