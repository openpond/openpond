import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { WorkspaceLspActionResponse, WorkspaceLspDiagnostic } from "@openpond/contracts";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoFileEditorProps = {
  diagnostics?: WorkspaceLspDiagnostic[];
  filePath: string;
  onChange: (value: string) => void;
  onLspAction?: (input: WorkspaceMonacoLspActionInput) => Promise<WorkspaceLspActionResponse>;
  onSave: () => void;
  value: string;
  wordWrap: boolean;
};

export type WorkspaceMonacoLspActionInput = {
  operation: WorkspaceLspActionResponse["operation"];
  path: string;
  content?: string;
  line?: number;
  character?: number;
};

export type WorkspaceMonacoEditorHandle = {
  focus: () => void;
  redo: () => void;
  save: () => void;
  undo: () => void;
};

type MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) => Worker;
};

const globalWithMonaco = globalThis as typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironment;
};

let themeDefined = false;
const languageSetupPromises = new Map<string, Promise<void>>();

configureMonacoEnvironment();
defineOpenPondTheme();

const WorkspaceMonacoEditor = forwardRef<WorkspaceMonacoEditorHandle, MonacoFileEditorProps>(
function WorkspaceMonacoEditor({
  diagnostics = [],
  filePath,
  onChange,
  onLspAction,
  onSave,
  value,
  wordWrap,
}: MonacoFileEditorProps, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const applyingExternalValueRef = useRef(false);
  const latestValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onLspActionRef = useRef(onLspAction);
  const onSaveRef = useRef(onSave);
  const [activeModelKey, setActiveModelKey] = useState<string | null>(null);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onLspActionRef.current = onLspAction;
  }, [onLspAction]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    redo: () => editorRef.current?.trigger("editor-controls", "redo", null),
    save: () => onSaveRef.current(),
    undo: () => editorRef.current?.trigger("editor-controls", "undo", null),
  }), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let disposed = false;
    let changeDisposable: monaco.IDisposable | null = null;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let model: monaco.editor.ITextModel | null = null;
    const requestedLanguageId = monacoLanguageForPath(filePath);
    let modelKey = `${filePath}\0${requestedLanguageId}`;

    void ensureMonacoLanguage(requestedLanguageId).catch(() => {
      modelKey = `${filePath}\0plaintext`;
      return undefined;
    }).then(() => {
      if (disposed) return;
      const languageId = modelKey.endsWith("\0plaintext") ? "plaintext" : requestedLanguageId;
      model = monaco.editor.createModel(
        latestValueRef.current,
        languageId,
        monaco.Uri.parse(`file:///${filePath.split("/").map(encodeURIComponent).join("/")}`),
      );
      editor = monaco.editor.create(container, {
        automaticLayout: true,
        contextmenu: true,
        cursorBlinking: "smooth",
        detectIndentation: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontLigatures: false,
        fontSize: 12,
        lineDecorationsWidth: 6,
        lineHeight: 18,
        lineNumbersMinChars: 3,
        minimap: { enabled: false },
        model,
        overviewRulerBorder: false,
        padding: { top: 0, bottom: 16 },
        renderFinalNewline: "dimmed",
        renderLineHighlight: "line",
        renderWhitespace: "selection",
        roundedSelection: false,
        scrollBeyondLastLine: false,
        scrollbar: {
          alwaysConsumeMouseWheel: false,
          horizontalScrollbarSize: 9,
          verticalScrollbarSize: 9,
        },
        smoothScrolling: true,
        tabSize: 2,
        theme: "openpond-dark",
        wordWrap: wordWrap ? "on" : "off",
      });

      changeDisposable = model.onDidChangeContent(() => {
        if (applyingExternalValueRef.current || !model) return;
        onChangeRef.current(model.getValue());
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current();
      });

      editorRef.current = editor;
      modelRef.current = model;
      setActiveModelKey(modelKey);

      window.requestAnimationFrame(() => {
        editor?.focus();
        editor?.layout();
      });
    });

    return () => {
      disposed = true;
      changeDisposable?.dispose();
      if (model) monaco.editor.setModelMarkers(model, "openpond-lsp", []);
      editor?.dispose();
      model?.dispose();
      editorRef.current = null;
      modelRef.current = null;
      setActiveModelKey((current) => current === modelKey ? null : current);
    };
  }, [filePath]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "openpond-lsp",
      diagnostics.map((diagnostic) => diagnosticToMarker(diagnostic)),
    );
  }, [activeModelKey, diagnostics, filePath]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return undefined;
    const language = model.getLanguageId();
    const modelUri = model.uri.toString();

    const disposables = [
      monaco.languages.registerHoverProvider(language, {
        provideHover: async (targetModel, position) => {
          if (targetModel.uri.toString() !== modelUri) return null;
          const response = await requestLspAction(onLspActionRef.current, {
            operation: "hover",
            path: filePath,
            content: targetModel.getValue(),
            line: position.lineNumber - 1,
            character: position.column - 1,
          });
          const contents = arrayFromUnknown(response?.results).flatMap((result) => hoverContents(result));
          return contents.length > 0 ? { contents } : null;
        },
      }),
      monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: async (targetModel, position) => {
          if (targetModel.uri.toString() !== modelUri) return null;
          const response = await requestLspAction(onLspActionRef.current, {
            operation: "definition",
            path: filePath,
            content: targetModel.getValue(),
            line: position.lineNumber - 1,
            character: position.column - 1,
          });
          return arrayFromUnknown(response?.results).map(locationFromLsp).filter(Boolean) as monaco.languages.Definition;
        },
      }),
      monaco.languages.registerReferenceProvider(language, {
        provideReferences: async (targetModel, position) => {
          if (targetModel.uri.toString() !== modelUri) return null;
          const response = await requestLspAction(onLspActionRef.current, {
            operation: "references",
            path: filePath,
            content: targetModel.getValue(),
            line: position.lineNumber - 1,
            character: position.column - 1,
          });
          return arrayFromUnknown(response?.results).map(locationFromLsp).filter(Boolean) as monaco.languages.Location[];
        },
      }),
      monaco.languages.registerDocumentSymbolProvider(language, {
        provideDocumentSymbols: async (targetModel) => {
          if (targetModel.uri.toString() !== modelUri) return null;
          const response = await requestLspAction(onLspActionRef.current, {
            operation: "documentSymbol",
            path: filePath,
            content: targetModel.getValue(),
          });
          return arrayFromUnknown(response?.results).map(documentSymbolFromLsp).filter(Boolean) as monaco.languages.DocumentSymbol[];
        },
      }),
    ];

    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [activeModelKey, filePath]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      wordWrap: wordWrap ? "on" : "off",
    });
  }, [wordWrap]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.getValue() === value) return;
    applyingExternalValueRef.current = true;
    model.setValue(value);
    applyingExternalValueRef.current = false;
  }, [value]);

  return <div className="workspace-file-editor" ref={containerRef} />;
});

