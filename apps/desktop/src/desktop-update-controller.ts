import type { DesktopUpdateInstallKind, DesktopUpdateState } from "@openpond/contracts";

export interface DesktopUpdateDriver {
  check(): Promise<string | null>;
  download(onProgress: (percent: number) => void): Promise<void>;
  prepareInstall(): Promise<void>;
  install(): void;
  dispose(): void;
}

export class DesktopUpdateError extends Error {
  constructor(message: string, readonly retry?: "download" | "restart") { super(message); }
}

type ControllerOptions = {
  installedVersion: string;
  channel: "stable" | "nightly";
  installKind: DesktopUpdateInstallKind;
  driver: DesktopUpdateDriver | null;
  publish: (state: DesktopUpdateState) => void;
  confirmRestart: (hasRunningWork: boolean) => Promise<boolean>;
  shutdown: () => Promise<void>;
  recoverAfterShutdown: (error: unknown) => Promise<void>;
  logError: (operation: string, error: unknown) => void;
};

export class DesktopUpdateController {
  #state: DesktopUpdateState;
  #operation: Promise<DesktopUpdateState> | null = null;
  #ready = false;
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ControllerOptions) {
    this.#state = {
      revision: 0, status: options.driver ? "idle" : "unsupported",
      installedVersion: options.installedVersion, channel: options.channel,
      installKind: options.installKind, version: null, progress: null, error: null, retry: null,
    };
  }

  getState(): DesktopUpdateState { return { ...this.#state }; }

  start(): void {
    if (!this.options.driver || this.#timer || this.#stopped) return;
    void this.check();
    this.#timer = setInterval(() => { void this.check(); }, 60 * 60 * 1000);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.options.driver?.dispose();
  }

  check(): Promise<DesktopUpdateState> {
    if (this.#operation) return this.#operation;
    if (this.#ready || !this.options.driver || this.#stopped) return Promise.resolve(this.getState());
    return this.#run("check", async () => {
      this.#publish({ status: "checking", error: null, retry: null });
      const version = await this.options.driver!.check();
      this.#publish({ status: version ? "available" : "current", version, progress: null });
    });
  }

  download(): Promise<DesktopUpdateState> {
    if (this.#operation) return this.#operation;
    const canDownload = this.#state.status === "available" ||
      (this.#state.status === "error" && this.#state.retry === "download");
    if (!canDownload || !this.options.driver || this.#stopped || this.#ready || !this.#state.version) {
      return Promise.resolve(this.getState());
    }
    return this.#run("download", async () => {
      this.#publish({ status: "downloading", progress: 0, error: null, retry: null });
      await this.options.driver!.download((percent) => {
        if (this.#state.status !== "downloading" || !Number.isFinite(percent)) return;
        const progress = Math.max(0, Math.min(100, Math.floor(percent)));
        if (progress !== this.#state.progress) this.#publish({ progress });
      });
      this.#ready = true;
      this.#publish({ status: "ready", progress: 100 });
    });
  }

  restart(hasRunningWork: boolean): Promise<DesktopUpdateState> {
    if (this.#operation) return this.#operation;
    if (!this.#ready || !this.options.driver || this.#stopped) return Promise.resolve(this.getState());
    return this.#run("restart", async () => {
      this.#publish({ status: "restarting", error: null, retry: null });
      if (!(await this.options.confirmRestart(hasRunningWork))) {
        this.#publish({ status: "ready" });
        return;
      }
      // Authorization and filesystem checks happen while the old app is usable.
      await this.options.driver!.prepareInstall();
      try {
        await this.options.shutdown();
        this.options.driver!.install();
      } catch (error) {
        await this.options.recoverAfterShutdown(error);
        throw error;
      }
    });
  }

  #run(operation: "check" | "download" | "restart", action: () => Promise<void>): Promise<DesktopUpdateState> {
    const pending = Promise.resolve().then(action).catch((error: unknown) => {
      this.options.logError(operation, error);
      const retry = error instanceof DesktopUpdateError && error.retry ? error.retry : operation;
      if (retry === "download") this.#ready = false;
      const errorMessage = error instanceof DesktopUpdateError ? error.message : {
        check: "Could not check for updates. Check your connection and try again.",
        download: "Could not download the update. Check your connection and free disk space, then try again.",
        restart: "Could not install the update. Try again or install the latest release manually.",
      }[operation];
      this.#publish({ status: "error", error: errorMessage, retry });
    }).then(() => this.getState());
    this.#operation = pending;
    void pending.finally(() => { if (this.#operation === pending) this.#operation = null; });
    return pending;
  }

  #publish(patch: Partial<DesktopUpdateState>): void {
    if (this.#stopped) return;
    this.#state = { ...this.#state, ...patch, revision: this.#state.revision + 1 };
    this.options.publish(this.getState());
  }
}
