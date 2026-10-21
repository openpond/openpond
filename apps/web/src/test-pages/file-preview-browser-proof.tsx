import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeEvent, WorkspaceDiffFile } from "@openpond/contracts";
import { api } from "../api";
import { MarkdownText } from "../components/chat/MarkdownText";
import { FilePreview } from "../components/workspace-diff/WorkspaceFilePreview";
import type { WorkspaceDiffOpenFileRequest } from "../components/workspace-diff/workspace-diff-panel-model";
import { useChatFileOpen } from "../hooks/useChatFileOpen";
import { useFilePreviewRequests } from "../hooks/useFilePreviewRequests";
import { RuntimeEventStore } from "../lib/runtime-event-store";
import "../styles/theme.css";
import "../styles.css";

// Exercise the real Markdown -> file-open -> PDF renderer and live-event path.
// This in-memory file service deliberately rejects the URL-encoded filename.
const target = "/project/docs/Example report.pdf";
const text = "BT /F1 24 Tf 50 700 Td (Example report) Tj 0 -40 Td /F1 12 Tf (File links and live previews are connected.) Tj ET";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
let pdf = "%PDF-1.4\n";
const offsets = objects.map((object, i) => { const offset = pdf.length; pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
const xref = pdf.length;
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const file: WorkspaceDiffFile = { path: target, status: "", patch: "", additions: 0, deletions: 0, content: btoa(pdf), contentEncoding: "base64" };
const originalFile = api.workspaceFile;
api.workspaceFile = async (_connection, _workspace, requestedPath) => {
  if (requestedPath !== target) throw new Error(`Wrong filename: ${requestedPath}`);
  return file;
};
const store = new RuntimeEventStore();
const connection = { serverUrl: "http://127.0.0.1:17874", token: "fixture", platform: "linux" };
const ignore = () => {};
function request(sessionId: string): RuntimeEvent {
  return { id: crypto.randomUUID(), sessionId, name: "file.preview_requested", source: "server", timestamp: new Date().toISOString(),
    data: { target: "local", path: target, source: false } };
}
function Proof() {
  const [opened, setOpened] = useState<WorkspaceDiffOpenFileRequest | null>(null);
  const [count, setCount] = useState(0);
  const [sessionId, setSessionId] = useState("chat-a");
  const [error, setError] = useState("");
  const { handleOpenFileInSidebar } = useChatFileOpen({ conversationKey: sessionId, connection,
    handleOpenBrowserLink: ignore, activeWorkspaceAppId: null, rightSidebarUsesSandbox: false, rightSidebarSandboxId: null,
    onShowDiffPanel: () => setCount(value => value + 1), showToast: message => { setError(message); return 1; }, workspaceRootPath: "/project", setOpenDiffFileRequest: setOpened });
  useFilePreviewRequests(store, sessionId, handleOpenFileInSidebar);
  return <div style={{ height: "100vh", display: "grid", gridTemplateColumns: "minmax(320px, 1fr) minmax(480px, 1fr)" }}>
    <main style={{ padding: 32 }}>
      <h1>File preview</h1>
      <label>Preview PDF<input type="file" accept=".pdf" onChange={async event => {
        const selected = event.target.files?.[0];
        if (!selected) return;
        const bytes = new Uint8Array(await selected.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        file.content = btoa(binary);
        setOpened(null);
      }} /></label>
      <MarkdownText content={`[Example report.pdf](${encodeURI(target)})\n\nCodex citation: :codex-file-citation{path="${target}" purpose="output"}`} onOpenFileInSidebar={handleOpenFileInSidebar} />
      <p><button onClick={() => store.appendLive([request(sessionId)])}>Show file through tool event</button></p>
      <p><button onClick={() => store.append([request(sessionId)])}>Load history event</button></p>
      <p><button onClick={() => store.appendLive([request("another-chat")])}>Other chat event</button></p>
      <p><button onClick={() => { setSessionId(id => id === "chat-a" ? "chat-b" : "chat-a"); setOpened(null); }}>Switch chat</button></p>
      <p><button onClick={() => setOpened(null)}>Close preview</button></p>
      <output aria-label="Preview count">{count}</output>
      <p>Current chat: {sessionId}</p>
      <output aria-label="Fixture diagnostics">{error || opened?.error || "No errors"}</output>
    </main>
    <aside className="workspace-diff-panel" style={{ minWidth: 0, gridTemplateRows: "minmax(0, 1fr)" }}>
      {opened?.file && <FilePreview file={opened.file} loading={Boolean(opened.loading)} error={opened.error ?? null}
        loadFullFiles renderMarkdown wordWrap workspaceName="Preview proof" workspaceRootPath="/project" />}
    </aside>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><Proof /></StrictMode>);
import.meta.hot?.dispose(() => { root.unmount(); api.workspaceFile = originalFile; });
