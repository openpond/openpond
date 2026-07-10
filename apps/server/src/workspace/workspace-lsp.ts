import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type {
  AppPreferences,
  WorkspaceEditorPreferences,
  WorkspaceLspActionResponse,
  WorkspaceLspDiagnostic,
  WorkspaceLspDiagnosticsResponse,
  WorkspaceLspLanguageId,
  WorkspaceLspRuntimeStatusResponse,
  WorkspaceLspSettingsStatusResponse,
  WorkspaceLspServerStatus,
} from "@openpond/contracts";
import { WorkspaceEditorPreferencesSchema } from "@openpond/contracts";
import { now, textFromUnknown } from "../utils.js";
import { resolveForPreview } from "../workspace-tools/workspace-tool-file-system.js";

type LspSeverityNumber = 1 | 2 | 3 | 4;

type LspPosition = {
  line: number;
  character: number;
};

type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

type LspDiagnostic = {
  range: LspRange;
  severity?: LspSeverityNumber;
  message: string;
  source?: string;
  code?: string | number;
};

type WorkspaceLspActionOperation = WorkspaceLspActionResponse["operation"];

type ServerDefinition = {
  id: string;
  label: string;
  preferenceKey: WorkspaceLspLanguageId;
  extensions: string[];
  rootMarkers: string[];
  spawn(root: string, repoPath: string, filePath: string): Promise<LspSpawn | null>;
  spawnCustom(command: string, root: string, repoPath: string, filePath: string): Promise<LspSpawn>;
};

type LspSpawn = {
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
};

type OpenDocument = {
  path: string;
  text: string;
  version: number;
};

type RequestRecord = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkspaceLspClientOptions = {
  definition: ServerDefinition;
  root: string;
  repoPath: string;
  spawnInfo: LspSpawn;
  stderrMaxChars: number;
};

type WorkspaceLspClientSlot = {
  key: string;
  promise: Promise<WorkspaceLspClient | null>;
  client?: WorkspaceLspClient | null;
  definition: ServerDefinition;
  root: string;
  repoPath: string;
  lastUsedAtMs: number;
};

type WorkspaceLspManagerOptions = {
  definitions?: ServerDefinition[];
  idleTimeoutMs?: number;
  maxClients?: number;
  nowMs?: () => number;
  stderrMaxChars?: number;
};

const LSP_REQUEST_TIMEOUT_MS = 5_000;
const LSP_INITIALIZE_TIMEOUT_MS = 20_000;
const LSP_DIAGNOSTICS_WAIT_MS = 2_500;
const LSP_IDLE_TIMEOUT_MS = 5 * 60_000;
const LSP_MAX_CLIENTS = 6;
const LSP_STDERR_MAX_CHARS = 8_000;
const LSP_MAX_TEXT_DOCUMENT_BYTES = 512 * 1024;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;
const DEFAULT_EDITOR_PREFERENCES = WorkspaceEditorPreferencesSchema.parse({});

export class WorkspaceLspManager {
  private clients = new Map<string, WorkspaceLspClientSlot>();
  private broken = new Map<string, string>();
  private spawnResolutionCache = new Map<string, Promise<LspSpawn | null>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly definitions: ServerDefinition[];
  private readonly idleTimeoutMs: number;
  private readonly maxClients: number;
  private readonly nowMs: () => number;
  private readonly stderrMaxChars: number;

  constructor(options: WorkspaceLspManagerOptions = {}) {
    this.definitions = options.definitions ?? serverDefinitions;
    this.idleTimeoutMs = Math.max(1, Math.floor(options.idleTimeoutMs ?? LSP_IDLE_TIMEOUT_MS));
    this.maxClients = Math.max(1, Math.floor(options.maxClients ?? LSP_MAX_CLIENTS));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.stderrMaxChars = Math.max(0, Math.floor(options.stderrMaxChars ?? LSP_STDERR_MAX_CHARS));
  }

