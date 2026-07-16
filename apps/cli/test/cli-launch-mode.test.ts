import { describe, expect, test } from "vitest";

import { parseArgs } from "../src/cli/common";
import { resolveCliTopLevelAction } from "../src/cli/top-level-action";

function action(argv: string[]) {
  const { command, options } = parseArgs(argv);
  return resolveCliTopLevelAction({ command, options });
}

describe("CLI top-level launch mode", () => {
  test("launches the web UI when no command is provided", () => {
    expect(action([])).toBe("ui");
    expect(action(["--port", "0"])).toBe("ui");
    expect(action(["--no-open"])).toBe("ui");
  });

  test("keeps the terminal UI available only through explicit selection", () => {
    expect(action(["--tui"])).toBe("tui");
    expect(action(["tui"])).toBe("command");
    expect(action(["interactive"])).toBe("command");
  });

  test("keeps informational flags ahead of default launch", () => {
    expect(action(["--help"])).toBe("help");
    expect(action(["--version"])).toBe("version");
    expect(action(["--check-update"])).toBe("check-update");
  });

  test("does not activate boolean flags explicitly set to false", () => {
    expect(action(["--tui=false"])).toBe("ui");
    expect(action(["--version=false"])).toBe("ui");
    expect(action(["--help=false"])).toBe("ui");
  });

  test("routes named commands through the registry", () => {
    expect(action(["serve"])).toBe("command");
    expect(action(["ui", "--no-open"])).toBe("command");
    expect(action(["health"])).toBe("command");
  });
});
