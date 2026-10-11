import { parse, type Node } from "acorn";

type Ast = Node & Record<string, unknown>;
const ast = (value: unknown): Ast => {
  if (!value || typeof value !== "object" || !("type" in value)) throw new Error("connected_command_syntax_unsupported");
  return value as Ast;
};
function member(value: unknown, object: string, property: string) {
  const node = ast(value);
  return node.type === "MemberExpression" && !node.computed && !node.optional
    && ast(node.object).type === "Identifier" && ast(node.object).name === object
    && ast(node.property).type === "Identifier" && ast(node.property).name === property;
}

/** Interpret recorded syntax, never execute source code. Only sequential static
 * exec_command calls have an unambiguous correspondence with retained results. */
export function recordedCodexCommands(source: string) {
  if (source.length > 128_000) throw new Error("connected_command_syntax_limit");
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const commands: Array<{ cmd: string; maxOutputTokens: number; cwd: string | null }> = [];
  for (const statement of program.body) {
    const outer = ast(ast(statement).expression);
    const args = outer.arguments as unknown[];
    if (statement.type !== "ExpressionStatement" || outer.type !== "CallExpression" || outer.optional
      || ast(outer.callee).type !== "Identifier" || ast(outer.callee).name !== "text" || args.length !== 1)
      throw new Error("connected_command_syntax_unsupported");
    const awaited = ast(args[0]);
    const call = ast(awaited.argument);
    const innerArgs = call.arguments as unknown[];
    if (awaited.type !== "AwaitExpression" || call.type !== "CallExpression" || call.optional
      || !member(call.callee, "tools", "exec_command") || innerArgs.length !== 1)
      throw new Error("connected_command_syntax_unsupported");
    const object = ast(innerArgs[0]);
    if (object.type !== "ObjectExpression") throw new Error("connected_command_syntax_unsupported");
    const values = new Map<string, unknown>();
    for (const raw of object.properties as unknown[]) {
      const property = ast(raw), key = ast(property.key), value = ast(property.value);
      const name = key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : null;
      if (property.type !== "Property" || property.computed || property.method || property.shorthand || property.kind !== "init"
        || typeof name !== "string" || values.has(name) || value.type !== "Literal"
        || !["cmd", "workdir", "max_output_tokens", "yield_time_ms"].includes(name))
        throw new Error("connected_command_syntax_unsupported");
      values.set(name, value.value);
    }
    const cmd = values.get("cmd"), budget = values.get("max_output_tokens"), cwd = values.get("workdir");
    if (typeof cmd !== "string" || !cmd.length || cmd.length > 16_000
      || typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0 || budget > 100_000
      || cwd !== undefined && typeof cwd !== "string") throw new Error("connected_command_syntax_unsupported");
    commands.push({ cmd, maxOutputTokens: budget, cwd: typeof cwd === "string" ? cwd : null });
  }
  if (!commands.length || commands.length > 20) throw new Error("connected_command_syntax_unsupported");
  return commands;
}

/** This deliberately bounded read-only prefix establishes that no earlier
 * recorded command modified the checkout before the status observation. */
export function isRecordedReadOnlyInventory(cmd: string) {
  return cmd === "pwd" || /^pwd && rg --files(?: -g '[a-zA-Z0-9_.*\/-]+')*$/.test(cmd);
}

export function recordedCodexCommandResults(value: unknown, count: number) {
  if (!Array.isArray(value) || value.length !== count + 1) throw new Error("connected_command_results_incomplete");
  const blocks = value.map(block => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "input_text"
      || !("text" in block) || typeof block.text !== "string") throw new Error("connected_command_results_incomplete");
    return block.text;
  });
  if (!/^Script completed\nWall time [0-9.]+ seconds\nOutput:\n$/.test(blocks[0]!))
    throw new Error("connected_command_results_incomplete");
  return blocks.slice(1).map(text => {
    const result: unknown = JSON.parse(text);
    if (!result || typeof result !== "object" || !("exit_code" in result) || result.exit_code !== 0
      || "session_id" in result || !("output" in result) || typeof result.output !== "string"
      || !("original_token_count" in result) || typeof result.original_token_count !== "number"
      || !Number.isSafeInteger(result.original_token_count) || result.original_token_count < 0)
      throw new Error("connected_command_results_incomplete");
    return { output: result.output, originalTokenCount: result.original_token_count };
  });
}
