type WrapState = {
  lines: string[];
  current: string;
  trailingNewline: boolean;
};

type AssistantWrapEntry = {
  width: number;
  lastText: string;
  stableOffset: number;
  stableState: WrapState;
};

export class TranscriptLayoutCache {
  readonly #assistant = new Map<string, AssistantWrapEntry>();
  #processedCharacters = 0;

  renderAssistant(id: string, text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    let entry = this.#assistant.get(id);
    if (!entry || entry.width !== safeWidth || !text.startsWith(entry.lastText)) {
      entry = {
        width: safeWidth,
        lastText: "",
        stableOffset: 0,
        stableState: { lines: [], current: "", trailingNewline: false },
      };
      this.#assistant.set(id, entry);
    }

    const suffix = text.slice(entry.stableOffset);
    const stableLength = stablePrefixLength(suffix, safeWidth);
    if (stableLength > 0) {
      this.#process(entry.stableState, suffix.slice(0, stableLength), safeWidth);
      entry.stableOffset += stableLength;
    }
    const rendered = cloneState(entry.stableState);
    this.#process(rendered, text.slice(entry.stableOffset), safeWidth);
    entry.lastText = text;
    return finishState(rendered);
  }

  retain(itemIds: ReadonlySet<string>): void {
    for (const id of this.#assistant.keys()) {
      if (!itemIds.has(id)) this.#assistant.delete(id);
    }
  }

  stats(): { entries: number; processedCharacters: number } {
    return { entries: this.#assistant.size, processedCharacters: this.#processedCharacters };
  }

  #process(state: WrapState, input: string, width: number): void {
    this.#processedCharacters += input.length;
    for (const token of input.match(/\r\n|\r|\n|[^\S\r\n]+|\S+/g) ?? []) {
      if (/^\r?\n$|^\r$/.test(token)) processNewline(state);
      else processToken(state, token, width);
    }
  }
}

function stablePrefixLength(input: string, width: number): number {
  const matches = [...input.matchAll(/\r\n|\r|\n|[^\S\r\n]+|\S+/g)];
  if (matches.length === 0) return 0;
  const last = matches.at(-1)!;
  const lastStart = last.index ?? 0;
  const lastToken = last[0];
  if (/^\r?\n$|^\r$/.test(lastToken)) return input.length;
  if (/^\s+$/.test(lastToken)) return lastStart;
  const stableWordCharacters = Math.max(0, Math.floor((lastToken.length - 1) / width) * width);
  return lastStart + stableWordCharacters;
}

function processToken(state: WrapState, token: string, width: number): void {
  state.trailingNewline = false;
  if (visible(state.current) + visible(token) <= width) {
    state.current += token;
    return;
  }
  if (state.current.trimEnd()) state.lines.push(state.current.trimEnd());
  state.current = "";
  if (visible(token) > width) {
    const chars = Array.from(token);
    while (chars.length > width) state.lines.push(chars.splice(0, width).join(""));
    state.current = chars.join("");
  } else {
    state.current = token.trimStart();
  }
}

function processNewline(state: WrapState): void {
  state.lines.push(state.current.trimEnd());
  state.current = "";
  state.trailingNewline = true;
}

function finishState(state: WrapState): string[] {
  const lines = [...state.lines];
  if (state.current.trimEnd()) lines.push(state.current.trimEnd());
  else if (state.trailingNewline) lines.push("");
  return lines.length > 0 ? lines : [""];
}

function cloneState(state: WrapState): WrapState {
  return { lines: [...state.lines], current: state.current, trailingNewline: state.trailingNewline };
}

function visible(input: string): number {
  return Array.from(input).length;
}
