import { promises as fs } from "node:fs";

export async function readDesktopServerToken(input: {
  environmentToken?: string;
  tokenFile: string;
}): Promise<string | null> {
  const environmentToken = input.environmentToken?.trim();
  if (environmentToken) return environmentToken;
  try {
    const fileToken = (await fs.readFile(input.tokenFile, "utf8")).trim();
    return fileToken || null;
  } catch {
    return null;
  }
}
