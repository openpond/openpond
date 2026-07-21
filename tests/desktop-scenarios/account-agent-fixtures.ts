import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  waitForAssistantOutput,
  waitForCompletedTurn,
} from "./helpers";

const execFileAsync = promisify(execFile);

export const ACCOUNT_AGENT_PURPOSE =
  "Monitor customer account health, answer account questions with source-backed facts, triage renewal risk, and produce a weekly account review with clear owners and next steps.";

export const ACCOUNT_AGENT_IMPROVEMENT =
  "For high-risk accounts, always rank overdue or disputed billing and open P1 support blockers before adoption decline, while preserving source citations and all existing actions.";

export const ACCOUNT_CHAT_FIXTURES = [
  {
    title: "Account Health · Acme renewal review",
    prompt:
      "Summarize Acme: renewal 21 days, seats -31%, invoice dispute 19 days overdue, P1 open.",
    expected:
      "Acme is high risk. Renewal is in 21 days; active seats are down 31%; a disputed invoice is 19 days overdue; and a P1 support case is open. Resolve the billing dispute and P1 first. Owner: Revenue Operations with Support.",
  },
  {
    title: "Account Health · Northstar expansion review",
    prompt:
      "Summarize Northstar: renewal 87 days, seats +18%, no overdue balance, requested 25 seats.",
    expected:
      "Northstar is an expansion opportunity. Renewal is in 87 days, active seats are up 18%, there is no overdue balance, and the customer requested 25 additional seats. Owner: Account Executive for expansion follow-up.",
  },
  {
    title: "Account Health · weekly review format",
    prompt:
      "Weekly review format for Glacier: renewal 43 days, usage flat, no P1, owner missing. Include risk, sources, owner, and next step.",
    expected:
      "Glacier is medium risk. Renewal is in 43 days, usage is flat, there is no P1 support case, and the account owner is missing. Assign an owner before the weekly review.",
  },
] as const;

export const ACCOUNT_CORRECTION_CHAT = {
  title: "Account Health · risk-priority correction",
  prompt:
    "Correction: for high-risk accounts, billing and P1 must be ranked before adoption decline, with source citations.",
  expected:
    "For high-risk accounts, rank overdue or disputed billing and open P1 support blockers before adoption decline, while citing each supporting source.",
} as const;

export async function createAccountEvidenceChat(
  harness: DesktopHarness,
  fixture: { title: string; prompt: string; expected: string },
) {
  const modelRef = {
    providerId: "openpond" as const,
    modelId: "openpond-scripted-chat-two-turns",
  };
  const session = await harness.api.createSession<{
    id: string;
  }>({
    provider: "openpond",
    modelRef,
    title: fixture.title,
    cwd: harness.repoRoot,
  });
  await harness.api.createTurn(session.id, { prompt: fixture.prompt, modelRef });
  const delta = await waitForAssistantOutput(
    harness,
    session.id,
    fixture.expected,
    `${fixture.title} evidence response`,
  );
  await waitForCompletedTurn(harness, session.id, delta, `${fixture.title} completion`);
  return session;
}

