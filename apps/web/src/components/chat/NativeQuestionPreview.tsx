import { useMemo } from "react";
import { nativeQuestionPreviewDocument } from "../../lib/native-question-preview";
import { MarkdownText } from "./MarkdownText";

/** Provider previews are display-only, isolated from the app and the network. */
export function NativeQuestionPreview({ preview, label }: { preview: string; label: string }) {
  const html = /^\s*<[a-z][\w-]*\b[^>]*>/i.test(preview);
  const document = useMemo(
    () => (html ? nativeQuestionPreviewDocument(preview) : ""),
    [html, preview],
  );
  if (!html) {
    return (
      <div className="native-question-preview">
        <MarkdownText content={preview} />
      </div>
    );
  }
  return (
    <iframe
      className="native-question-preview"
      title={`${label} preview`}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={document}
    />
  );
}
