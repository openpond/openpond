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

export async function saveLocalFileAs(
  path: string,
  suggestedName: string
): Promise<{ ok: boolean; canceled: boolean; path: string | null }> {
  const normalizedPath = path.trim();
  const bridge = window.openpond?.files;
  if (!normalizedPath || !bridge?.saveAs) {
    return { ok: false, canceled: false, path: null };
  }
  try {
    const result = await bridge.saveAs({
      path: normalizedPath,
      suggestedName,
    });
    return {
      ok: result.ok,
      canceled: result.canceled,
      path: result.path ?? null,
    };
  } catch {
    return { ok: false, canceled: false, path: null };
  }
}
