import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Diagnostic = {
  message: string;
  severity?: number;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source?: string;
  code?: string | number;
};

type PublishDiagnosticsParams = {
  uri: string;
  diagnostics: Diagnostic[];
};

type LspClientOptions = {
  rootDir: string;
  onDiagnostics?: (uri: string, diagnostics: Diagnostic[]) => void;
  onLog?: (message: string) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class LspClient {
  private readonly rootDir: string;
  private readonly onDiagnostics?: (
    uri: string,
    diagnostics: Diagnostic[]
  ) => void;
  private readonly onLog?: (message: string) => void;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private writer:
    | WritableStreamDefaultWriter<Uint8Array>
    | { write: (chunk: Uint8Array) => void }
    | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private openDocs = new Map<string, number>();
  private readyPromise: Promise<void> | null = null;
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(options: LspClientOptions) {
    this.rootDir = options.rootDir;
    this.onDiagnostics = options.onDiagnostics;
    this.onLog = options.onLog;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const binPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../node_modules/.bin/typescript-language-server"
    );
    try {
      // Long-lived stdio service; intentionally not a bounded captured command.
      this.proc = Bun.spawn([binPath, "--stdio"], {
        cwd: this.rootDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start LSP server";
      throw new Error(message);
    }

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error("LSP process streams unavailable");
    }

    const stdin = this.proc.stdin as unknown as {
      getWriter?: () => WritableStreamDefaultWriter<Uint8Array>;
      write?: (chunk: Uint8Array) => void;
    };
    if (stdin.getWriter) {
      this.writer = stdin.getWriter();
    } else if (stdin.write) {
      this.writer = { write: stdin.write.bind(stdin) };
    } else {
      throw new Error("LSP stdin is not writable");
    }
    this.readLoop(this.proc.stdout);
    this.readStderr(this.proc.stderr);

    this.readyPromise = this.initialize();
    await this.readyPromise;
  }

  stop() {
    try {
      if (this.writer && "close" in this.writer) {
        void (this.writer as WritableStreamDefaultWriter<Uint8Array>).close();
      }
    } catch {
      // ignore
    }
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
    this.proc = null;
    this.writer = null;
    this.pending.clear();
    this.openDocs.clear();
    this.readyPromise = null;
  }

  async syncFile(filePath: string, content: string): Promise<void> {
    await this.ready();
    const uri = pathToFileURL(filePath).href;
    const currentVersion = this.openDocs.get(uri);
    if (!currentVersion) {
      this.openDocs.set(uri, 1);
      await this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.getLanguageId(filePath),
          version: 1,
          text: content,
        },
      });
      return;
    }
    const nextVersion = currentVersion + 1;
    this.openDocs.set(uri, nextVersion);
    await this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: content }],
    });
  }

  private async ready(): Promise<void> {
    if (this.readyPromise) {
      await this.readyPromise;
    } else {
      throw new Error("LSP not started");
    }
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.rootDir).href;
    await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        workspace: {
          workspaceFolders: true,
        },
        textDocument: {
          synchronization: {
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
          },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    });
    await this.sendNotification("initialized", {});
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.sendMessage(payload);
    return response;
  }

  private async sendNotification(
    method: string,
    params: unknown
  ): Promise<void> {
    await this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  private async sendMessage(payload: Record<string, unknown>): Promise<void> {
    if (!this.writer) throw new Error("LSP writer unavailable");
    const body = JSON.stringify(payload);
    const bodyBytes = this.encoder.encode(body);
    const header = `Content-Length: ${bodyBytes.length}\r\n\r\n`;
    const headerBytes = this.encoder.encode(header);
    this.writer.write(headerBytes);
    this.writer.write(bodyBytes);
  }

  private async readLoop(stream: ReadableStream<Uint8Array> | null) {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          this.buffer = concatBytes(this.buffer, value as Uint8Array);
          this.processBuffer();
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "LSP read loop failed";
      this.onLog?.(message);
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array> | null) {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const text = this.decoder.decode(value);
        if (text.trim().length > 0) {
          this.onLog?.(text.trim());
        }
      }
    } catch {
      // ignore
    } finally {
      reader.releaseLock();
    }
  }

  private processBuffer() {
    while (true) {
      const headerEnd = findHeaderEnd(this.buffer);
      if (headerEnd === -1) return;
      const headerText = this.decoder.decode(this.buffer.slice(0, headerEnd));
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const bodyBytes = this.buffer.slice(bodyStart, bodyEnd);
      const bodyText = this.decoder.decode(bodyBytes);
      this.buffer = this.buffer.slice(bodyEnd);
      try {
        const message = JSON.parse(bodyText) as Record<string, unknown>;
        this.handleMessage(message);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "LSP parse error";
        this.onLog?.(msg);
      }
    }
  }

  private handleMessage(message: Record<string, unknown>) {
    if (typeof message.id === "number" && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const errorMessage =
          typeof (message.error as { message?: string }).message === "string"
            ? (message.error as { message?: string }).message
            : "LSP request failed";
        pending.reject(new Error(errorMessage));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as PublishDiagnosticsParams | undefined;
      if (params?.uri && Array.isArray(params.diagnostics)) {
        this.onDiagnostics?.(params.uri, params.diagnostics);
      }
      return;
    }
  }

  private getLanguageId(filePath: string): string {
    if (filePath.endsWith(".tsx")) return "typescriptreact";
    if (filePath.endsWith(".ts")) return "typescript";
    if (filePath.endsWith(".jsx")) return "javascriptreact";
    if (filePath.endsWith(".js")) return "javascript";
    return "plaintext";
  }
}

function findHeaderEnd(buffer: Uint8Array): number {
  for (let i = 0; i < buffer.length - 3; i += 1) {
    if (
      buffer[i] === 13 &&
      buffer[i + 1] === 10 &&
      buffer[i + 2] === 13 &&
      buffer[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

function concatBytes(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  const next = new Uint8Array(a.length + b.length);
  next.set(a, 0);
  next.set(b as Uint8Array, a.length);
  return next;
}
