import { createOpenPondSandboxClient } from "openpond";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const apiKey = requireEnv("OPENPOND_API_KEY");
const sandboxApiUrl =
  optionalEnv("OPENPOND_SANDBOX_API_URL") ?? optionalEnv("OPENPOND_API_URL");
const appId = optionalEnv("OPENPOND_APP_ID");
const teamId = optionalEnv("OPENPOND_TEAM_ID");
const baseBranch = optionalEnv("OPENPOND_BASE_BRANCH") ?? "main";
const userPrompt =
  process.argv.slice(2).join(" ").trim() ||
  "Create a tiny Node HTTP server with a status endpoint.";
const runId = `vibecode-${Date.now()}`;

const client = createOpenPondSandboxClient({
  apiKey,
  ...(sandboxApiUrl ? { sandboxApiUrl } : {}),
});

const sandboxInput = {
  ...(teamId ? { teamId } : {}),
  command: "sleep infinity",
  resources: {
    cpu: 2,
    memoryGb: 4,
    diskGb: 20,
  },
  budget: {
    maxUsd: "0.25",
  },
  metadata: {
    source: "runtime-vibecode-platform-example",
    runId,
  },
};

async function startRuntime() {
  if (appId) {
    return client.apps(appId).start({
      mode: "feature",
      baseBranch,
      metadata: {
        source: "runtime-vibecode-platform-example",
        userPrompt,
        runId,
      },
      sandbox: sandboxInput,
    });
  }

  const runtime = await client.runtimes.create({
    ...(teamId ? { teamId } : {}),
    mode: "attempt",
    metadata: {
      source: "runtime-vibecode-platform-example",
      userPrompt,
      runId,
    },
  });
  const handle = client.runtimes.handle(runtime.id, runtime);
  await handle.createSandbox(sandboxInput);
  return handle;
}

async function main() {
  const runtime = await startRuntime();

  await runtime.files.write(
    "package.json",
    JSON.stringify(
      {
        type: "module",
        scripts: {
          start: "node src/server.mjs",
        },
        dependencies: {},
      },
      null,
      2,
    ),
  );

  await runtime.files.write(
    "src/server.mjs",
    [
      "import { createServer } from 'node:http';",
      "",
      "const port = Number(process.env.PORT ?? 3000);",
      "const server = createServer((request, response) => {",
      "  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);",
      "  if (url.pathname === '/status') {",
      "    response.setHeader('content-type', 'application/json');",
      "    response.end(JSON.stringify({ ok: true, prompt: process.env.USER_PROMPT ?? null }));",
      "    return;",
      "  }",
      "  response.end('OpenPond vibecode example');",
      "});",
      "",
      "server.listen(port, '0.0.0.0', () => console.log(`listening on http://0.0.0.0:${port}`));",
      "",
    ].join("\n"),
  );

  await runtime.files.write(
    "README.generated.md",
    `# Generated app\n\nPrompt: ${userPrompt}\n\nRun with:\n\n\`\`\`bash\nnpm run start\n\`\`\`\n`,
  );

  const readBack = await runtime.files.read("src/server.mjs");
  const command = await runtime.commands.run({
    command:
      "printf 'runtime files:\\n' && find . -maxdepth 2 -type f | sort && printf '\\nserver preview:\\n' && sed -n '1,80p' src/server.mjs",
    timeoutSeconds: 20,
  });

  await runtime.checkpointHint({
    reason: "vibecode_platform_example_generated_files",
    artifactRefs: ["package.json", "src/server.mjs", "README.generated.md"],
    metadata: {
      userPrompt,
      runId,
    },
  });

  const waiting = await runtime.waitForUser({
    reason: "ready_for_next_vibecode_prompt",
    summary: "Generated files are ready for the next user prompt.",
    payload: {
      userPrompt,
      runId,
    },
  });

  console.log(
    JSON.stringify(
      {
        runtimeId: runtime.id,
        sandboxId: (await runtime.get()).sandboxId,
        status: waiting.status,
        generatedServerBytes: readBack.length,
        commandStatus: command.command.status,
        commandExitCode: command.command.exitCode,
        commandOutput: command.command.output,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
