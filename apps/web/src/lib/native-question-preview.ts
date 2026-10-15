const previewTags = new Set(
  "div span p pre code h1 h2 h3 h4 h5 h6 br hr strong em b i ul ol li table thead tbody tfoot tr th td img section article header footer main figure figcaption".split(
    " ",
  ),
);
const previewAttributes = new Set([
  "style",
  "title",
  "aria-label",
  "alt",
  "width",
  "height",
  "colspan",
  "rowspan",
]);

/** Remove navigation, embedded documents and active content before isolation.
 * The frame also has no scripts, same-origin access, forms or network access. */
export function nativeQuestionPreviewDocument(preview: string): string {
  const parsed = new DOMParser().parseFromString(preview, "text/html");
  for (const element of parsed.body.querySelectorAll("*")) {
    if (!previewTags.has(element.localName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const imageData =
        element.localName === "img" &&
        attribute.name === "src" &&
        /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(attribute.value);
      if (!previewAttributes.has(attribute.name) && !imageData)
        element.removeAttribute(attribute.name);
    }
  }
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:8px;font:13px/1.5 system-ui;color-scheme:light dark;background:Canvas;color:CanvasText}img{max-width:100%;height:auto}</style></head><body>${parsed.body.innerHTML}</body></html>`;
}
