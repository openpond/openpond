export type ComposerAction =
  | { type: "none" }
  | { type: "submit"; text: string }
  | { type: "cancel-or-exit" }
  | { type: "exit" }
  | { type: "rerender" };

export type ComposerState = {
  text: string;
  cursor: number;
  history: string[];
  historyIndex: number | null;
};

export function createComposer(): ComposerState {
  return { text: "", cursor: 0, history: [], historyIndex: null };
}

export function insertText(state: ComposerState, value: string): ComposerState {
  const before = state.text.slice(0, state.cursor);
  const after = state.text.slice(state.cursor);
  return {
    ...state,
    text: `${before}${value}${after}`,
    cursor: state.cursor + value.length,
    historyIndex: null,
  };
}

export function replaceComposerText(state: ComposerState, text: string): ComposerState {
  return { ...state, text, cursor: text.length };
}

export function submitComposer(state: ComposerState): { state: ComposerState; action: ComposerAction } {
  const text = state.text.trim();
  if (!text) return { state: { ...state, text: "", cursor: 0, historyIndex: null }, action: { type: "none" } };
  return {
    state: {
      text: "",
      cursor: 0,
      history: [...state.history.filter((item) => item !== text), text].slice(-100),
      historyIndex: null,
    },
    action: { type: "submit", text },
  };
}

export function handleComposerKey(state: ComposerState, key: string): { state: ComposerState; action: ComposerAction } {
  if (key === "ctrl+c") return { state, action: { type: "cancel-or-exit" } };
  if (key === "ctrl+d") return { state, action: state.text ? { type: "none" } : { type: "exit" } };
  if (key === "ctrl+l") return { state, action: { type: "rerender" } };
  if (key === "enter") return submitComposer(state);
  if (key === "alt+enter") return { state: insertText(state, "\n"), action: { type: "none" } };
  if (key === "backspace") {
    if (state.cursor <= 0) return { state, action: { type: "none" } };
    return {
      state: {
        ...state,
        text: `${state.text.slice(0, state.cursor - 1)}${state.text.slice(state.cursor)}`,
        cursor: state.cursor - 1,
      },
      action: { type: "none" },
    };
  }
  if (key === "delete") {
    if (state.cursor >= state.text.length) return { state, action: { type: "none" } };
    return {
      state: {
        ...state,
        text: `${state.text.slice(0, state.cursor)}${state.text.slice(state.cursor + 1)}`,
      },
      action: { type: "none" },
    };
  }
  if (key === "left") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, action: { type: "none" } };
  if (key === "right") {
    return { state: { ...state, cursor: Math.min(state.text.length, state.cursor + 1) }, action: { type: "none" } };
  }
  if (key === "home" || key === "ctrl+a") return { state: { ...state, cursor: 0 }, action: { type: "none" } };
  if (key === "end" || key === "ctrl+e") {
    return { state: { ...state, cursor: state.text.length }, action: { type: "none" } };
  }
  if (key === "ctrl+u") return { state: { ...state, text: state.text.slice(state.cursor), cursor: 0 }, action: { type: "none" } };
  if (key === "ctrl+k") return { state: { ...state, text: state.text.slice(0, state.cursor) }, action: { type: "none" } };
  if (key === "up") {
    if (state.history.length === 0) return { state, action: { type: "none" } };
    const nextIndex = state.historyIndex === null ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
    return { state: replaceComposerText({ ...state, historyIndex: nextIndex }, state.history[nextIndex] ?? ""), action: { type: "none" } };
  }
  if (key === "down") {
    if (state.historyIndex === null) return { state, action: { type: "none" } };
    const nextIndex = state.historyIndex + 1;
    if (nextIndex >= state.history.length) {
      return { state: { ...state, text: "", cursor: 0, historyIndex: null }, action: { type: "none" } };
    }
    return { state: replaceComposerText({ ...state, historyIndex: nextIndex }, state.history[nextIndex] ?? ""), action: { type: "none" } };
  }
  if (key.length > 0) return { state: insertText(state, key), action: { type: "none" } };
  return { state, action: { type: "none" } };
}
