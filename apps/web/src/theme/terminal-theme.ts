import type { ITheme } from "@xterm/xterm";
import { UI_THEME_COLORS } from "@openpond/contracts/ui-theme.generated";
import { getResolvedTheme } from "./appearance";

export function terminalTheme(): ITheme {
  const colors = UI_THEME_COLORS[getResolvedTheme()];
  return {
    background: colors["--surface-page"], foreground: colors["--text-primary"],
    cursor: colors["--text-primary"], cursorAccent: colors["--surface-page"],
    selectionBackground: colors["--selection-background"],
    black: colors["--terminal-black"], brightBlack: colors["--text-muted"],
    red: colors["--terminal-red"], brightRed: colors["--terminal-red"],
    green: colors["--terminal-green"], brightGreen: colors["--terminal-green"],
    yellow: colors["--terminal-yellow"], brightYellow: colors["--terminal-yellow"],
    blue: colors["--terminal-blue"], brightBlue: colors["--terminal-blue"],
    magenta: colors["--terminal-magenta"], brightMagenta: colors["--terminal-magenta"],
    cyan: colors["--terminal-cyan"], brightCyan: colors["--terminal-cyan"],
    white: colors["--terminal-white"], brightWhite: colors["--terminal-white"],
  };
}
