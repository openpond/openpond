import { expect, test } from "vitest";
import { nativeLoginCodeInput, readNativeLoginOutput } from "../apps/web/src/components/terminal/native-login-output";

const url = "https://claude.ai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge&redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback";

// This is a navigation boundary: partial output or unrelated links must never
// become an authorization action, while split/colored CLI output must work.
test("extracts a complete Claude authorization handoff across stream chunks", () => {
  const source = `\x1b[32mOpen this link:\x1b[0m\r\n${url}\r\nPaste code here if prompted: `;
  let output = "";
  for (const character of source.slice(0, source.indexOf(url) + url.length)) {
    output += character;
    expect(readNativeLoginOutput(output).url).toBeNull();
  }
  output += source.slice(output.length);
  expect(readNativeLoginOutput(output)).toEqual({ url, needsCode: true, needsEnter: false });
  expect(readNativeLoginOutput(`${output}\nLogin successful. Press Enter to continue.`).needsEnter).toBe(true);
});

test.each([
  url.replace("claude.ai", "claude.ai.attacker.test"),
  url.replace("claude.ai", "claude.ai@attacker.test"),
  url.replace("https:", "http:"),
  url.replace("claude.ai", "claude.ai:444"),
  url.replace("/oauth/authorize", "/redirect"),
  "https://claude.ai/help",
])("rejects unrelated or deceptive terminal links: %s", candidate => {
  expect(readNativeLoginOutput(`${candidate}\n`).url).toBeNull();
});

// A browser code goes into a real PTY. Pasted newlines/control characters
// must not become additional commands or terminal actions.
test("submits only one code line and preserves OAuth code/state separators", () => {
  expect(nativeLoginCodeInput(" code#state ")).toBe("code#state\r");
  for (const value of ["", "code\ncommand", "code\rcommand", "code\x1b[A", "a".repeat(4097)]) {
    expect(nativeLoginCodeInput(value)).toBeNull();
  }
});
