import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const viteRequire = createRequire(require.resolve("vite/package.json"));
const postcss = viteRequire("postcss");
const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
// These are owned exceptions, not places to put general UI colors.
const exceptions = new Map([
  ["apps/web/src/styles/theme.css", "Canonical theme palette"],
  ["apps/web/src/components/workspace-diff/WorkspaceMonacoEditor.tsx", "Monaco migration explicitly deferred"],
  ["apps/desktop/src/desktop-browser-harness-dom.ts", "High-contrast cursor overlay over arbitrary external pages"],
]);
const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--",
  "apps/web/src", "apps/web/public/appearance.js", "apps/desktop/src", "packages/contracts/src/html-visuals.ts",
  "packages/contracts/src/html-visual-document.ts"], { cwd: root, encoding: "utf8" }).trim().split("\n"))]
  .filter(file => /\.(css|[jt]sx?)$/.test(file) && !/\.(test|spec)\.|\/test-pages\//.test(file) && !exceptions.has(file));
const errors = [];
const literal = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^)]*\)/gi;
const oldVariable = /var\(\s*--(?:bg|panel|panel-soft|panel-hover|text|muted|muted-strong|border|cyan|blue|orange|danger|warning|success|accent)\s*[,)]/g;
function check(value, file, line, css = false) {
  for (const match of value.matchAll(literal)) {
    // Theme-dependent generated chart hues keep saturation/lightness in the palette.
    if (match[0].startsWith("hsl(") && match[0].includes("var(--chart-")) continue;
    errors.push(`${file}:${line}: unowned color ${match[0]}`);
  }
  if (css) {
    const withoutVars = value.replace(/var\([^)]*\)/g, "");
    if (/(?<![\w-])(?:white|black|red|blue|green|gray|grey|yellow|orange|purple|pink)(?![\w-])/i.test(withoutVars)) {
      errors.push(`${file}:${line}: named color outside the theme`);
    }
    if (oldVariable.test(value)) errors.push(`${file}:${line}: retired UI color variable`);
    oldVariable.lastIndex = 0;
  }
}
for (const file of files) {
  const source = readFileSync(new URL(file, new URL("../", import.meta.url)), "utf8");
  if (file.endsWith(".css")) {
    postcss.parse(source, { from: file }).walkDecls(decl => check(decl.value, file, decl.source.start.line, true));
  } else {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        check(node.getText(ast), file, ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
}
if (errors.length) throw new Error(`UI colors must have a shared theme owner:\n${errors.join("\n")}`);
execFileSync(process.execPath, [fileURLToPath(new URL("generate-ui-theme.mjs", import.meta.url)), "--check"], { stdio: "inherit" });
console.log(`UI color ownership checked in ${files.length} source files. Brand SVG/raster assets retain authored artwork.`);
