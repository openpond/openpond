import type { Logger } from "@openpond/logging";
import { resolveLocalExecutablePath } from "@openpond/runtime/executable-search-path";

export const resolveDesktopExecutablePath = resolveLocalExecutablePath;

let executablePathReady: Promise<void> | null = null;

export async function initializeDesktopExecutablePath(logger: Logger): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  await (executablePathReady ??= resolveDesktopExecutablePath().then(searchPath => {
    process.env.PATH = searchPath;
    logger.info("desktop executable search path", { path: searchPath });
  }));
}
