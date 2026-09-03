import { runOpenPondServerCli } from "./cli.js";

export function runOpenPondServerCliEntrypoint(
  input: Parameters<typeof runOpenPondServerCli>[0],
): void {
  void runOpenPondServerCli(input).catch((error) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exit(1);
  });
}