  async touchFile(input: {
    appId: string;
    repoPath: string;
    path: string;
    content?: string;
    preferences?: AppPreferences | null;
    waitForDiagnostics?: boolean;
  }): Promise<WorkspaceLspDiagnosticsResponse> {
    const resolved = await resolveWorkspaceLspPath(input.repoPath, input.path);
    const content = await loadLspDocumentText(resolved.targetPath, input.content);
    const clients = await this.clientsForFile(input.repoPath, resolved.targetPath, editorPreferences(input.preferences));
    const servers: WorkspaceLspServerStatus[] = [];
    const touched: Array<{ client: WorkspaceLspClient; diagnosticsVersion: number }> = [];

    for (const result of clients) {
      servers.push(result.status);
      if (!result.client) continue;
      const diagnosticsVersion = result.client.diagnosticsVersionFor(resolved.targetPath);
      await result.client.openOrChange(resolved.targetPath, content);
      touched.push({ client: result.client, diagnosticsVersion });
    }

    if (input.waitForDiagnostics !== false) {
      await Promise.all(
        touched.map(({ client, diagnosticsVersion }) =>
          client.waitForDiagnostics(resolved.targetPath, diagnosticsVersion),
        ),
      );
    }

    return {
      appId: input.appId,
      path: resolved.relativePath,
      diagnostics: this.diagnosticsForPath(input.repoPath, resolved.targetPath),
      servers,
      updatedAt: now(),
    };
  }

  async runAction(input: {
    appId: string;
    repoPath: string;
    path: string;
    operation: WorkspaceLspActionOperation;
    content?: string;
    preferences?: AppPreferences | null;
    line?: number;
    character?: number;
  }): Promise<WorkspaceLspActionResponse> {
    const resolved = await resolveWorkspaceLspPath(input.repoPath, input.path);
    const content = await loadLspDocumentText(resolved.targetPath, input.content);
    const clients = await this.clientsForFile(input.repoPath, resolved.targetPath, editorPreferences(input.preferences));
    const active = clients.filter((result): result is { client: WorkspaceLspClient; status: WorkspaceLspServerStatus } =>
      Boolean(result.client)
    );
    for (const result of active) {
      await result.client.openOrChange(resolved.targetPath, content);
    }

    const position =
      typeof input.line === "number" && typeof input.character === "number"
        ? { line: input.line, character: input.character }
        : null;
    const results = await Promise.all(
      active.map((result) => result.client.runAction(input.operation, resolved.targetPath, position))
    );

    return {
      appId: input.appId,
      operation: input.operation,
      path: resolved.relativePath,
      results: results.flat(),
      servers: clients.map((result) => result.status),
      updatedAt: now(),
    };
  }

  async settingsStatus(input: {
    preferences?: AppPreferences | null;
    repoPath?: string | null;
  } = {}): Promise<WorkspaceLspSettingsStatusResponse> {
    const preferences = editorPreferences(input.preferences);
    const root = input.repoPath ? path.resolve(input.repoPath) : process.cwd();
    const languages = await Promise.all(
      this.definitions.map(async (definition) => {
        const languagePreference = preferences.languages[definition.preferenceKey];
        if (preferences.languageServers === "off" || languagePreference.mode === "disabled") {
          return {
            language: definition.preferenceKey,
            label: definition.label,
            mode: languagePreference.mode,
            status: "disabled" as const,
            command: null,
            message: preferences.languageServers === "off" ? "Language servers are off." : "Disabled in settings.",
          };
        }
        if (languagePreference.mode === "custom" && !languagePreference.customCommand.trim()) {
          return {
            language: definition.preferenceKey,
            label: definition.label,
            mode: languagePreference.mode,
            status: "missing" as const,
            command: null,
            message: "Set a custom executable path.",
          };
        }
        try {
          const spawnInfo = await this.spawnForDefinitionCached(definition, root, root, "", preferences);
          return {
            language: definition.preferenceKey,
            label: definition.label,
            mode: languagePreference.mode,
            status: spawnInfo ? "found" as const : "missing" as const,
            command: spawnInfo?.command ?? null,
            message: spawnInfo ? null : "Executable not found.",
          };
        } catch (error) {
          return {
            language: definition.preferenceKey,
            label: definition.label,
            mode: languagePreference.mode,
            status: "error" as const,
            command: null,
            message: textFromUnknown(error) || "Failed to inspect language server.",
          };
        }
      }),
    );

    return {
      settings: preferences,
      languages,
      updatedAt: now(),
    };
  }