export default WorkspaceMonacoEditor;

function configureMonacoEnvironment() {
  if (globalWithMonaco.MonacoEnvironment) return;
  globalWithMonaco.MonacoEnvironment = {
    getWorker: (_moduleId, label) => {
      if (label === "json") return new JsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new CssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
      if (label === "typescript" || label === "javascript") return new TsWorker();
      return new EditorWorker();
    },
  };
}

function defineOpenPondTheme() {
  if (themeDefined) return;
  themeDefined = true;
  monaco.editor.defineTheme("openpond-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6f7f73" },
      { token: "keyword", foreground: "c792ea" },
      { token: "string", foreground: "c3e88d" },
      { token: "number", foreground: "f78c6c" },
      { token: "type", foreground: "82aaff" },
      { token: "delimiter", foreground: "89ddff" },
    ],
    colors: {
      "editor.background": "#0f0f0f",
      "editor.foreground": "#d8d8d8",
      "editor.lineHighlightBackground": "#181818",
      "editorLineNumber.foreground": "#707070",
      "editorLineNumber.activeForeground": "#c8c8c8",
      "editorCursor.foreground": "#f1f1f1",
      "editor.selectionBackground": "#315a8c",
      "editor.inactiveSelectionBackground": "#26384f",
      "editorIndentGuide.background1": "#242424",
      "editorIndentGuide.activeBackground1": "#3a3a3a",
      "scrollbarSlider.background": "#ffffff33",
      "scrollbarSlider.hoverBackground": "#ffffff55",
      "scrollbarSlider.activeBackground": "#ffffff66",
    },
  });
}

