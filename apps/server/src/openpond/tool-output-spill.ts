const DEFAULT_INLINE_TOOL_OUTPUT_CHARS = 8_000;

export type ToolOutputSpill = {
  resourceRef: string;
  originalChars: number;
  returnedChars: number;
  omittedChars: number;
};

export function toolOutputResourceRef(callId: string): string {
  return `tool-output:${encodeURIComponent(callId)}`;
}

export function toolOutputSpillForModel(input: {
  output: string;
  callId: string;
  maxChars?: number;
}): { output: string; spill: ToolOutputSpill | null } {
  const maxChars = Math.max(512, Math.floor(input.maxChars ?? DEFAULT_INLINE_TOOL_OUTPUT_CHARS));
  if (input.output.length <= maxChars) return { output: input.output, spill: null };

  const headChars = Math.ceil(maxChars / 2);
  const tailChars = Math.max(1, maxChars - headChars);
  const resourceRef = toolOutputResourceRef(input.callId);
  const returnedChars = headChars + tailChars;
  return {
    output: [
      input.output.slice(0, headChars),
      `[tool output spilled: ${input.output.length - returnedChars} characters omitted; read ${resourceRef} with offsetBytes to page the durable output]`,
      input.output.slice(-tailChars),
    ].join("\n\n"),
    spill: {
      resourceRef,
      originalChars: input.output.length,
      returnedChars,
      omittedChars: input.output.length - returnedChars,
    },
  };
}

export function toolOutputPreviewForCompaction(input: {
  output: string;
  resourceRef: string;
  maxChars?: number;
}): string {
  const result = toolOutputSpillForModel({
    output: input.output,
    callId: input.resourceRef.replace(/^tool-output:/, ""),
    maxChars: input.maxChars ?? 4_000,
  });
  if (!result.spill) return input.output;
  return result.output.replace(result.spill.resourceRef, input.resourceRef);
}
