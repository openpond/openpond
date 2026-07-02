export async function copyToClipboard(value: string): Promise<boolean> {
  if (!value) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (clipboardError) {
    console.warn("Clipboard write failed", clipboardError);
  }

  try {
    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.left = "-1000px";
    textArea.style.top = "-1000px";
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand("copy");
    textArea.remove();
    return copied;
  } catch (fallbackError) {
    console.warn("Clipboard fallback failed", fallbackError);
    return false;
  }
}
