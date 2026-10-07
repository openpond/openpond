import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WorkspaceDocumentPreview } from "../components/workspace-diff/WorkspaceDocumentPreview";
import "../styles.css";
import "../styles/workspace-diff/workspace-diff-panel.css";

// Browser regression for a real lifecycle failure: StrictMode used to revoke
// the mounted PDF URL, breaking both its download link and viewer downloads.
// Also verify changed documents cannot download old bytes, and cleanup releases
// the resource. Open /test-pages/document-download-browser-proof.html in dev.
const host = document.getElementById("root")!;
const result = document.getElementById("result")!;
let root = createRoot(host);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pdf(text: string): string {
  const stream = `BT /F1 20 Tf 50 730 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let bytes = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((value, index) => { offsets.push(bytes.length); bytes += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = bytes.length;
  bytes += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  bytes += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return `${bytes}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function render(bytes: string, filename: string): Promise<string> {
  flushSync(() => root.render(<StrictMode><WorkspaceDocumentPreview path={filename} contentBase64={btoa(bytes)} /></StrictMode>));
  // Let the StrictMode setup → cleanup → setup replay and state update finish.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const anchor = host.querySelector<HTMLAnchorElement>("a[download]");
  const viewer = host.querySelector("iframe");
  assert(anchor && viewer, "The document and download control must be mounted.");
  assert(anchor.download === filename, "Download filename must follow the current document.");
  assert(anchor.href === viewer.src, "Header and PDF viewer must use the same live document.");
  const response = await fetch(anchor.href);
  assert(response.ok && await response.text() === bytes, "Mounted download URL must return the current document bytes after StrictMode replay.");
  assert(response.headers.get("Content-Type") === "application/pdf", "PDF downloads must retain their media type.");
  return anchor.href;
}

async function assertReleased(url: string) {
  const stillReadable = await fetch(url).then(response => response.ok, () => false);
  assert(!stillReadable, "Replaced or unmounted document URLs must be released.");
}

async function verify() {
  const firstBytes = pdf("First document");
  const first = await render(firstBytes, "first-document.pdf");
  assert(await render(firstBytes, "first-document.pdf") === first, "An unchanged document must retain its URL.");
  const secondBytes = pdf("Document downloads work");
  const second = await render(secondBytes, "download-check.pdf");
  assert(first !== second, "Changed documents must have distinct download URLs.");
  await assertReleased(first);
  flushSync(() => root.unmount());
  await assertReleased(second);
  root = createRoot(host);
  await render(secondBytes, "download-check.pdf");
  result.textContent = "PASS: StrictMode, current bytes, filename, PDF media type, replacement, unmount, and remount. Both download controls are ready to check below.";
  result.dataset.status = "passed";
}

void verify().catch(error => {
  result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  result.dataset.status = "failed";
});
