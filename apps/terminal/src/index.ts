#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { pathToFileURL } from "node:url";
import {
  type Approval,
  type BootstrapPayload,
  type RuntimeEvent,
} from "@openpond/contracts";
import { createComposer, handleComposerKey, replaceComposerText, type ComposerState } from "./ui/composer.js";
import {
  createLineModeTurnGuard,
  LINE_MODE_TURN_RUNNING_MESSAGE,
} from "./line-mode-turn-guard.js";
import {
  parseDirectCommandPrompt,
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashCommandDefinition,
} from "./ui/commands.js";
import { RawInput } from "./ui/input.js";
import { renderTranscriptItemsForScrollback, renderWelcome } from "./ui/layout.js";
import { createTerminalRenderScheduler } from "./ui/render-scheduler.js";
import { TerminalRenderer } from "./ui/renderer.js";
import {
  appendRuntimeEvent,
  appendTranscriptItem,
  commitReadyTranscriptItems,
  systemItem,
  userItem,
  type TranscriptItem,
} from "./ui/transcript.js";
import { parseTerminalArgs, resolveTerminalChatMode, type TerminalOptions } from "./args.js";
import { handleTerminalSlashCommand } from "./command-handlers.js";
import { apiFetch, ensureServer, stopManagedServer } from "./connection.js";
import {
  runTerminalDirectCommand,
  terminalDirectCommandBlockedReason,
} from "./direct-command.js";
import { openTerminalEvents, type TerminalEventStreamController } from "./events.js";
import { createTerminalInteractiveState } from "./interactive-state.js";
import {
  ensureTerminalChatSession,
  ensureTerminalSessionWorkspaceReady,
  findTerminalSession,
  profileLabel,
} from "./session-state.js";
import {
  commandApprovalFromRuntimeEvent,
  commandApprovalIdFromResolvedEvent,
  formatTerminalCommandApprovalQuestion,
  latestPendingCommandApproval,
  parseTerminalPermissionChoice,
  TERMINAL_PERMISSION_QUESTION_CHOICES,
  type TerminalPermissionChoice,
} from "./permissions.js";
import { createLatestWinsTaskScheduler, createSerialTaskScheduler } from "./task-scheduler.js";
import {
  activeModelId,
  activeModelRef,
  installAppOptions,
  installAppQuery,
  modelLabel,
  providerLabel,
  terminalSessionHeading,
} from "./formatting.js";
import { runOneShotChat } from "./one-shot-chat.js";

type Options = TerminalOptions;

async function interruptTurn(server: string, token: string, sessionId: string): Promise<void> {
  await apiFetch(server, token, `/v1/sessions/${sessionId}/turns/interrupt`, { method: "POST" });
}

function openUrlCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

