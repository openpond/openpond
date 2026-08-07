#!/usr/bin/env node

import { createOpenPondAppServer } from "./app-server-runtime.js";
import { runOpenPondAppServerCli } from "./cli.js";
import { isCliEntrypoint } from "./utils.js";

export { createOpenPondAppServer } from "./app-server-runtime.js";

if (isCliEntrypoint(import.meta.url)) {
  void runOpenPondAppServerCli(createOpenPondAppServer).catch((error) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exit(1);
  });
}
