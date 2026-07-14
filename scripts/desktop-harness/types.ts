export type DesktopHarnessLaunchMode = "none" | "isolated" | "attach" | "packaged";

export type DesktopScenarioMode = DesktopHarnessLaunchMode;

export type DesktopHarnessConnection = {
  serverUrl: string;
  token: string;
};

export type DesktopHarnessRuntimeEvent = Record<string, unknown> & {
  id?: string;
  sessionId?: string;
  turnId?: string;
  name?: string;
  action?: string;
  status?: string;
  data?: Record<string, unknown>;
  output?: string;
};

export type DesktopHarnessScenarioDefinition = {
  name: string;
  mode?: DesktopScenarioMode;
  timeoutMs?: number;
  run: (harness: DesktopHarness) => Promise<void> | void;
};

export type DesktopHarnessApi = {
  readonly connected: boolean;
  readonly connection: DesktopHarnessConnection | null;
  health<T = Record<string, unknown>>(): Promise<T>;
  bootstrap<T = Record<string, unknown>>(query?: string): Promise<T>;
  eventPage<T = Record<string, unknown>>(params?: {
    sessionId?: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<T>;
  usageRecords<T = Record<string, unknown>>(params?: { range?: string; limit?: number }): Promise<T>;
  createSession<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T>;
  createTurn<T = Record<string, unknown>>(sessionId: string, payload: Record<string, unknown>): Promise<T>;
  fetchJson<T = Record<string, unknown>>(
    pathOrUrl: string,
    init?: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | null | undefined> },
  ): Promise<T>;
};

export type DesktopHarnessRenderer = {
  readonly connected: boolean;
  evaluate<T>(expression: string): Promise<T>;
  text(): Promise<string>;
  assertText(text: string | RegExp, options?: { timeoutMs?: number; label?: string }): Promise<void>;
  selectSession(sessionId: string, options?: { timeoutMs?: number }): Promise<void>;
  submitComposer(prompt: string): Promise<void>;
  screenshot(name: string): Promise<string>;
  close(): void;
};

export type DesktopHarnessEvents = {
  waitFor(
    predicate: (event: DesktopHarnessRuntimeEvent) => boolean,
    label: string,
    options?: { timeoutMs?: number; sessionId?: string },
  ): Promise<DesktopHarnessRuntimeEvent>;
  waitForName(
    sessionId: string,
    name: string,
    options?: { timeoutMs?: number },
  ): Promise<DesktopHarnessRuntimeEvent>;
  waitForToolCompleted(
    sessionId: string,
    action: string,
    options?: { timeoutMs?: number },
  ): Promise<DesktopHarnessRuntimeEvent>;
  waitForSubagentSubmitted(
    sessionId: string,
    runId: string,
    options?: { timeoutMs?: number },
  ): Promise<DesktopHarnessRuntimeEvent>;
};

export type DesktopHarness = {
  readonly repoRoot: string;
  readonly artifactsDir: string;
  readonly launchMode: DesktopHarnessLaunchMode;
  readonly timeoutMs: number;
  readonly api: DesktopHarnessApi;
  readonly renderer: DesktopHarnessRenderer;
  readonly events: DesktopHarnessEvents;
  restart?(): Promise<void>;
  uniqueTitle(prefix: string): string;
  recordEvent(label: string): void;
  recordAssertion(name: string, value: unknown): void;
  recordMetadata(values: Record<string, unknown>): void;
  screenshot(name: string): Promise<string>;
};

export type DesktopHarnessScenarioReport = {
  name: string;
  ok: boolean;
  mode: DesktopHarnessLaunchMode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  events: string[];
  eventIds: string[];
  rendererAssertions: Record<string, unknown>;
  metadata: Record<string, unknown>;
  screenshots: string[];
  error?: {
    message: string;
    stack?: string;
  };
};

export type DesktopHarnessRunReport = {
  ok: boolean;
  generatedAt: string;
  mode: DesktopHarnessLaunchMode;
  repoRoot: string;
  artifactsDir: string;
  scenarios: DesktopHarnessScenarioReport[];
  timings: {
    totalMs: number;
  };
};

export type DesktopHarnessRunOptions = {
  scenarioPaths: string[];
  grep?: string | null;
  launchMode: DesktopHarnessLaunchMode;
  artifactsDir?: string | null;
  jsonPath?: string | null;
  timeoutMs?: number;
  keepHome?: boolean;
  appPath?: string | null;
  serverUrl?: string | null;
  token?: string | null;
  tokenFile?: string | null;
  devtoolsPort?: number | null;
  repoRoot?: string;
  now?: () => Date;
};