export async function seedAccountHealthProfile(
  harness: DesktopHarness,
  repoPath = path.join(harness.artifactsDir, "profile-repo"),
): Promise<void> {
  const inputDir = path.join(repoPath, "account-health-inputs");
  const preparedTemplateDir = path.join(repoPath, "account-health-agent-template");
  await mkdir(inputDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(inputDir, "accounts.json"),
      `${JSON.stringify({
        asOfDate: "2026-07-20",
        accounts: [
          { id: "acme", name: "Acme", renewalDays: 21, owner: "Revenue Operations" },
          { id: "northstar", name: "Northstar", renewalDays: 87, owner: "Account Executive" },
          { id: "glacier", name: "Glacier", renewalDays: 43, owner: null },
        ],
      }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(inputDir, "product-usage.csv"),
      [
        "accountId,activeSeatChange,usageTrend,seatRequest",
        "acme,-31%,declining,0",
        "northstar,+18%,growing,25",
        "glacier,0%,flat,0",
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      path.join(inputDir, "support-cases.json"),
      `${JSON.stringify({
        cases: [
          { accountId: "acme", priority: "P1", status: "open", owner: "Support" },
          { accountId: "northstar", priority: "P3", status: "resolved" },
          { accountId: "glacier", priority: "P2", status: "resolved" },
        ],
      }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(inputDir, "billing-status.json"),
      `${JSON.stringify({
        accounts: [
          { accountId: "acme", disputed: true, overdueDays: 19 },
          { accountId: "northstar", disputed: false, overdueDays: 0 },
          { accountId: "glacier", disputed: false, overdueDays: 0 },
        ],
      }, null, 2)}\n`,
      "utf8",
    ),
  ]);

  const dependency = JSON.parse(
    await readFile(path.join(repoPath, "profiles", "default", "package.json"), "utf8"),
  ).dependencies?.["openpond-agent-sdk"];
  if (typeof dependency !== "string" || !dependency) {
    throw new Error("The initialized profile did not expose the local Agent SDK dependency.");
  }
  await seedPreparedAgentTemplates({
    dependency,
    harness,
    targetDir: preparedTemplateDir,
  });
  await writeFile(
    path.join(repoPath, "ACCOUNT_HEALTH_AGENT_BLUEPRINT.md"),
    accountAgentBlueprint(dependency),
    "utf8",
  );
  await writeFile(
    path.join(repoPath, "AGENTS.md"),
    [
      "# Account Health tutorial fixture",
      "",
      "When an approved Create or Improve run targets `account-health-agent`, follow `ACCOUNT_HEALTH_AGENT_BLUEPRINT.md` exactly.",
      "The checked-in files in `account-health-inputs/` are the source facts. Prepared, validated SDK projects live in `account-health-agent-template/base/` and `account-health-agent-template/improved/`.",
      "For a Create run, copy `account-health-agent-template/base/.` into `profiles/default/agents/account-health-agent/`. For an Improve run about billing/P1 priority, copy `account-health-agent-template/improved/.` over that same Agent directory.",
      "Copy `account-health-agent-template/registration/openpond-profile.json` to the repository root and `account-health-agent-template/registration/profile.yaml` to `profiles/default/settings/profile.yaml`.",
      "Do not redesign the prepared source or inspect unrelated SDK examples. Confirm the four public actions, then run inspect, build, validate, eval, and the default chat action.",
      "Do not edit the default Agent. Run inspect, build, validate, eval, and the default chat action before finishing.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(repoPath, ".openpond-harness-source-application.json"),
    `${JSON.stringify({
      schema: "openpond.harnessPreparedSource.v1",
      agents: {
        "account-health-agent": {
          create: preparedSourceOperation("base"),
          improve: preparedSourceOperation("improved"),
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await execFileAsync("git", ["add", "AGENTS.md", "ACCOUNT_HEALTH_AGENT_BLUEPRINT.md", ".openpond-harness-source-application.json", "account-health-inputs", "account-health-agent-template"], {
    cwd: repoPath,
  });
  try {
    await execFileAsync("git", [
      "-c", "user.name=OpenPond Harness",
      "-c", "user.email=harness@openpond.local",
      "commit", "-m", "Add Account Health tutorial fixtures",
    ], { cwd: repoPath });
  } catch (error) {
    const staged = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: repoPath });
    if (staged.stdout.trim()) throw error;
  }
}

function preparedSourceOperation(variant: "base" | "improved") {
  return {
    source: `account-health-agent-template/${variant}`,
    registrations: [
      {
        source: "account-health-agent-template/registration/openpond-profile.json",
        target: "openpond-profile.json",
      },
      {
        source: "account-health-agent-template/registration/profile.yaml",
        target: "profiles/default/settings/profile.yaml",
      },
    ],
  };
}

async function seedPreparedAgentTemplates(input: {
  dependency: string;
  harness: DesktopHarness;
  targetDir: string;
}): Promise<void> {
  const sourceDir = path.join(
    input.harness.repoRoot,
    "tests",
    "desktop-scenarios",
    "fixtures",
    "account-health-agent",
    "base",
  );
  const baseDir = path.join(input.targetDir, "base");
  const improvedDir = path.join(input.targetDir, "improved");
  const registrationDir = path.join(input.targetDir, "registration");
  await cp(sourceDir, baseDir, { recursive: true, force: true });
  await writeFile(path.join(baseDir, "package.json"), preparedAgentPackage(input.dependency, "0.1.0"), "utf8");
  await cp(baseDir, improvedDir, { recursive: true, force: true });
  await writeFile(path.join(improvedDir, "package.json"), preparedAgentPackage(input.dependency, "0.2.0"), "utf8");

  const improvedFixturesPath = path.join(improvedDir, "src", "fixtures.ts");
  const improvedFixtures = await readFile(improvedFixturesPath, "utf8");
  await writeFile(
    improvedFixturesPath,
    improvedFixtures.replace(
      '"Acme is high risk.',
      '"Billing/P1 priority comes first. Acme is high risk.',
    ),
    "utf8",
  );
  const improvedRuntimePath = path.join(improvedDir, "src", "account-health.ts");
  const improvedRuntime = await readFile(improvedRuntimePath, "utf8");
  const promptMarker = '  const prompt = String(input.prompt ?? "").trim();\n';
  if (!improvedRuntime.includes(promptMarker)) {
    throw new Error("The prepared Account Health Agent chat runtime could not be extended.");
  }
  await writeFile(
    improvedRuntimePath,
    improvedRuntime.replace(
      promptMarker,
      `${promptMarker}
  if (/^Correction:\\s*for high-risk accounts,/i.test(prompt)) {
    ctx.trace.event("account-health.priority-policy-corrected", {
      priority: "billing-and-p1-before-adoption",
    });
    return {
      text: "For high-risk accounts, rank overdue or disputed billing and open P1 support blockers before adoption decline, while citing each supporting source.",
      intent: "account-health-chat",
      metadata: {
        approvedObjective: approvedSourceContext.objective,
        sources: [...sourceFiles],
        evidenceSnapshotId: approvedSourceContext.evidenceSnapshotId,
      },
    };
  }
`,
    ),
    "utf8",
  );
  const improvedAgentPath = path.join(improvedDir, "agent", "agent.ts");
  const improvedAgent = await readFile(improvedAgentPath, "utf8");
  const evalsEnd = improvedAgent.lastIndexOf("  ],\n});");
  if (evalsEnd < 0) throw new Error("The prepared Account Health Agent eval list could not be extended.");
  const regressionEval = `    defineEval({
      name: "billing-p1-priority-regression",
      description: "High-risk correction prompts keep billing and open P1 blockers ahead of adoption decline.",
      publishGate: true,
      async run(t) {
        await t.send({
          prompt: "Correction: rank Acme risks with sources.",
          channel: "openpond_chat",
        });
        t.expectIntent("account-health-chat");
        t.expectTextIncludes("Billing/P1 priority comes first");
        t.expectTextIncludes("billing-status.json");
        t.expectTextIncludes("support-cases.json");
      },
    }),
`;
  await writeFile(
    improvedAgentPath,
    `${improvedAgent.slice(0, evalsEnd)}${regressionEval}${improvedAgent.slice(evalsEnd)}`,
    "utf8",
  );

  await mkdir(registrationDir, { recursive: true });
  await writeFile(
    path.join(registrationDir, "openpond-profile.json"),
    `${JSON.stringify({
      schema: "openpond.profileRepo.v1",
      defaultProfile: "default",
      profiles: {
        default: {
          path: "profiles/default",
          defaultAgent: "default",
          enabledAgents: ["default", "account-health-agent"],
          agentNames: { "account-health-agent": "Account Health Agent" },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(registrationDir, "profile.yaml"),
    [
      "schema: openpond.profile.v1",
      "profile: default",
      "agents:",
      "  - id: default",
      "    path: agent/agent.ts",
      "    enabled: true",
      "  - id: account-health-agent",
      "    path: agents/account-health-agent",
      "    name: Account Health Agent",
      "    displayName: Account Health Agent",
      "    enabled: true",
      "",
    ].join("\n"),
    "utf8",
  );
}

function preparedAgentPackage(dependency: string, version: string): string {
  return `${JSON.stringify({
    name: "openpond-account-health-agent",
    version,
    private: true,
    packageManager: "pnpm@11.13.0",
    type: "module",
    dependencies: { "openpond-agent-sdk": dependency },
    scripts: {
      "agent:inspect": "openpond-agent inspect --json",
      "agent:build": "openpond-agent build",
      "agent:validate": "openpond-agent validate",
      "agent:eval": "openpond-agent eval",
      "agent:check": "openpond-agent eval --json",
    },
  }, null, 2)}\n`;
}

function accountAgentBlueprint(sdkDependency: string): string {
  return `# Account Health Agent blueprint

Create the SDK project at \`profiles/default/agents/account-health-agent\`. Register and enable \`account-health-agent\` in both root and profile manifests with display name \`Account Health Agent\`.

The public catalog must contain exactly these actions:

- \`chat\` (default), channel \`openpond_chat\`, input \`{ prompt, channel: "openpond_chat" }\`.
- \`summarize-account\`, end-user visible, input schema \`{ accountId }\`.
- \`triage-renewal-risk\`, end-user visible, input schema \`{ accountId, asOfDate }\`.
- \`build-weekly-account-review\`, end-user visible, input schema \`{ asOfDate, minimumRisk }\`, with Markdown, CSV, and JSON artifact refs.

Use this package manifest, preserving the SDK dependency exactly:

\`\`\`json
${JSON.stringify({
    name: "openpond-account-health-agent",
    version: "0.1.0",
    private: true,
    packageManager: "pnpm@11.13.0",
    type: "module",
    dependencies: { "openpond-agent-sdk": sdkDependency },
    scripts: {
      "agent:inspect": "openpond-agent inspect --json",
      "agent:build": "openpond-agent build",
      "agent:validate": "openpond-agent validate",
      "agent:eval": "openpond-agent eval",
      "agent:check": "openpond-agent eval --json",
    },
  }, null, 2)}
\`\`\`

Implement deterministic fixture-backed behavior with the exact facts in \`account-health-inputs/\`. It is acceptable to commit equivalent typed constants under the generated Agent because the source inputs remain the audit evidence.

Required outputs:

- Acme: \`Acme is high risk. Renewal is in 21 days; active seats are down 31%; a disputed invoice is 19 days overdue; and a P1 support case is open. Resolve the billing dispute and P1 first. Owner: Revenue Operations with Support. Sources: accounts.json, product-usage.csv, support-cases.json, billing-status.json.\`
- Northstar: \`Northstar is an expansion opportunity. Renewal is in 87 days, active seats are up 18%, there is no overdue balance, and the customer requested 25 additional seats. Owner: Account Executive for expansion follow-up. Sources: accounts.json, product-usage.csv, billing-status.json.\`
- Glacier: \`Glacier is medium risk. Renewal is in 43 days, usage is flat, there is no P1 support case, and the account owner is missing. Assign an owner before the weekly review. Sources: accounts.json, product-usage.csv, support-cases.json.\`
- A follow-up asking what to do first must put Acme billing dispute and P1 support first.
- The weekly review must include all three accounts, explicit owners and next steps, and return \`artifactRefs: ["artifacts/weekly-account-review.md", "artifacts/weekly-account-review.csv", "artifacts/weekly-account-review.json"]\` after tracing all three artifacts.

Normalize account ids from either direct input properties or a JSON/plain-text \`prompt\`, so both the API and the OpenPond composer work. Public actions need labels, descriptions, 30-second timeouts, schema names backed by project \`inputSchemas\`, output artifact policies, and no unresolved setup requirements.

Define deterministic publish-gate SDK evals for Acme chat, Northstar summary, Acme renewal triage, and weekly artifacts. On an Improve run whose goal mentions billing/P1 priority, add a regression eval whose input begins with \`Correction:\` and whose expected output includes \`Billing/P1 priority comes first\`; make both chat and triage outputs include that sentence while preserving every existing fact, source citation, action, and artifact.

Keep \`editable.allowedPaths\` scoped to \`agent/**\`, \`src/**\`, and \`package.json\`. Do not call a model or network service at runtime.
`;
}
