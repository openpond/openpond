import { execFile } from "node:child_process";
import path from "node:path";
import { readLocalImageFile } from "../workspace/workspace-common.js";
import { resolveWorkspaceExecutionTarget } from "../workspace/workspace-execution-target.js";
import type { ModelToolDefinition } from "./model-tool-registry.js";

const SAMPLE_WIDTH = 12;
const SAMPLE_HEIGHT = 8;
const LUMINANCE_RAMP = " .:-=+*#%@";

export function createLocalImageModelToolDefinition(): ModelToolDefinition {
  return {
    name: "view_image",
    description:
      "Inspect a real local PNG, JPEG, GIF, WebP, or AVIF file. Reads the image bytes directly and returns dimensions plus a coarse pixel/color map; it also creates an actual image preview in the chat UI. Use this instead of opening file:// URLs or browser snapshots, which cannot inspect local image pixels. For many video frames, build one contact sheet and inspect that rather than reading frames one by one.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Absolute image path, or a path relative to the selected local project.",
        },
      },
      required: ["path"],
    },
    enabled: (context) => {
      if (context.provider === "codex" || context.session.provider === "codex") return false;
      if (context.session.openPondCommandAccessMode === "disabled") return false;
      return resolveWorkspaceExecutionTarget({ session: context.session }).target !== "sandbox";
    },
    execute: async (context) => {
      const requestedPath = stringArg(context.args.path, "path");
      const imagePath = path.isAbsolute(requestedPath)
        ? path.resolve(requestedPath)
        : context.session.cwd
          ? path.resolve(context.session.cwd, requestedPath)
          : "";
      if (!imagePath) throw new Error("A relative image path requires a selected local project.");
      const image = await readLocalImageFile(imagePath);
      if (!image) throw new Error(`Local image was not found or is not a supported image: ${imagePath}`);
      const inspection = await inspectImagePixels(image.path, context.signal);
      return {
        toolCallId: context.callId,
        name: "view_image",
        ok: true,
        contentText: JSON.stringify(
          {
            ok: true,
            action: "view_image",
            output: `Read actual image pixels from ${image.path}.`,
            data: {
              path: image.path,
              contentType: image.contentType,
              sizeBytes: image.sizeBytes,
              ...inspection,
              note: "The luminance and color maps are deterministic pixel samples, not a semantic vision caption.",
            },
          },
          null,
          2,
        ),
        data: {
          openpondImagePreviewPath: image.path,
          path: image.path,
          contentType: image.contentType,
          sizeBytes: image.sizeBytes,
          ...inspection,
        },
      };
    },
  };
}

async function inspectImagePixels(
  imagePath: string,
  signal: AbortSignal,
): Promise<{
  format: string;
  width: number;
  height: number;
  luminanceMap: string[];
  colorMap: string[][];
}> {
  const identity = await runImageCommand(
    "identify",
    ["-format", "%m %w %h", imagePath],
    signal,
  );
  const match = /^(\S+)\s+(\d+)\s+(\d+)/.exec(identity.trim());
  if (!match) throw new Error("Image metadata could not be decoded.");
  const pixels = await runImageCommand(
    "convert",
    [imagePath, "-resize", `${SAMPLE_WIDTH}x${SAMPLE_HEIGHT}!`, "-depth", "8", "txt:-"],
    signal,
  );
  const sampled = sampledPixelRows(pixels);
  return {
    format: match[1]!,
    width: Number.parseInt(match[2]!, 10),
    height: Number.parseInt(match[3]!, 10),
    luminanceMap: sampled.map((row) => row.map(luminanceCharacter).join("")),
    colorMap: sampled.map((row) => row.map((rgb) => `#${rgb.map(hexByte).join("")}`)),
  };
}

function sampledPixelRows(output: string): Array<Array<[number, number, number]>> {
  const rows = Array.from({ length: SAMPLE_HEIGHT }, () =>
    Array.from({ length: SAMPLE_WIDTH }, () => [0, 0, 0] as [number, number, number]),
  );
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+),(\d+):\s*\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(line);
    if (!match) continue;
    const x = Number.parseInt(match[1]!, 10);
    const y = Number.parseInt(match[2]!, 10);
    if (x >= SAMPLE_WIDTH || y >= SAMPLE_HEIGHT) continue;
    rows[y]![x] = [
      Number.parseInt(match[3]!, 10),
      Number.parseInt(match[4]!, 10),
      Number.parseInt(match[5]!, 10),
    ];
  }
  return rows;
}

function luminanceCharacter([red, green, blue]: [number, number, number]): string {
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return LUMINANCE_RAMP[Math.min(LUMINANCE_RAMP.length - 1, Math.round((luminance / 255) * (LUMINANCE_RAMP.length - 1)))]!;
}

function hexByte(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function runImageCommand(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 256 * 1024, signal }, (error, stdout) => {
      if (error) {
        reject(new Error(`${command} could not inspect the image: ${error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function stringArg(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
