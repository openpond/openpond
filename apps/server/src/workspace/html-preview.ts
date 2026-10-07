import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { expandLocalHomePath } from "./local-output-files.js";

const mime: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".csv": "text/csv", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".wasm": "application/wasm",
};
function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Separate origin, capability-scoped static files. Never serves the app's API or credentials. */
export function createHtmlPreviewService() {
  const grants = new Map<string, { read: (assetPath: string) => Promise<Buffer>; expires: number }>();
  let server: Server | null = null;
  let starting: Promise<number> | null = null;
  async function start(): Promise<number> {
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      server = createServer((request, response) => {
        void (async () => {
          const port = (server!.address() as { port: number }).port;
          if (request.headers.host !== `127.0.0.1:${port}` || !["GET", "HEAD"].includes(request.method ?? "")) throw new Error("Unavailable");
          const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
          const [token, ...segments] = url.pathname.slice(1).split("/").map(decodeURIComponent);
          const grant = grants.get(token!);
          if (!grant || grant.expires < Date.now() || segments.some((part) => part.startsWith(".") || /[\\/\0]/.test(part))) throw new Error("Unavailable");
          const assetPath = segments.join("/");
          const type = mime[path.posix.extname(assetPath).toLowerCase()];
          if (!type) throw new Error("Unavailable");
          const bytes = await grant.read(assetPath);
          if (bytes.length > 128 * 1024 * 1024) throw new Error("Unavailable");
          response.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
          response.end(request.method === "HEAD" ? null : bytes);
        })().catch(() => { response.writeHead(404); response.end("Preview file unavailable"); });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server!.unref(); resolve((server!.address() as { port: number }).port); });
    });
    try { return await starting; } catch (error) { starting = null; throw error; }
  }
  async function grantUrl(entryPath: string, read: (assetPath: string) => Promise<Buffer>, suffix = "") {
    for (const [key, grant] of grants) if (grant.expires < Date.now()) grants.delete(key);
    if (grants.size >= 64) grants.delete(grants.keys().next().value!);
    const token = randomBytes(24).toString("hex");
    const port = await start();
    grants.set(token, { read, expires: Date.now() + 24 * 60 * 60 * 1000 });
    return { url: `http://127.0.0.1:${port}/${token}/${entryPath.split("/").map(encodeURIComponent).join("/")}${suffix}` };
  }
  return {
    async open(repoPath: string, input: string, allowOutside: boolean): Promise<{ url: string }> {
      const suffixIndex = input.search(/[?#]/);
      const filePath = suffixIndex < 0 ? input : input.slice(0, suffixIndex);
      const suffix = suffixIndex < 0 ? "" : input.slice(suffixIndex);
      if (!/\.html?$/i.test(filePath)) throw new Error("An HTML file is required");
      const expanded = expandLocalHomePath(filePath);
      const repo = await fs.realpath(repoPath);
      const file = await fs.realpath(path.resolve(repo, expanded));
      const explicit = path.isAbsolute(expanded);
      if (!contained(repo, file) && (!allowOutside || !explicit)) throw new Error("File is outside the workspace");
      const root = contained(repo, file) ? repo : path.dirname(file);
      if (path.relative(root, file).split(path.sep).some((part) => part.startsWith(".")) || !(await fs.stat(file)).isFile()) throw new Error("Preview file unavailable");
      return grantUrl(path.relative(root, file).split(path.sep).join("/"), async (assetPath) => {
        const target = await fs.realpath(path.join(root, assetPath));
        const stat = await fs.stat(target);
        if (!contained(root, target) || path.relative(root, target).split(path.sep).some((part) => part.startsWith(".")) || !stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error("Unavailable");
        return fs.readFile(target);
      }, suffix);
    },
    async openContent(name: string, content: string) {
      if (!/\.html?$/i.test(name) || Buffer.byteLength(content) > 20 * 1024 * 1024) throw new Error("Invalid HTML preview");
      const filename = path.basename(name);
      return grantUrl(filename, async (assetPath) => {
        if (assetPath !== filename) throw new Error("Unavailable");
        return Buffer.from(content);
      });
    },
    async openRemote(entryPath: string, read: (assetPath: string) => Promise<Buffer>) {
      if (path.posix.isAbsolute(entryPath) || !/\.html?$/i.test(entryPath) || entryPath.split("/").some((part) => part.startsWith("."))) throw new Error("Invalid HTML preview");
      // Validate existence before opening the browser. Subsequent assets are
      // fetched within this same directory and never expose remote credentials.
      await read(entryPath);
      return grantUrl(entryPath, read);
    },
    async close() { grants.clear(); server?.closeAllConnections(); await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); server = null; starting = null; },
  };
}
