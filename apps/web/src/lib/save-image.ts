type SaveFileHandle = { createWritable: () => Promise<{ write: (blob: Blob) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }> };
type SavePicker = (options: { suggestedName: string }) => Promise<SaveFileHandle>;

export async function saveImage(src: string, suggestedName: string): Promise<void> {
  const nativeSave = window.openpond?.files?.saveImage;
  if (nativeSave) {
    const result = await nativeSave({ url: new URL(src, window.location.href).href, suggestedName });
    if (!result.ok && !result.canceled) throw new Error(result.error || "Could not save image.");
    return;
  }
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  // Invoke the picker before fetching, while the click still has user activation.
  let handle: SaveFileHandle | undefined;
  try {
    handle = picker ? await picker.call(window, { suggestedName }) : undefined;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    throw error;
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Image download failed (${response.status}).`);
  const blob = await response.blob();
  if (handle) {
    const writable = await handle.createWritable();
    try { await writable.write(blob); await writable.close(); }
    catch (error) { await writable.abort().catch(() => undefined); throw error; }
    return;
  }
  // Browsers without a save picker still download a blob, never navigate to the image URL.
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = suggestedName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