function openUrlDetached(url: string): void {
  const { command, args } = openUrlCommand(url);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function chat(options: Options): Promise<void> {
  const mode = resolveTerminalChatMode(options, {
    inputIsTTY: Boolean(input.isTTY),
    outputIsTTY: Boolean(output.isTTY),
  });
  if (mode === "one-shot") {
    await runOneShotChat(options, { input, output });
    return;
  }

  if (mode === "line-mode") {
    await lineModeChat(options);
    return;
  }

  let transcript: TranscriptItem[] = [];
  let composer: ComposerState = createComposer();
  let slashSelectedIndex = 0;
  let slashLastQuery: string | null = null;
  let scrollOffset = 0;
  let activeSessionId = options.resume;
  let activeAgentId: string | null = null;
  let payload: BootstrapPayload | null = null;
  let eventStream: TerminalEventStreamController | null = null;
  let exitResolve: (() => void) | null = null;
  let connection: { server: string; token: string } | null = null;
  let pendingCommandApproval: Approval | null = null;
  let permissionQuestion: { approval: Approval } | null = null;
  let permissionQuestionSelectedIndex = 0;
  let exitRequested = false;
  let notice: string | null = null;
  let eventStreamNotice: string | null = null;
  const commandScheduler = createSerialTaskScheduler();
  const resizeRenderScheduler = createLatestWinsTaskScheduler();
  const interaction = createTerminalInteractiveState(activeSessionId);

  const renderer = new TerminalRenderer(output as WriteStream, () => {
    resizeRenderScheduler.request(() => {
      renderer.fullRedraw();
      render();
    });
  });

  function status() {
    return {
      provider: providerLabel(payload?.providers, options.provider),
      model: modelLabel(payload?.providers, options),
      cwd: options.cwd,
      profile: payload ? profileLabel(payload) : "loading",
      agent: activeAgentId,
      running: interaction.snapshot().phase === "running",
      sessionId: activeSessionId,
      notice: notice ?? eventStreamNotice,
    };
  }

  function render(): void {
    flushCommittedItems();
    renderer.render({
      transcript,
      composer,
      slashMenu: activeSlashMenu(),
      status: status(),
      scrollOffset,
    });
  }
  const eventRenderScheduler = createTerminalRenderScheduler(render);

  function activeSlashMenu(): { items: SlashCommandDefinition[]; selectedIndex: number } | null {
    if (permissionQuestion) {
      permissionQuestionSelectedIndex = Math.min(
        Math.max(0, permissionQuestionSelectedIndex),
        TERMINAL_PERMISSION_QUESTION_CHOICES.length - 1,
      );
      return {
        items: TERMINAL_PERMISSION_QUESTION_CHOICES,
        selectedIndex: permissionQuestionSelectedIndex,
      };
    }

    const appQuery = installAppQuery(composer.text);
    if (appQuery !== null) {
      const queryKey = `install:${appQuery}`;
      if (queryKey !== slashLastQuery) {
        slashSelectedIndex = 0;
        slashLastQuery = queryKey;
      }
      const items = installAppOptions(appQuery);
      if (items.length === 0) return null;
      slashSelectedIndex = Math.min(Math.max(0, slashSelectedIndex), items.length - 1);
      return { items, selectedIndex: slashSelectedIndex };
    }

    const query = slashCommandQuery(composer.text);
    if (query === null) {
      slashLastQuery = null;
      return null;
    }
    if (query !== slashLastQuery) {
      slashSelectedIndex = 0;
      slashLastQuery = query;
    }
    const items = SLASH_COMMANDS.filter((command) => command.name.startsWith(query) || command.usage.slice(1).startsWith(query));
    if (items.length === 0) return null;
    slashSelectedIndex = Math.min(Math.max(0, slashSelectedIndex), items.length - 1);
    return { items, selectedIndex: slashSelectedIndex };
  }

  function slashCommandQuery(text: string): string | null {
    if (!text.startsWith("/") || text.includes("\n")) return null;
    const body = text.slice(1);
    if (body.includes(" ")) return null;
    return body.toLowerCase();
  }

  function flushCommittedItems(): void {
    const { readyItems, activeItems } = commitReadyTranscriptItems(transcript);
    if (readyItems.length === 0) return;
    renderer.commitLines(renderTranscriptItemsForScrollback(readyItems, output.columns || 80));
    transcript = activeItems;
  }

  function addItem(item: TranscriptItem): void {
    transcript = appendTranscriptItem(transcript, item);
    scrollOffset = 0;
    render();
  }

  function setNotice(text: string | null): void {
    notice = text;
    render();
  }

  function activePendingCommandApproval(): Approval | null {
    if (pendingCommandApproval?.status === "pending" && pendingCommandApproval.sessionId === activeSessionId) {
      return pendingCommandApproval;
    }
    return latestPendingCommandApproval(payload, activeSessionId);
  }

  function openCommandApprovalQuestion(approval: Approval): void {
    pendingCommandApproval = approval;
    permissionQuestion = { approval };
    permissionQuestionSelectedIndex = 0;
    setNotice("approval question");
    addItem(systemItem(formatTerminalCommandApprovalQuestion(approval), "warning"));
  }

  async function resolvePermissionQuestion(choice: TerminalPermissionChoice): Promise<void> {
    if (!connection || !permissionQuestion) return;
    const approval = permissionQuestion.approval;
    setNotice("resolving approval");
    try {
      await apiFetch(connection.server, connection.token, `/v1/approvals/${encodeURIComponent(approval.id)}`, {
        method: "POST",
        body: JSON.stringify({
          decision:
            choice === "yes"
              ? "accept"
              : choice === "session"
                ? "acceptForSession"
                : choice === "skip"
                  ? "cancel"
                  : "decline",
        }),
      });
      permissionQuestion = null;
      if (pendingCommandApproval?.id === approval.id) pendingCommandApproval = null;
      notice = null;
      render();
    } catch (error) {
      setNotice(null);
      addItem(systemItem(error instanceof Error ? error.message : String(error), "error"));
    }
  }

  async function refreshBootstrap(refreshCodex = false): Promise<BootstrapPayload> {
    if (!connection) throw new Error("Not connected");
    payload = await apiFetch<BootstrapPayload>(connection.server, connection.token, `/v1/bootstrap${refreshCodex ? "?refreshCodex=1" : ""}`);
    activeAgentId = activeAgentId ?? payload.profile.agents[0]?.id ?? null;
    return payload;
  }

  async function submitPrompt(text: string): Promise<void> {
    if (!activeSessionId) {
      addItem(systemItem("Wait for terminal startup before sending a turn.", "warning"));
      return;
    }
    const started = interaction.beginTurn(activeSessionId);
    if (!started.ok) {
      addItem(systemItem(started.message, "warning"));
      return;
    }
    if (!connection) {
      interaction.failTurnSubmission(activeSessionId);
      addItem(systemItem("Wait for the server connection before sending a turn.", "warning"));
      return;
    }
    transcript = appendTranscriptItem(transcript, userItem(text));
    setNotice("running");
    render();
    const prompt = activeAgentId ? `@${activeAgentId} ${text}` : text;
    const modelId = activeModelId(options, payload?.providers);
    if (!modelId) {
      interaction.failTurnSubmission(activeSessionId);
      setNotice(null);
      addItem(systemItem(`No model selected for ${providerLabel(payload?.providers, options.provider)}. Use /model <id> or configure a default model in Desktop settings.`, "warning"));
      return;
    }
    try {
      await apiFetch(connection.server, connection.token, `/v1/sessions/${activeSessionId}/turns`, {
        method: "POST",
        body: JSON.stringify({
          prompt,
          ...(options.cwdExplicit || (!options.project && !options.resume) ? { cwd: options.cwd } : {}),
          model: modelId,
          modelRef: activeModelRef(options, payload?.providers),
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        }),
      });
    } catch (error) {
      interaction.failTurnSubmission(activeSessionId);
      setNotice(null);
      addItem(systemItem(error instanceof Error ? error.message : String(error), "error"));
    }
  }

  async function submitDirectCommand(command: string): Promise<void> {
    if (!connection || !activeSessionId) return;
    const latest = payload ?? await refreshBootstrap();
    const session = findTerminalSession(latest, activeSessionId);
    const blockedReason = terminalDirectCommandBlockedReason(session);
    if (blockedReason || !session) {
      addItem(systemItem(blockedReason ?? "Select a project to use this.", "warning"));
      return;
    }
    setNotice("running command");
    try {
      const result = await runTerminalDirectCommand(connection, session, command);
      for (const event of result.events) {
        transcript = appendRuntimeEvent(transcript, event);
      }
      payload = await refreshBootstrap().catch(() => payload);
    } catch (error) {
      addItem(systemItem(error instanceof Error ? error.message : String(error), "error"));
    } finally {
      setNotice(null);
      render();
    }
  }

  async function handleSubmit(text: string): Promise<void> {
    try {
      const phase = interaction.snapshot().phase;
      if (phase === "starting" || phase === "switching" || phase === "stopping") {
        const command = parseSlashCommand(text);
        if (command?.type === "exit") requestExit();
        else {
          const blocked = interaction.blocked("accepting input");
          if (!blocked.ok) addItem(systemItem(blocked.message, "warning"));
        }
        return;
      }
      if (permissionQuestion) {
        const choice = parseTerminalPermissionChoice(text);
        if (!choice) {
          addItem(systemItem("Choose yes, session, no, or skip.", "warning"));
          return;
        }
        transcript = appendTranscriptItem(transcript, userItem(text));
        render();
        await resolvePermissionQuestion(choice);
        return;
      }
      const directCommand = parseDirectCommandPrompt(text);
      if (directCommand) {
        const allowed = interaction.blocked("running a direct command");
        if (!allowed.ok) {
          addItem(systemItem(allowed.message, "warning"));
          return;
        }
        await commandScheduler.run(() => submitDirectCommand(directCommand.command));
        return;
      }
      const command = parseSlashCommand(text);
      if (command) {
        transcript = appendTranscriptItem(transcript, userItem(text));
        render();
        await commandScheduler.run(() =>
          handleTerminalSlashCommand(command, {
            options,
            getConnection: () => connection,
            getPayload: () => payload,
            setPayload: (nextPayload) => {
              payload = nextPayload;
            },
            getActiveSessionId: () => activeSessionId,
            setActiveSessionId: (sessionId) => {
              activeSessionId = sessionId;
            },
            switchSession: async (create) => {
              const started = interaction.beginSessionSwitch();
              if (!started.ok) throw new Error(started.message);
              try {
                const created = await create();
                const session = await ensureTerminalSessionWorkspaceReady(connection!, created) ?? created;
                activeSessionId = session.id;
                await eventStream?.switchSession(session.id);
                interaction.completeSessionSwitch(session.id);
                transcript = [];
                pendingCommandApproval = null;
                permissionQuestion = null;
                return session;
              } catch (error) {
                interaction.failSessionSwitch();
                throw error;
              }
            },
            getActiveAgentId: () => activeAgentId,
            setActiveAgentId: (agentId) => {
              activeAgentId = agentId;
            },
            getPendingCommandApproval: activePendingCommandApproval,
            openCommandApprovalQuestion,
            refreshBootstrap,
            addItem,
            clearTranscript: () => {
              transcript = [];
            },
            requestExit,
            render,
            openUrl: openUrlDetached,
          })
        );
        return;
      }
      await submitPrompt(text);
    } catch (error) {
      addItem(systemItem(error instanceof Error ? error.message : String(error), "error"));
    }
  }

  function submitMenuCommand(command: SlashCommandDefinition): void {
    if (permissionQuestion) {
      const choice =
        parseTerminalPermissionChoice(composer.text) ??
        parseTerminalPermissionChoice(command.submitText ?? command.name);
      composer = createComposer();
      render();
      if (choice) void resolvePermissionQuestion(choice);
      return;
    }
    const commandText = command.submitText ?? `/${command.name}`;
    if (command.requiresArgument) {
      composer = replaceComposerText(composer, `${commandText} `);
      slashSelectedIndex = 0;
      render();
      return;
    }
    composer = {
      text: "",
      cursor: 0,
      history: [...composer.history.filter((item) => item !== commandText), commandText].slice(-100),
      historyIndex: null,
    };
    slashSelectedIndex = 0;
    render();
    void handleSubmit(commandText);
  }

  async function handleKey(key: string): Promise<void> {
    if (key === "pageup") {
      scrollOffset += Math.max(4, Math.floor((output.rows || 24) / 2));
      render();
      return;
    }
    if (key === "pagedown") {
      scrollOffset = Math.max(0, scrollOffset - Math.max(4, Math.floor((output.rows || 24) / 2)));
      render();
      return;
    }

    const menu = activeSlashMenu();
    if (menu && key === "up") {
      if (permissionQuestion) permissionQuestionSelectedIndex = Math.max(0, permissionQuestionSelectedIndex - 1);
      else slashSelectedIndex = Math.max(0, slashSelectedIndex - 1);
      render();
      return;
    }
    if (menu && key === "down") {
      if (permissionQuestion) {
        permissionQuestionSelectedIndex = Math.min(menu.items.length - 1, permissionQuestionSelectedIndex + 1);
      } else {
        slashSelectedIndex = Math.min(menu.items.length - 1, slashSelectedIndex + 1);
      }
      render();
      return;
    }
    if (menu && key === "enter") {
      submitMenuCommand(menu.items[slashSelectedIndex] ?? menu.items[0]!);
      return;
    }

    const before = composer;
    const result = handleComposerKey(composer, key);
    composer = result.state;
    if (!activeSlashMenu()) slashSelectedIndex = 0;
    if (result.action.type === "submit") {
      render();
      void handleSubmit(result.action.text);
      return;
    }
    if (result.action.type === "cancel-or-exit") {
      if (permissionQuestion) {
        void resolvePermissionQuestion("skip");
      } else if (interaction.snapshot().phase === "running" && connection && activeSessionId) {
        setNotice("interrupting");
        void interruptTurn(connection.server, connection.token, activeSessionId).catch((error) => {
          addItem(systemItem(error instanceof Error ? error.message : String(error), "error"));
        });
      } else if (before.text) {
        composer = createComposer();
        render();
      } else {
        requestExit();
      }
      return;
    }
    if (result.action.type === "exit") {
      requestExit();
      return;
    }
    if (result.action.type === "rerender") renderer.fullRedraw();
    render();
  }

  function requestExit(): void {
    if (exitRequested) return;
    exitRequested = true;
    interaction.beginStopping();
    exitResolve?.();
  }

  const rawInput = new RawInput(input as ReadStream, (key) => {
    void handleKey(key);
  });

  renderer.start();
  rawInput.start();
  try {
    const startupWarnings: string[] = [];
    connection = await ensureServer(options, (line) => startupWarnings.push(line));
    payload = await apiFetch<BootstrapPayload>(connection.server, connection.token, "/v1/bootstrap?refreshCodex=1");
    activeAgentId = payload.profile.agents[0]?.id ?? null;
    const sessionState = await ensureTerminalChatSession(connection, payload, options, activeSessionId);
    const readySession = await ensureTerminalSessionWorkspaceReady(connection, sessionState.session);
    activeSessionId = sessionState.sessionId;
    if (readySession?.cwd) options.cwd = readySession.cwd;
    options.provider = sessionState.provider;
    options.model = sessionState.model;
    notice = null;
    renderer.commitLines([...renderWelcome(status(), output.columns || 80), ""]);
    for (const line of startupWarnings) addItem(systemItem(line, "warning"));
    eventStream = await openTerminalEvents({
      server: connection.server,
      token: connection.token,
      activeSessionId: () => activeSessionId,
      onEvent: (event) => {
        interaction.applyRuntimeEvent(event);
        const requestedApproval = commandApprovalFromRuntimeEvent(event);
        if (requestedApproval) pendingCommandApproval = requestedApproval;
        const resolvedApprovalId = commandApprovalIdFromResolvedEvent(event);
        if (resolvedApprovalId && pendingCommandApproval?.id === resolvedApprovalId) {
          pendingCommandApproval = null;
        }
        if (resolvedApprovalId && permissionQuestion?.approval.id === resolvedApprovalId) {
          permissionQuestion = null;
          notice = null;
        }
        transcript = appendRuntimeEvent(transcript, event);
        if (event.name === "turn.completed" || event.name === "turn.failed" || event.name === "turn.interrupted") {
          notice = null;
        }
        eventRenderScheduler.request();
      },
      onStatus: (status) => {
        if (status.state === "disconnected") {
          eventStreamNotice = `event stream reconnecting in ${Math.ceil(status.nextDelayMs / 1000)}s`;
          eventRenderScheduler.request();
        } else if (status.state === "connected" && eventStreamNotice) {
          eventStreamNotice = null;
          eventRenderScheduler.request();
        }
      },
    });
    await eventStream.ready;
    interaction.completeStartup(activeSessionId);
    render();
    await new Promise<void>((resolve) => {
      exitResolve = resolve;
    });
  } finally {
    eventStream?.abort();
    eventRenderScheduler.cancel();
    resizeRenderScheduler.cancel();
    rawInput.stop();
    renderer.stop();
    await stopManagedServer();
  }
}

function printEvent(event: RuntimeEvent): void {
  if (event.name === "assistant.delta") output.write(event.output ?? "");
  else if (event.name === "turn.completed") output.write("\n[turn completed]\n");
  else if (event.name === "approval.requested") output.write(`\n[approval] ${event.output ?? event.action ?? "request"}\n`);
  else if (event.name === "command.output" && event.output) output.write(`\n[command] ${event.output}\n`);
  else if (event.name.startsWith("workspace_")) output.write(`\n[openpond] ${event.output ?? event.action ?? event.name}\n`);
}

async function lineModeChat(options: Options): Promise<void> {
  const connection = await ensureServer(options, (line) => output.write(`${line}\n`));
  const payload = await apiFetch<BootstrapPayload>(connection.server, connection.token, "/v1/bootstrap?refreshCodex=1");
  const sessionState = await ensureTerminalChatSession(connection, payload, options, options.resume);
  const readySession = await ensureTerminalSessionWorkspaceReady(connection, sessionState.session);
  const activeSessionId = sessionState.sessionId;
  if (readySession?.cwd) options.cwd = readySession.cwd;
  options.provider = sessionState.provider;
  options.model = sessionState.model;
  const turnGuard = createLineModeTurnGuard();
  const eventStream = await openTerminalEvents({
    server: connection.server,
    token: connection.token,
    activeSessionId: () => activeSessionId,
    onEvent: (event) => {
      turnGuard.applyRuntimeEvent(event);
      printEvent(event);
    },
    onStatus: (status) => {
      if (status.state === "disconnected") {
        output.write(`\n[event stream] reconnecting in ${Math.ceil(status.nextDelayMs / 1000)}s: ${status.message}\n`);
      }
    },
  });
  await eventStream.ready;
  const rl = createInterface({ input, output });
  output.write(`${terminalSessionHeading(payload.providers, options)}\n`);
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (!turnGuard.tryStartSubmission()) {
        output.write(`${LINE_MODE_TURN_RUNNING_MESSAGE}\n`);
        continue;
      }
      const modelId = activeModelId(options, payload.providers);
      if (!modelId) {
        turnGuard.failSubmission();
        throw new Error(`No model selected for ${providerLabel(payload.providers, options.provider)}.`);
      }
      try {
        await apiFetch(connection.server, connection.token, `/v1/sessions/${activeSessionId}/turns`, {
          method: "POST",
          body: JSON.stringify({
            prompt: line,
            ...(options.cwdExplicit || (!options.project && !options.resume) ? { cwd: options.cwd } : {}),
            model: modelId,
            modelRef: activeModelRef(options, payload.providers),
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
          }),
        });
      } catch (error) {
        turnGuard.failSubmission();
        throw error;
      }
    }
  } finally {
    rl.close();
    eventStream.abort();
    await stopManagedServer();
  }
}

export async function runOpenPondTerminalCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, options } = parseTerminalArgs(argv);
  if (command !== "chat") {
    output.write(
      "Usage: openpond-app chat [--server URL] [--provider PROVIDER] [--model MODEL] [--cwd DIR] [--project APP_ID] [--resume SESSION_ID] (--message TEXT|--message-file PATH|--stdin) --non-interactive [--yes] [--approval-policy POLICY] [--json] [--timeout-sec SEC] [--max-output-bytes BYTES] [--sandbox MODE]\n"
    );
    return;
  }
  await chat(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runOpenPondTerminalCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    const exitCode = typeof (error as { exitCode?: unknown }).exitCode === "number"
      ? (error as { exitCode: number }).exitCode
      : 1;
    process.exit(exitCode);
  });
}
