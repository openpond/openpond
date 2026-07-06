import {
  OPENPOND_MANIFEST_FILE_NAME,
  SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME,
} from "../sandbox-template/manifest";

export function printHelp(): void {
  console.log("OpenPond CLI (API key only)");
  console.log("");
  console.log("Usage:");
  console.log("  openpond --version");
  console.log("  openpond --check-update");
  console.log("  openpond serve [--host <host>] [--port <port>]");
  console.log("  openpond ui [--host <host>] [--port <port>] [--web-root <dir>]");
  console.log("  openpond --tui");
  console.log("  openpond tui|interactive");
  console.log("  openpond chat [--model <model>] [--cwd <dir>] [--project <id>]");
  console.log(
    "  openpond chat (--message-file <path>|--message <text>|--stdin) --non-interactive [--yes] [--approval-policy <policy>] [--json] [--timeout-sec <n>] [--max-output-bytes <n>] [--sandbox <mode>]"
  );
  console.log("  openpond init [--path <dir>] [--profile default] [--template blank-agent] [--force]");
  console.log("  openpond profile current [--json]");
  console.log("  openpond profile load --path <dir> [--profile <name>]");
  console.log("  openpond profile hosted --team-id <id> [--json]");
  console.log("  openpond profile ensure-hosted --team-id <id> [--env staging] [--json]");
  console.log("  openpond profile check [--kind inspect|build|validate|eval|all]");
  console.log("  openpond profile push --team-id <id> [--hosted-source-checks] [--hosted-source-dispatch request_only|coding_core] [--publish-hosted-source] [--hosted-source-agent-id <id>|--hosted-run-agent-id <id>] [--hosted-source-project-id <id>] [--hosted-run-target-project-id <projectId>] [--hosted-run-input <json>] [--hosted-run-conversation-id <id>] [--hosted-run-retry|--hosted-run-idempotency-key <key>]");
  console.log("  openpond agents list [--json]");
  console.log("  openpond inspect|build|validate|eval [--json]");
  console.log("  openpond run <action> [--input <json>] [--json]");
  console.log('  openpond extend "<profile capability change>" [--run]');
  console.log('  openpond edit "<profile agent change>" [--agent-id <id>] [--run]');
  console.log("  openpond login [--api-key <key>]");
  console.log("  openpond profiles list");
  console.log("  openpond profiles use <name>");
  console.log(
    "  openpond profiles save <name> --api-key <key> [--base-url <url>] [--api-base-url <url>] [--chat-api-base-url <url>]"
  );
  console.log("  openpond account");
  console.log("  openpond health");
  console.log("  openpond tool list <handle>/<repo>");
  console.log(
    "  openpond tool run <handle>/<repo> <tool> [--body <json>] [--method <METHOD>]"
  );
  console.log(
    "  openpond backtest run <handle>/<repo> <tool> [--body <json>] [--branch <branch>] [--deployment-id <id>]"
  );
  console.log(
    "  openpond backtest events <handle>/<repo> [--run-id <id>] [--source <source>] [--status <csv>] [--symbol <symbol>] [--wallet-address <0x...>] [--since <ms|iso>] [--until <ms|iso>] [--limit <n>] [--cursor <cursor>] [--params <json>]"
  );
  console.log("  openpond backtest get <handle>/<repo> --run-id <id>");
  console.log("  openpond deploy watch <handle>/<repo> [--branch <branch>]");
  console.log("  openpond template status <handle>/<repo>");
  console.log("  openpond template branches <handle>/<repo>");
  console.log(
    "  openpond template update <handle>/<repo> [--env preview|production]"
  );
  console.log(
    `  openpond sandbox-template validate [--file ${OPENPOND_MANIFEST_FILE_NAME}]`
  );
  console.log("  openpond sandbox-template print-schema");
  console.log(
    "  openpond sandbox-template scaffold [--path <dir>] [--name <name>]"
  );
  console.log(
    `  openpond sandbox-template build [--file ${OPENPOND_MANIFEST_FILE_NAME}] [--output dist/${SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME}]`
  );
  console.log(
    `  openpond sandbox-template run [--file ${OPENPOND_MANIFEST_FILE_NAME}|--build dist/${SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME}] [--target <name>|--action <name>|--service <name>]`
  );
  console.log(
    `  openpond sandbox-template dev [--file ${OPENPOND_MANIFEST_FILE_NAME}|--build dist/${SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME}] [--service <name>]`
  );
  console.log(
    `  openpond sandbox-template start [--file ${OPENPOND_MANIFEST_FILE_NAME}] [--env-ref NAME=openpond://secret/...] [--input-file name=path] [--input-files name=glob] [--target <name>|--action <name>|--service <name>] [--project-id <projectId>] [--agent-id <agentId>] [--workflow-mode <mode> --runtime-project-id <projectId>] [--enable-schedules [all|name,...]|--disable-schedules [all|name,...]] [--schedule-overrides <json>] [--commit] [--no-push]`
  );
  console.log(
    `  openpond sandbox-template action <sandboxId> <actionName> [--file ${OPENPOND_MANIFEST_FILE_NAME}]`
  );
  console.log(
    "  openpond repo create --name <name> [--team-id <id>] [--path <dir>] [--template <owner/repo|url>] [--template-branch <branch>] [--env <json>] [--empty|--opentool] [--sandbox] [--token] [--auto-schedule-migration <true|false>]"
  );
  console.log("  openpond repo push [--path <dir>] [--branch <branch>]");
  console.log("  openpond organizations list");
  console.log(
    "  openpond organizations create --name <name> [--slug <slug>] [--primary-contact-email <email>]"
  );
  console.log(
    "  openpond organizations update <slug> [--name <name>] [--status active|disabled|archived]"
  );
  console.log("  openpond organizations members <slug>");
  console.log(
    "  openpond organizations member-upsert <slug> --email <email> --role owner|admin|member"
  );
  console.log("  openpond organizations mcp-get <slug>");
  console.log(
    "  openpond organizations mcp-generate <slug> [--origin <url>] [--toolset <csv>]"
  );
  console.log("  openpond organizations mcp-rotate <slug>");
  console.log("  openpond organizations mcp-disable <slug>");
  console.log("  openpond organizations mcp-enable <slug>");
  console.log(
    "  openpond organizations mcp-probe <slug> [--origin <url>] [--tool <name>] [--arguments <json>] [--access-token <token>]"
  );
  console.log(
    "  openpond organizations mcp-authorize <slug> [--origin <url>] [--scope <csv|space>] [--tool <name>] [--arguments <json>] [--open]"
  );
  console.log("  openpond project list --team-id <id>");
  console.log(
    "  openpond project create --team-id <id> --name <name> [--source-type manual|github_repo|internal_repo|template] [--repo <url>] [--git-owner <owner> --git-repo <repo>] [--internal-repo-path <path>] [--template-repo-url <url>]"
  );
  console.log("  openpond project get <projectId> --team-id <id>");
  console.log(
    "  openpond project update <projectId> --team-id <id> [--name <name>] [--description <text>] [--default-branch <branch>]"
  );
  console.log("  openpond project sync <projectId> --team-id <id>");
  console.log(
    "  openpond project source-upload <projectId> --team-id <id> [--path <dir>] [--branch <branch>] [--commit-message <text>]"
  );
  console.log("  openpond project archive <projectId> --team-id <id>");
  console.log('  openpond goal "<objective>" [--cwd <path>] [--goal-storage global|workspace]');
  console.log("  openpond goal run --goal-id <id> [--cwd <path>] [--goal-storage global|workspace]");
  console.log('  openpond goal create-agent "<agent idea>" [--cwd <path>] [--goal-storage global|workspace]');
  console.log('  openpond goal update-agent "<agent change>" [--agent-id <id>] [--cwd <path>] [--goal-storage global|workspace]');
  console.log("  openpond goal plan <goal-id> [--json] [--cwd <path>] [--goal-storage global|workspace]");
  console.log(
    "  openpond goal answer <question-id> --choice <choice-id>|--answer <text> [--goal-id <id>] [--cwd <path>] [--goal-storage global|workspace]"
  );
  console.log("  openpond goal approve|reject|pause|resume|cancel <goal-id>");
  console.log("  openpond agent list --team-id <id>");
  console.log(
    "  openpond agent inspect|build|validate|eval|traces [--cwd <project>]"
  );
  console.log(
    "  openpond agent run <action> [--cwd <project>] [--input <json>]  # local SDK action"
  );
  console.log(
    "  openpond agent create --team-id <id> --project-id <id> --name <name> [--entrypoint-scope entire_manifest|action|service|schedule] [--entrypoint-name <name>] [--trigger-type manual|schedule|endpoint|background] [--workflow-mode <mode>]"
  );
  console.log(
    "  openpond agent update <agentId> --team-id <id> [--name <name>] [--trigger-type manual|schedule|endpoint|background] [--workflow-mode <mode>]"
  );
  console.log(
    "  openpond agent bind-source <agentId> --team-id <id> --source-mode latest_source|published_snapshot|auto [--published-snapshot-id <id>]"
  );
  console.log(
    "  openpond agent run <agentId> --team-id <id> [--conversation-id <id>] [--idempotency-key <key>] [--target-project-id <projectId>] [--input <json>] [--require-published-snapshot true]"
  );
  console.log(
    "  openpond agent run-test <agentId> --team-id <id> [--conversation-id <id>] [--target-project-id <projectId>] [--input <json>] [--allow-latest-source true]"
  );
  console.log(
    "  openpond agent source deploy-plan <agentId> --team-id <id>"
  );
  console.log(
    "  openpond agent source checks <agentId> --team-id <id> [--check-kind validate|eval|publish_review|all] [--source-check-dispatch request_only|coding_core] [--source-ref <ref>] [--base-sha <sha>]"
  );
  console.log(
    "  openpond agent source check-status <workItemId> --team-id <id> [--limit <n>]"
  );
  console.log(
    "  openpond agent source manifest-snapshots <agentId> --team-id <id> [--limit <n>]"
  );
  console.log(
    "  openpond agent source publish <agentId> --team-id <id> [--expected-manifest-hash <hash>] [--expected-source-commit-sha <sha>]"
  );
  console.log(
    "  openpond agent edit open <agentId> --team-id <id> --project-id <id> [--message <text>] [--source-ref <ref>] [--base-sha <sha>]"
  );
  console.log(
    "  openpond agent edit chat <workItemId> --team-id <id> --message <text> [--chat-mode queue_cloud|sync_cloud]"
  );
  console.log(
    "  openpond agent edit activity <workItemId> --team-id <id> [--limit <n>]"
  );
  console.log(
    "  openpond agent edit background <workItemId> --team-id <id> [--prompt <text>] [--agent-edit <json>]"
  );
  console.log(
    "  openpond agent edit request-checks <agentId> --team-id <id> [--check-kind validate|eval|publish_review|all]"
  );
  console.log(
    "  openpond agent edit check-status <workItemId> --team-id <id> [--limit <n>]"
  );
  console.log(
    "  openpond agent edit checkpoint-result|commit-result|pr-result <workItemId> --team-id <id> --ref <artifact-ref>"
  );
  console.log("  openpond agent archive <agentId> --team-id <id>");
  console.log("  openpond teams-bot overview --team-id <id>");
  console.log(
    "  openpond teams-bot rebind <bindingId> --team-id <id> [--project-id <id>] [--agent-id <id>] [--microsoft-connection-id <id>]"
  );
  console.log(
    "  openpond teams-bot diagnostic-run <bindingId> --team-id <id> --prompt <text> [--attachments-json <json-array>] [--action-input-json <json-object>]"
  );
  console.log(
    "  openpond sandbox list [--env staging] [--team-id <id>] [--project-id <id>] [--agent-id <id>] [--sandbox-api-url <url>]"
  );
  console.log(
    "  openpond sandbox mcp-config [--env staging] [--sandbox-api-url <url>]"
  );
  console.log("  openpond sandbox secrets [--team-id <id>] [--json]");
  console.log(
    "  openpond sandbox secret-create --name <ENV_NAME> [--team-id <id>] [--stdin]"
  );
  console.log(
    "  openpond sandbox secret-rotate <secretId> [--team-id <id>] [--stdin]"
  );
  console.log("  openpond sandbox secret-revoke <secretId> [--team-id <id>]");
  console.log("  openpond sandbox secret-delete <secretId> [--team-id <id>]");
  console.log(
    "  openpond sandbox secret-attach <secretId> --env-name <ENV_NAME> --target-type sandbox|project|agent|template|replay --target-id <id>"
  );
  console.log(
    "  openpond sandbox snapshots [--team-id <id>] [--project-id <id>] [--agent-id <id>]"
  );
  console.log(
    "  openpond sandbox published-snapshots [--team-id <id>] [--project-id <id>] [--query <text>] [--name <name>] [--use-case <id>]"
  );
  console.log("  openpond sandbox published-snapshot-builds --team-id <id>");
  console.log(
    "  openpond sandbox published-snapshot-build-create --team-id <id> [--source-repo-url <url>|--source-project-id <id>] [--branch <branch>] [--publish]"
  );
  console.log("  openpond sandbox published-snapshot-build-get <buildId>");
  console.log("  openpond sandbox published-snapshot-build-logs <buildId>");
  console.log("  openpond sandbox published-snapshot-build-cancel <buildId>");
  console.log(
    "  openpond sandbox published-snapshot-build-watch <buildId> [--interval-ms 5000] [--timeout-ms 900000]"
  );
  console.log(
    "  openpond sandbox replay-start --team-id <id> --snapshot-id <id> [--entrypoint <name>] [--params <json>] [--artifact-paths <csv>]"
  );
  console.log("  openpond sandbox replay-get <replayId> [--team-id <id>]");
  console.log("  openpond sandbox replay-logs <replayId> [--team-id <id>]");
  console.log("  openpond sandbox replay-cancel <replayId> [--team-id <id>]");
  console.log(
    "  openpond sandbox replay-watch <replayId> [--team-id <id>] [--interval-ms 5000] [--timeout-ms 900000]"
  );
  console.log(
    "  openpond sandbox replay-artifacts <replayId> [--team-id <id>]"
  );
  console.log(
    "  openpond sandbox runtime-list [--team-id <id>] [--project-id <id>] [--agent-id <id>]"
  );
  console.log("  openpond sandbox runtime-get <runtimeId>");
  console.log("  openpond sandbox runtime-events <runtimeId>");
  console.log(
    "  openpond sandbox runtime-status <runtimeId> --status <status> --expected-version <n>"
  );
  console.log(
    "  openpond sandbox runtime-event <runtimeId> --type <eventType> [--summary <text>] [--payload <json>] [--lifecycle-hint <json>]"
  );
  console.log("  openpond sandbox pricing");
  console.log(
    "  openpond sandbox costs [--team-id <id>] [--project-id <id>] [--agent-id <id>] [--summary]"
  );
  console.log(
    "  openpond sandbox run-published-snapshot [--snapshot-id <id>|--name <name>|--use-case <id>] [--version <v>] [--team-id <id>] [--budget-usd 0.05]"
  );
  console.log(
    "  openpond sandbox snapshot-fork <snapshotId> [--team-id <id>] [--project-id <id>] [--budget-usd 0.05]"
  );
  console.log(
    "  openpond sandbox snapshot-create <sandboxId> --name <name> [--template-name <name>] [--template-version <v>] [--template-visibility private|team] [--validation-command <cmd>]"
  );
  console.log(
    "  openpond sandbox snapshot-validate <sandboxId> <snapshotId> [--cleanup delete|stop|archive]"
  );
  console.log("  openpond sandbox snapshot-publish <sandboxId> <snapshotId>");
  console.log(
    "  openpond sandbox create [--repo <url>] [--image python:3.12-slim-bookworm | --dockerfile Dockerfile] [--budget-usd 0.05] [--env-ref NAME=openpond://secret/...] [--env-literal NAME=value] [--project-id <id>] [--agent-id <id>] [--runtime-profile-id openpond-coding-core-v1] [--workflow-mode feature --runtime-project-id <projectId> --runtime-base-branch master]"
  );
  console.log(
    "    example: openpond sandbox create --runtime-profile-id openpond-coding-core-v1 --workflow-mode feature --runtime-project-id project_123 --runtime-base-branch master"
  );
  console.log(
    "    example: openpond sandbox create --image python:3.12-slim-bookworm --command 'python --version'"
  );
  console.log(
    "    example: openpond sandbox create --dockerfile Dockerfile --dockerfile-context . --docker-build-args '{\"NODE_VERSION\":\"20\"}'"
  );
  console.log('  openpond sandbox exec <sandboxId> --command "bun test"');
  console.log(
    "  openpond sandbox port <sandboxId> --port 4173 [--access private|public] [--auto-start] [--domain app.example.com] [--auth-token <token>|--auth-header <name> --auth-header-value <value>]"
  );
  console.log(
    "  openpond sandbox stop <sandboxId> [--fail-on-unpreserved-changes] [--async]"
  );
  console.log(
    "  openpond sandbox delete <sandboxId> [--fail-on-unpreserved-changes] [--async]"
  );
  console.log("  openpond sandbox receipts <sandboxId>");
  console.log("  openpond sandbox logs <sandboxId>");
  console.log("  openpond sandbox billing <sandboxId>");
  console.log(
    "  openpond sandbox integration-connections [--team-id <id>] [--project-id <id>] [--agent-id <id>] [--status active|all]"
  );
  console.log("  openpond sandbox integration-leases <sandboxId>");
  console.log(
    "  openpond sandbox integration-attach <sandboxId> --integration-connection <id> --integration-capabilities <csv>"
  );
  console.log(
    "  openpond sandbox integration-remove <sandboxId> --lease-id <id>"
  );
  console.log(
    '  openpond sandbox process-start <sandboxId> --command "bun dev"'
  );
  console.log("  openpond sandbox process-list <sandboxId>");
  console.log(
    "  openpond sandbox process-get <sandboxId> <processId> [--since <cursor>]"
  );
  console.log("  openpond sandbox process-stop <sandboxId> <processId>");
  console.log(
    "  openpond sandbox process-stream <sandboxId> <processId> [--since <cursor>]"
  );
  console.log('  openpond sandbox pty-start <sandboxId> [--command "/bin/sh"]');
  console.log("  openpond sandbox pty-list <sandboxId>");
  console.log(
    "  openpond sandbox pty-get <sandboxId> <ptyId> [--since <cursor>]"
  );
  console.log('  openpond sandbox pty-write <sandboxId> <ptyId> --input "ls"');
  console.log("  openpond sandbox pty-stop <sandboxId> <ptyId>");
  console.log(
    "  openpond sandbox pty-stream <sandboxId> <ptyId> [--since <cursor>]"
  );
  console.log(
    '  openpond sandbox upload-file <sandboxId> --path <path> --contents "text"'
  );
  console.log("  openpond sandbox download-file <sandboxId> --path <path>");
  console.log("  openpond sandbox list-files <sandboxId> [--path <path>]");
  console.log(
    "  openpond sandbox search-files <sandboxId> --query <text> [--path <path>]"
  );
  console.log(
    "  openpond sandbox delete-file <sandboxId> --path <path> [--recursive]"
  );
  console.log("  openpond sandbox stat-file <sandboxId> --path <path>");
  console.log("  openpond sandbox mkdir <sandboxId> --path <path>");
  console.log(
    "  openpond sandbox move-file <sandboxId> --from-path <path> --to-path <path>"
  );
  console.log("  openpond sandbox git-status <sandboxId>");
  console.log("  openpond sandbox git-diff <sandboxId> [--base-ref <ref>]");
  console.log(
    "  openpond sandbox git-export-patch <sandboxId> [--base-ref <ref>]"
  );
  console.log(
    "  openpond sandbox git-branch <sandboxId> --branch <name> [--create] [--start-point <ref>]"
  );
  console.log(
    '  openpond sandbox git-commit <sandboxId> --message "..." [--all|--paths <csv>]'
  );
  console.log(
    "  openpond sandbox git-pull <sandboxId> [--remote origin] [--branch main] [--rebase|--ff-only false]"
  );
  console.log(
    "  openpond sandbox git-push <sandboxId> [--remote origin] [--branch main] [--set-upstream] [--force-with-lease]"
  );
  console.log(
    "  openpond sandbox runtime-preserve-source <runtimeId> [--team-id <id>] [--sandbox-id <id>] [--message <text>]"
  );
  console.log(
    "  openpond sandbox smoke --env staging [--account <profile>] [--keep]"
  );
  console.log("  openpond opchat provider-catalog [--env staging]");
  console.log("  openpond opchat models [--env staging]");
  console.log("  openpond opchat model <model> [--env staging]");
  console.log(
    "  openpond opchat chat [--env staging] [--model openpond-chat] [--message <text>] [--stream]"
  );
  console.log(
    "  openpond opchat smoke [--env staging] [--skip-stream] [--skip-tool] [--json]"
  );
  console.log("  openpond apps list [--handle <handle>] [--refresh] [--json]");
  console.log(
    "  openpond apps code-visibility <handle>/<repo> --visibility public|private"
  );
  console.log("  openpond apps tools");
  console.log(
    "  openpond apps deploy <handle>/<repo> [--env preview|production] [--watch]"
  );
  console.log("  openpond apps env get <handle>/<repo>");
  console.log("  openpond apps env set <handle>/<repo> --env <json>");
  console.log("  openpond apps performance [--app-id <id>]");
  console.log("  openpond apps summary <handle>/<repo>");
  console.log(
    "  openpond apps assistant <plan|performance> <handle>/<repo> --prompt <text>"
  );
  console.log(
    "  openpond apps store events [--source <source>] [--status <csv>] [--symbol <symbol>] [--wallet-address <0x...>] [--since <ms|iso>] [--until <ms|iso>] [--limit <n>] [--cursor <cursor>] [--history <true|false>] [--params <json>]"
  );
  console.log("  openpond apps trade-facts [--app-id <id>]");
  console.log(
    "  openpond apps agent create --prompt <text> [--team-id <id>] [--template-id <id>]"
  );
  console.log(
    "  openpond apps tools execute <appId> <deploymentId> <tool> [--body <json>] [--method <METHOD>] [--headers <json>] [--summary <true|false>]"
  );
  console.log(
    "  openpond apps positions tx [--method <GET|POST>] [--body <json>] [--params <json>]"
  );
  console.log("  openpond check-update");
  console.log("  openpond opentool <init|validate|build> [args]");
  console.log("");
  console.log("Global options:");
  console.log("  -h, --help");
  console.log("  -v, --version");
  console.log("  -j, --json");
  console.log("  -y, --yes");
  console.log("  -f, --force");
  console.log("  -C <dir>, --cwd <dir>");
  console.log("  --account <name> (alias: --profile <name>)");
  console.log("  --base-url <url> (alias: --baseurl)");
  console.log("  --api-base-url <url> (API endpoint for this profile)");
  console.log(
    "  --chat-api-base-url <url> (hosted chat/model endpoint for this profile)"
  );
  console.log("  --opchat-api-base-url <url> (OpChat /opchat/v1 endpoint)");
  console.log(
    "  --sandbox-api-url <url> (exact /v1/sandboxes or /api/sandboxes endpoint)"
  );
  console.log("");
  console.log("Env:");
  console.log(
    "  OPENPOND_API_KEY, OPENPOND_ACCOUNT, OPENPOND_BASE_URL, OPENPOND_API_URL, OPENPOND_OPCHAT_API_URL, OPENPOND_CHAT_API_URL, OPENPOND_TOOL_URL, OPENPOND_SANDBOX_BASE_URL, OPENPOND_SANDBOX_API_URL"
  );
}
