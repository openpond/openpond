#!/usr/bin/env node

import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const targetArg = process.argv[2]?.trim();
if (!targetArg) {
  console.error("Usage: validate-skill.mjs <skill-package>");
  process.exitCode = 2;
} else {
  const diagnostics = await validateSkill(targetArg);
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) console.error(`ERROR: ${diagnostic}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${path.resolve(targetArg)}`);
  }
}

async function validateSkill(target) {
  const diagnostics = [];
  const packagePath = path.resolve(target);
  const packageStat = await lstat(packagePath).catch(() => null);
  if (!packageStat?.isDirectory()) return [`Skill package directory does not exist: ${packagePath}`];
  if (packageStat.isSymbolicLink()) return [`Skill package must not be a symlink: ${packagePath}`];

  const canonicalPackage = await realpath(packagePath);
  const skillPath = path.join(canonicalPackage, "SKILL.md");
  const skillStat = await lstat(skillPath).catch(() => null);
  if (!skillStat?.isFile()) return [`SKILL.md does not exist: ${skillPath}`];
  if (skillStat.isSymbolicLink()) return [`SKILL.md must not be a symlink: ${skillPath}`];
  if (skillStat.size > 100_000) diagnostics.push("SKILL.md exceeds 100,000 bytes.");

  const body = await readFile(skillPath, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!frontmatter) return [...diagnostics, "SKILL.md must start with delimited YAML frontmatter."];

  const fields = new Map();
  for (const rawLine of frontmatter[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      diagnostics.push(`Unsupported frontmatter line: ${rawLine}`);
      continue;
    }
    fields.set(match[1], unquote(match[2].trim()));
  }

  for (const key of fields.keys()) {
    if (key !== "name" && key !== "description") diagnostics.push(`Unsupported frontmatter key: ${key}`);
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  const directoryName = path.basename(canonicalPackage);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    diagnostics.push("Frontmatter name must be lowercase kebab-case.");
  }
  if (name !== directoryName) {
    diagnostics.push(`Frontmatter name "${name}" must match package directory "${directoryName}".`);
  }
  if (description.length < 24) diagnostics.push("Frontmatter description must be at least 24 characters.");
  if (description.length > 1_024) diagnostics.push("Frontmatter description must not exceed 1,024 characters.");

  const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const match of body.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().split(/\s+["']/)[0] ?? "";
    if (!rawTarget || /^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
    const decoded = decodeURIComponent(rawTarget.split("#")[0]);
    const resolved = path.resolve(canonicalPackage, decoded);
    if (!isWithin(canonicalPackage, resolved)) {
      diagnostics.push(`Reference escapes the skill package: ${rawTarget}`);
      continue;
    }
    const referenceStat = await lstat(resolved).catch(() => null);
    if (!referenceStat?.isFile()) {
      diagnostics.push(`Referenced file does not exist: ${rawTarget}`);
      continue;
    }
    const canonicalReference = await realpath(resolved);
    if (!isWithin(canonicalPackage, canonicalReference)) {
      diagnostics.push(`Referenced file resolves outside the skill package: ${rawTarget}`);
    }
  }
  return [...new Set(diagnostics)];
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