function ensureMonacoLanguage(languageId: string): Promise<void> {
  if (languageId === "plaintext") return Promise.resolve();
  const existing = languageSetupPromises.get(languageId);
  if (existing) return existing;
  const setup = loadMonacoLanguage(languageId).catch((error) => {
    languageSetupPromises.delete(languageId);
    throw error;
  });
  languageSetupPromises.set(languageId, setup);
  return setup;
}

async function loadMonacoLanguage(languageId: string): Promise<void> {
  if (languageId === "javascript" || languageId === "typescript") {
    await import("monaco-editor/esm/vs/language/typescript/monaco.contribution");
    return;
  }
  if (languageId === "css") {
    await import("monaco-editor/esm/vs/language/css/monaco.contribution");
    return;
  }
  if (languageId === "html") {
    await import("monaco-editor/esm/vs/language/html/monaco.contribution");
    return;
  }
  if (languageId === "json") {
    await import("monaco-editor/esm/vs/language/json/monaco.contribution");
    return;
  }
  if (languageId === "markdown") {
    const { conf, language } = await import("monaco-editor/esm/vs/basic-languages/markdown/markdown");
    registerMonarchLanguage({
      id: "markdown",
      extensions: [".md", ".markdown", ".mdx"],
      aliases: ["Markdown", "markdown"],
      conf,
      language,
    });
    return;
  }
  if (languageId === "python") {
    const { conf, language } = await import("monaco-editor/esm/vs/basic-languages/python/python");
    registerMonarchLanguage({
      id: "python",
      extensions: [".py"],
      aliases: ["Python", "python", "py"],
      conf,
      language,
    });
    return;
  }
  if (languageId === "shell") {
    const { conf, language } = await import("monaco-editor/esm/vs/basic-languages/shell/shell");
    registerMonarchLanguage({
      id: "shell",
      extensions: [".sh", ".bash", ".zsh"],
      aliases: ["Shell", "shell", "bash"],
      conf,
      language,
    });
    return;
  }
  if (languageId === "yaml") {
    const { conf, language } = await import("monaco-editor/esm/vs/basic-languages/yaml/yaml");
    registerMonarchLanguage({
      id: "yaml",
      extensions: [".yaml", ".yml"],
      aliases: ["YAML", "yaml"],
      conf,
      language,
    });
    return;
  }
  if (languageId === "dockerfile") {
    const { conf, language } = await import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile");
    registerMonarchLanguage({
      id: "dockerfile",
      extensions: [],
      aliases: ["Dockerfile", "dockerfile"],
      conf,
      language,
    });
  }
}

function registerMonarchLanguage({
  aliases,
  conf,
  extensions,
  id,
  language,
}: {
  aliases: string[];
  conf: monaco.languages.LanguageConfiguration;
  extensions: string[];
  id: string;
  language: monaco.languages.IMonarchLanguage;
}) {
  if (monaco.languages.getLanguages().some((registered) => registered.id === id)) return;
  monaco.languages.register({ id, aliases, extensions });
  monaco.languages.setLanguageConfiguration(id, conf);
  monaco.languages.setMonarchTokensProvider(id, language);
}

