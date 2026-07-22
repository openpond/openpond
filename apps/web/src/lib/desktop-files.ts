export async function revealLocalFile(path: string): Promise<boolean> {
  const normalizedPath = path.trim();
  if (!normalizedPath) return false;
  const bridge = window.openpond?.files;
  if (!bridge) return false;
  try {
    const result = await bridge.reveal({ path: normalizedPath });
    return result.ok;
  } catch {
    return false;
  }
}