  runtimeStatus(): WorkspaceLspRuntimeStatusResponse {
    this.evictIdleClients();
    return {
      clients: Array.from(this.clients.values()).map((slot) => {
        const client = slot.client;
        if (client === undefined) {
          return {
            id: slot.definition.id,
            root: path.relative(slot.repoPath, slot.root) || ".",
            status: "starting" as const,
            message: null,
            openedDocuments: 0,
            pendingRequests: 0,
            lastUsedAt: new Date(slot.lastUsedAtMs).toISOString(),
            stderrTail: "",
          };
        }
        if (client === null) {
          return {
            id: slot.definition.id,
            root: path.relative(slot.repoPath, slot.root) || ".",
            status: "unavailable" as const,
            message: this.broken.get(slot.key) ?? "LSP server unavailable.",
            openedDocuments: 0,
            pendingRequests: 0,
            lastUsedAt: new Date(slot.lastUsedAtMs).toISOString(),
            stderrTail: "",
          };
        }
        return client.runtimeStatus(slot.lastUsedAtMs);
      }),
      maxClients: this.maxClients,
      idleTimeoutMs: this.idleTimeoutMs,
      updatedAt: now(),
    };
  }

  shutdown(): { shutdownClients: number; updatedAt: string } {
    const shutdownClients = this.clients.size;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const slot of this.clients.values()) {
      if (slot.client) slot.client.shutdown();
      else void slot.promise.then((client) => client?.shutdown()).catch(() => undefined);
    }
    this.clients.clear();
    this.broken.clear();
    this.spawnResolutionCache.clear();
    return { shutdownClients, updatedAt: now() };
  }

  private async clientsForFile(
    repoPath: string,
    targetPath: string,
    preferences: WorkspaceEditorPreferences,
  ): Promise<Array<{ client: WorkspaceLspClient | null; status: WorkspaceLspServerStatus }>> {
    this.evictIdleClients();
    const extension = path.extname(targetPath).toLowerCase();
    const matches = this.definitions.filter((definition) => definition.extensions.includes(extension));
    if (matches.length === 0) {
      return [
        {
          client: null,
          status: {
            id: "none",
            root: "",
            status: "unavailable",
            message: "No LSP configured for this file type.",
          },
        },
      ];
    }

    return Promise.all(
      matches.map(async (definition) => {
        const languagePreference = preferences.languages[definition.preferenceKey];
        if (preferences.languageServers === "off" || languagePreference.mode === "disabled") {
          return {
            client: null,
            status: {
              id: definition.id,
              root: "",
              status: "unavailable" as const,
              message: preferences.languageServers === "off" ? "LSP disabled in settings." : "Language server disabled.",
            },
          };
        }
        if (languagePreference.mode === "custom" && !languagePreference.customCommand.trim()) {
          return {
            client: null,
            status: {
              id: definition.id,
              root: "",
              status: "unavailable" as const,
              message: "Custom language server executable is not set.",
            },
          };
        }

        const root = await nearestRoot(targetPath, repoPath, definition.rootMarkers);
        if (!root) {
          return {
            client: null,
            status: {
              id: definition.id,
              root: "",
              status: "unavailable" as const,
              message: "No matching project root found.",
            },
          };
        }

        const key = [
          repoPath,
          root,
          definition.id,
          languagePreference.mode,
          languagePreference.mode === "custom" ? languagePreference.customCommand : "",
        ].join("\0");
        const brokenMessage = this.broken.get(key);
        if (brokenMessage) {
          return {
            client: null,
            status: {
              id: definition.id,
              root: path.relative(repoPath, root) || ".",
              status: "error" as const,
              message: brokenMessage,
            },
          };
        }

        let slot = this.clients.get(key);
        if (!slot) {
          this.evictIdleClients();
          this.evictLeastRecentlyUsedClients(1);
          const promise = this.spawnClient(key, definition, root, repoPath, targetPath, preferences);
          slot = {
            key,
            promise,
            definition,
            root,
            repoPath,
            lastUsedAtMs: this.nowMs(),
          };
          promise
            .then((client) => {
              slot!.client = client;
              if (!client) this.clients.delete(key);
              else this.scheduleIdleEviction();
            })
            .catch(() => {
              this.clients.delete(key);
            });
          this.clients.set(key, slot);
          this.scheduleIdleEviction();
        }
        slot.lastUsedAtMs = this.nowMs();
        const client = await slot.promise;
        if (client) {
          slot.client = client;
          slot.lastUsedAtMs = this.nowMs();
          client.markUsed();
          this.scheduleIdleEviction();
        }
        return {
          client,
          status: client
            ? client.status()
            : {
                id: definition.id,
                root: path.relative(repoPath, root) || ".",
                status: "unavailable" as const,
                message: this.broken.get(key) ?? "LSP server unavailable.",
              },
        };
      })
    );
  }

  private async spawnClient(
    key: string,
    definition: ServerDefinition,
    root: string,
    repoPath: string,
    filePath: string,
    preferences: WorkspaceEditorPreferences,
  ): Promise<WorkspaceLspClient | null> {
    try {
      const spawnInfo = await this.spawnForDefinitionCached(definition, root, repoPath, filePath, preferences);
      if (!spawnInfo) {
        this.broken.set(key, "Language server command was not found.");
        return null;
      }
      const client = new WorkspaceLspClient({ definition, root, repoPath, spawnInfo, stderrMaxChars: this.stderrMaxChars });
      await client.initialize();
      return client;
    } catch (error) {
      this.broken.set(key, textFromUnknown(error) || "Failed to start language server.");
      return null;
    }
  }

  private diagnosticsForPath(repoPath: string, targetPath: string): WorkspaceLspDiagnostic[] {
    // The clients map stores promises because startup can be shared. By the time
    // diagnostics are requested after touchFile, active clients are already
    // awaited in clientsForFile; access their cached diagnostics through a side
    // channel collected below.
    return diagnosticsForWorkspace(this.clients, repoPath, targetPath);
  }

  private spawnForDefinitionCached(
    definition: ServerDefinition,
    root: string,
    repoPath: string,
    filePath: string,
    preferences: WorkspaceEditorPreferences,
  ): Promise<LspSpawn | null> {
    const languagePreference = preferences.languages[definition.preferenceKey];
    const key = [
      path.resolve(repoPath),
      path.resolve(root),
      definition.id,
      languagePreference.mode,
      languagePreference.mode === "custom" ? languagePreference.customCommand : "",
    ].join("\0");
    let cached = this.spawnResolutionCache.get(key);
    if (!cached) {
      cached = spawnForDefinition(definition, root, repoPath, filePath, preferences).catch((error) => {
        this.spawnResolutionCache.delete(key);
        throw error;
      });
      this.spawnResolutionCache.set(key, cached);
    }
    return cached;
  }

  private scheduleIdleEviction(): void {
    if (this.clients.size === 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.evictIdleClients();
      if (this.clients.size > 0) this.scheduleIdleEviction();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private evictIdleClients(): number {
    const cutoff = this.nowMs() - this.idleTimeoutMs;
    let evicted = 0;
    for (const [key, slot] of this.clients.entries()) {
      if (!slot.client || slot.lastUsedAtMs > cutoff) continue;
      slot.client.shutdown();
      this.clients.delete(key);
      evicted += 1;
    }
    if (this.clients.size === 0 && this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return evicted;
  }

  private evictLeastRecentlyUsedClients(requiredSlots: number): number {
    let evicted = 0;
    while (this.clients.size + requiredSlots > this.maxClients) {
      const candidate = Array.from(this.clients.entries())
        .filter(([, slot]) => Boolean(slot.client))
        .sort((left, right) => left[1].lastUsedAtMs - right[1].lastUsedAtMs)[0];
      if (!candidate) break;
      const [key, slot] = candidate;
      slot.client?.shutdown();
      this.clients.delete(key);
      evicted += 1;
    }
    return evicted;
  }
}

class WorkspaceLspClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, RequestRecord>();
  private process: ChildProcessWithoutNullStreams;
  private capabilities: Record<string, unknown> = {};
  private diagnostics = new Map<string, WorkspaceLspDiagnostic[]>();
  private diagnosticsVersions = new Map<string, number>();
  private opened = new Map<string, OpenDocument>();
  private diagnosticsListeners = new Set<() => void>();
  private lastUsedAtMs = Date.now();
  private stderrTail = "";

  constructor(private options: WorkspaceLspClientOptions) {
    this.process = spawn(options.spawnInfo.command, options.spawnInfo.args, {
      cwd: options.root,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString("utf8")));
    this.process.on("exit", () => this.rejectAllPending(new Error(`${options.definition.id} exited`)));
    this.process.on("error", (error) => this.rejectAllPending(error));
  }

  markUsed(): void {
    this.lastUsedAtMs = Date.now();
  }

  async initialize(): Promise<void> {
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.options.root).href,
        workspaceFolders: [{ name: path.basename(this.options.root), uri: pathToFileURL(this.options.root).href }],
        initializationOptions: this.options.spawnInfo.initializationOptions ?? {},
        capabilities: {
          workspace: {
            configuration: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
            },
          },
        },
      },
      LSP_INITIALIZE_TIMEOUT_MS,
    );
    const initializeResult = asRecord(result);
    this.capabilities = asRecord(initializeResult?.capabilities) ?? {};
    this.notify("initialized", {});
    if (this.options.spawnInfo.initializationOptions) {
      this.notify("workspace/didChangeConfiguration", {
        settings: this.options.spawnInfo.initializationOptions,
      });
    }
  }

  status(): WorkspaceLspServerStatus {
    this.markUsed();
    return {
      id: this.options.definition.id,
      root: path.relative(this.options.repoPath, this.options.root) || ".",
      status: "connected",
      message: this.stderrTail ? `Recent stderr: ${this.stderrTail}` : null,
    };
  }

  runtimeStatus(lastUsedAtMs = this.lastUsedAtMs): WorkspaceLspRuntimeStatusResponse["clients"][number] {
    return {
      id: this.options.definition.id,
      root: path.relative(this.options.repoPath, this.options.root) || ".",
      status: "connected",
      message: this.stderrTail ? "Recent stderr captured." : null,
      openedDocuments: this.opened.size,
      pendingRequests: this.pending.size,
      lastUsedAt: new Date(lastUsedAtMs).toISOString(),
      stderrTail: this.stderrTail,
    };
  }

  async openOrChange(filePath: string, content: string): Promise<void> {
    this.markUsed();
    const text = content;
    const opened = this.opened.get(filePath);
    if (!opened) {
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileURL(filePath).href,
          languageId: lspLanguageIdForPath(filePath),
          version: 1,
          text,
        },
      });
      this.opened.set(filePath, { path: filePath, text, version: 1 });
      return;
    }

    const version = opened.version + 1;
    this.opened.set(filePath, { path: filePath, text, version });
    this.notify("textDocument/didChange", {
      textDocument: {
        uri: pathToFileURL(filePath).href,
        version,
      },
      contentChanges:
        syncKind(this.capabilities) === TEXT_DOCUMENT_SYNC_INCREMENTAL
          ? [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: documentEnd(opened.text),
                },
                text,
              },
            ]
          : [{ text }],
    });
  }

  diagnosticsVersionFor(filePath: string): number {
    return this.diagnosticsVersions.get(filePath) ?? 0;
  }

  async waitForDiagnostics(filePath: string, afterVersion: number): Promise<void> {
    if (this.diagnosticsVersionFor(filePath) > afterVersion) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.diagnosticsListeners.delete(listener);
        resolve();
      };
      const listener = () => {
        if (this.diagnosticsVersionFor(filePath) <= afterVersion) return;
        done();
      };
      timer = setTimeout(done, LSP_DIAGNOSTICS_WAIT_MS);
      this.diagnosticsListeners.add(listener);
    });
  }

  diagnosticsFor(filePath: string): WorkspaceLspDiagnostic[] {
    return this.diagnostics.get(filePath) ?? [];
  }

  async runAction(
    operation: WorkspaceLspActionOperation,
    filePath: string,
    position: LspPosition | null,
  ): Promise<unknown[]> {
    this.markUsed();
    if (operation !== "documentSymbol" && !position) return [];
    const textDocument = { uri: pathToFileURL(filePath).href };
    if (operation === "hover") {
      const result = await this.request("textDocument/hover", { textDocument, position }).catch(() => null);
      return result ? [result] : [];
    }
    if (operation === "definition") {
      const result = await this.request("textDocument/definition", { textDocument, position }).catch(() => null);
      return normalizeLspArray(result);
    }
    if (operation === "references") {
      const result = await this.request("textDocument/references", {
        textDocument,
        position,
        context: { includeDeclaration: true },
      }).catch(() => null);
      return normalizeLspArray(result);
    }
    const result = await this.request("textDocument/documentSymbol", { textDocument }).catch(() => null);
    return normalizeLspArray(result);
  }

  shutdown(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("LSP server stopped"));
    }
    this.pending.clear();
    try {
      this.notify("shutdown", {});
    } catch {
      // ignore shutdown races
    }
    this.process.kill();
  }

  private appendStderr(value: string): void {
    if (!value) return;
    this.stderrTail = `${this.stderrTail}${value}`;
    if (this.stderrTail.length > this.options.stderrMaxChars) {
      this.stderrTail = this.stderrTail.slice(this.stderrTail.length - this.options.stderrMaxChars);
    }
  }

  private request(method: string, params: unknown, timeout = LSP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    this.markUsed();
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.write(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private write(payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    this.process.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.process.stdin.write(body);
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (this.buffer.byteLength < messageEnd) return;
      const body = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      try {
        this.handleMessage(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // Drop malformed LSP frames.
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if ("id" in message && !("method" in message)) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if ("error" in message) pending.reject(new Error(textFromUnknown(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;
    if ("id" in message) {
      this.handleServerRequest(message.id as number | string, message.method, message.params);
      return;
    }
    this.handleNotification(message.method, message.params);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    if (method === "workspace/configuration") {
      const items = Array.isArray(asRecord(params)?.items) ? (asRecord(params)?.items as unknown[]) : [];
      this.respond(
        id,
        items.map(() => this.options.spawnInfo.initializationOptions ?? null),
      );
      return;
    }
    if (method === "workspace/workspaceFolders") {
      this.respond(id, [{ name: path.basename(this.options.root), uri: pathToFileURL(this.options.root).href }]);
      return;
    }
    if (method === "client/registerCapability" || method === "client/unregisterCapability") {
      this.respond(id, null);
      return;
    }
    if (method === "window/workDoneProgress/create" || method === "workspace/diagnostic/refresh") {
      this.respond(id, null);
      return;
    }
    this.respond(id, null);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics") return;
    const record = asRecord(params);
    const uri = typeof record?.uri === "string" ? record.uri : null;
    if (!uri?.startsWith("file://")) return;
    const filePath = normalizeAbsolutePath(fileURLToPath(uri));
    const diagnostics = Array.isArray(record?.diagnostics) ? record.diagnostics : [];
    this.diagnostics.set(
      filePath,
      diagnostics.map((item) => normalizeDiagnostic(filePath, item)).filter(Boolean) as WorkspaceLspDiagnostic[],
    );
    this.diagnosticsVersions.set(filePath, this.diagnosticsVersionFor(filePath) + 1);
    for (const listener of this.diagnosticsListeners) listener();
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function diagnosticsForWorkspace(
  clients: Map<string, WorkspaceLspClientSlot>,
  repoPath: string,
  targetPath: string,
): WorkspaceLspDiagnostic[] {
  // The slots have already resolved for active clients before this function is
  // called through touchFile/runAction, so diagnostics can be read
  // synchronously from cached client instances.
  return diagnosticsFromResolvedClients(clients, repoPath, targetPath);
}

function diagnosticsFromResolvedClients(
  clients: Map<string, WorkspaceLspClientSlot>,
  repoPath: string,
  targetPath: string,
): WorkspaceLspDiagnostic[] {
  const result: WorkspaceLspDiagnostic[] = [];
  for (const [key, slot] of clients.entries()) {
    if (!key.startsWith(`${repoPath}\0`)) continue;
    if (slot.client) result.push(...slot.client.diagnosticsFor(targetPath));
  }
  return result;
}

async function resolveWorkspaceLspPath(
  repoPath: string,
  inputPath: string,
): Promise<{ relativePath: string; targetPath: string }> {
  const { relativePath, targetPath } = await resolveForPreview(repoPath, inputPath);
  return {
    relativePath,
    targetPath: normalizeAbsolutePath(targetPath),
  };
}

async function loadLspDocumentText(filePath: string, content: string | undefined): Promise<string> {
  if (content !== undefined) {
    assertLspTextSize(Buffer.byteLength(content, "utf8"), filePath);
    return content;
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("LSP diagnostics require a file path.");
  assertLspTextSize(stat.size, filePath);
  return fs.readFile(filePath, "utf8");
}

function assertLspTextSize(sizeBytes: number, filePath: string): void {
  if (sizeBytes <= LSP_MAX_TEXT_DOCUMENT_BYTES) return;
  throw new Error(
    `LSP skipped ${path.basename(filePath)} because it is ${sizeBytes} bytes; the limit is ${LSP_MAX_TEXT_DOCUMENT_BYTES} bytes.`,
  );
}

function normalizeDiagnostic(filePath: string, value: unknown): WorkspaceLspDiagnostic | null {
  const record = asRecord(value);
  const range = asRecord(record?.range);
  const start = asRecord(range?.start);
  const end = asRecord(range?.end);
  if (!record || !range || !start || !end || typeof record.message !== "string") return null;
  return {
    path: filePath,
    range: {
      start: {
        line: numberOrZero(start.line),
        character: numberOrZero(start.character),
      },
      end: {
        line: numberOrZero(end.line),
        character: numberOrZero(end.character),
      },
    },
    severity: severityName(record.severity),
    message: record.message,
    source: typeof record.source === "string" ? record.source : null,
    code:
      typeof record.code === "string" || typeof record.code === "number"
        ? String(record.code)
        : null,
  };
}

function severityName(input: unknown): WorkspaceLspDiagnostic["severity"] {
  if (input === 1) return "error";
  if (input === 2) return "warning";
  if (input === 3) return "info";
  return "hint";
}

function syncKind(capabilities: Record<string, unknown>): number | null {
  const sync = capabilities.textDocumentSync;
  if (typeof sync === "number") return sync;
  if (sync && typeof sync === "object" && typeof (sync as { change?: unknown }).change === "number") {
    return (sync as { change: number }).change;
  }
  return null;
}

function documentEnd(text: string): LspPosition {
  const lines = text.split(/\r\n|\n|\r/);
  return {
    line: Math.max(0, lines.length - 1),
    character: lines.at(-1)?.length ?? 0,
  };
}

function normalizeLspArray(value: unknown): unknown[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

async function nearestRoot(filePath: string, repoPath: string, markers: string[]): Promise<string | null> {
  let current = path.dirname(filePath);
  const root = path.resolve(repoPath);
  while (current === root || current.startsWith(`${root}${path.sep}`)) {
    for (const marker of markers) {
      if (await fileExists(path.join(current, marker))) return current;
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return root;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(command: string, root: string, repoPath: string): Promise<string | null> {
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  let current = root;
  const stop = path.resolve(repoPath);
  while (current === stop || current.startsWith(`${stop}${path.sep}`)) {
    for (const suffix of suffixes) {
      const candidate = path.join(current, "node_modules", ".bin", `${command}${suffix}`);
      if (await executableExists(candidate)) return candidate;
    }
    if (current === stop) break;
    current = path.dirname(current);
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(entry, `${command}${suffix}`);
      if (await executableExists(candidate)) return candidate;
    }
  }
  return null;
}

async function findModuleFile(modulePath: string, root: string, repoPath: string): Promise<string | null> {
  let current = root;
  const stop = path.resolve(repoPath);
  while (current === stop || current.startsWith(`${stop}${path.sep}`)) {
    const candidate = path.join(current, "node_modules", modulePath);
    if (await fileExists(candidate)) return candidate;
    if (current === stop) break;
    current = path.dirname(current);
  }
  const fallback = path.join(process.cwd(), "node_modules", modulePath);
  return (await fileExists(fallback)) ? fallback : null;
}

async function resolveCustomExecutable(command: string, root: string, repoPath: string): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
    return (await executableExists(candidate)) ? candidate : null;
  }
  return findExecutable(trimmed, root, repoPath);
}

async function spawnForDefinition(
  definition: ServerDefinition,
  root: string,
  repoPath: string,
  filePath: string,
  preferences: WorkspaceEditorPreferences,
): Promise<LspSpawn | null> {
  const languagePreference = preferences.languages[definition.preferenceKey];
  if (languagePreference.mode !== "custom") return definition.spawn(root, repoPath, filePath);
  const command = await resolveCustomExecutable(languagePreference.customCommand, root, repoPath);
  return command ? definition.spawnCustom(command, root, repoPath, filePath) : null;
}

function editorPreferences(preferences?: AppPreferences | null): WorkspaceEditorPreferences {
  return preferences?.editor ?? DEFAULT_EDITOR_PREFERENCES;
}

function normalizeAbsolutePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function lspLanguageIdForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "typescript";
  if (extension === ".py" || extension === ".pyi") return "python";
  if (extension === ".rs") return "rust";
  return "plaintext";
}

const serverDefinitions: ServerDefinition[] = [
  {
    id: "typescript",
    label: "TypeScript",
    preferenceKey: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    rootMarkers: ["tsconfig.json", "package.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
    async spawn(root, repoPath) {
      const command = await findExecutable("typescript-language-server", root, repoPath);
      if (!command) return null;
      const tsserver = await findModuleFile("typescript/lib/tsserver.js", root, repoPath);
      return typescriptSpawn(command, tsserver);
    },
    async spawnCustom(command, root, repoPath) {
      const tsserver = await findModuleFile("typescript/lib/tsserver.js", root, repoPath);
      return typescriptSpawn(command, tsserver);
    },
  },
  {
    id: "pyright",
    label: "Python",
    preferenceKey: "python",
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"],
    async spawn(root, repoPath) {
      const venvBin = process.platform === "win32" ? "Scripts" : "bin";
      for (const venv of [process.env.VIRTUAL_ENV, path.join(root, ".venv"), path.join(root, "venv")].filter(Boolean)) {
        const candidate = path.join(venv!, venvBin, process.platform === "win32" ? "pyright-langserver.cmd" : "pyright-langserver");
        if (await executableExists(candidate)) return { command: candidate, args: ["--stdio"] };
      }
      const command = await findExecutable("pyright-langserver", root, repoPath);
      return command ? { command, args: ["--stdio"] } : null;
    },
    async spawnCustom(command) {
      return { command, args: ["--stdio"] };
    },
  },
  {
    id: "rust-analyzer",
    label: "Rust",
    preferenceKey: "rust",
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml", "Cargo.lock"],
    async spawn(root, repoPath) {
      const command = await findExecutable("rust-analyzer", root, repoPath);
      return command ? { command, args: [] } : null;
    },
    async spawnCustom(command) {
      return { command, args: [] };
    },
  },
];

function typescriptSpawn(command: string, tsserver: string | null): LspSpawn {
  return {
    command,
    args: ["--stdio"],
    initializationOptions: tsserver ? { tsserver: { path: tsserver } } : undefined,
  };
}