function monacoLanguageForPath(filePath: string): string {
  const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (fileName === "dockerfile") return "dockerfile";
  if (fileName === "readme" || fileName === "readme.md") return "markdown";
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  switch (extension) {
    case "cjs":
    case "cts":
    case "mjs":
    case "mts":
    case "js":
    case "jsx":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "css":
      return "css";
    case "html":
      return "html";
    case "json":
      return "json";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "py":
      return "python";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}

async function requestLspAction(
  handler: MonacoFileEditorProps["onLspAction"],
  input: WorkspaceMonacoLspActionInput,
): Promise<WorkspaceLspActionResponse | null> {
  if (!handler) return null;
  try {
    return await handler(input);
  } catch {
    return null;
  }
}

function diagnosticToMarker(diagnostic: WorkspaceLspDiagnostic): monaco.editor.IMarkerData {
  return {
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: Math.max(diagnostic.range.end.character + 1, diagnostic.range.start.character + 2),
    message: diagnostic.message,
    severity: markerSeverity(diagnostic.severity),
    source: diagnostic.source ?? undefined,
    code: diagnostic.code ?? undefined,
  };
}

function markerSeverity(severity: WorkspaceLspDiagnostic["severity"]): monaco.MarkerSeverity {
  if (severity === "error") return monaco.MarkerSeverity.Error;
  if (severity === "warning") return monaco.MarkerSeverity.Warning;
  if (severity === "info") return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}

function hoverContents(value: unknown): monaco.IMarkdownString[] {
  const record = asRecord(value);
  const contents = record?.contents ?? value;
  const items = Array.isArray(contents) ? contents : [contents];
  return items.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [{ value: item }] : [];
    const itemRecord = asRecord(item);
    if (!itemRecord) return [];
    if (typeof itemRecord.value === "string" && typeof itemRecord.language === "string") {
      return [{ value: `\`\`\`${itemRecord.language}\n${itemRecord.value}\n\`\`\`` }];
    }
    if (typeof itemRecord.value === "string") return [{ value: itemRecord.value }];
    return [];
  });
}

function locationFromLsp(value: unknown): monaco.languages.Location | monaco.languages.LocationLink | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.targetUri === "string") {
    const targetRange = rangeFromLsp(record.targetSelectionRange ?? record.targetRange);
    const originSelectionRange = rangeFromLsp(record.originSelectionRange);
    if (!targetRange) return null;
    return {
      originSelectionRange: originSelectionRange ?? undefined,
      range: rangeFromLsp(record.targetRange) ?? targetRange,
      targetSelectionRange: targetRange,
      uri: monaco.Uri.parse(record.targetUri),
    };
  }
  if (typeof record.uri !== "string") return null;
  const range = rangeFromLsp(record.range);
  if (!range) return null;
  return {
    range,
    uri: monaco.Uri.parse(record.uri),
  };
}

function documentSymbolFromLsp(value: unknown): monaco.languages.DocumentSymbol | null {
  const record = asRecord(value);
  if (!record || typeof record.name !== "string") return null;
  const range = rangeFromLsp(record.range ?? asRecord(record.location)?.range);
  const selectionRange = rangeFromLsp(record.selectionRange ?? record.range ?? asRecord(record.location)?.range);
  if (!range || !selectionRange) return null;
  const children = Array.isArray(record.children)
    ? record.children.map(documentSymbolFromLsp).filter(Boolean) as monaco.languages.DocumentSymbol[]
    : [];
  return {
    name: record.name,
    detail: typeof record.detail === "string" ? record.detail : "",
    kind: symbolKind(record.kind),
    range,
    selectionRange,
    tags: [],
    children,
  };
}

function rangeFromLsp(value: unknown): monaco.Range | null {
  const record = asRecord(value);
  const start = asRecord(record?.start);
  const end = asRecord(record?.end);
  if (!start || !end) return null;
  return new monaco.Range(
    numberOrZero(start.line) + 1,
    numberOrZero(start.character) + 1,
    numberOrZero(end.line) + 1,
    numberOrZero(end.character) + 1,
  );
}

function symbolKind(value: unknown): monaco.languages.SymbolKind {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value) - 1) as monaco.languages.SymbolKind
    : monaco.languages.SymbolKind.Variable;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function arrayFromUnknown(value: unknown): unknown[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
