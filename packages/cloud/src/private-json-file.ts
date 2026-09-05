import { atomicWriteFile, withFileLock } from "@openpond/persistence";
export { resolveOpenPondHome as openPondConfigDirectory, updateJsonFile as updatePrivateJsonFile } from "@openpond/persistence";

export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  await withFileLock(filePath, () => atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`));
}
