import { useEffect, useId, useRef } from "react";
import "../../styles/chat/file-resolution.css";

export function ChatFileResolutionDialog({ resolution, onSelect, onClose }: {
  resolution: { requestedPath: string; candidates: string[]; truncated: boolean };
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="chat-file-resolution" aria-labelledby={titleId} onCancel={onClose}>
    <h2 id={titleId}>Choose a file</h2>
    <p>Matches for <strong>{resolution.requestedPath}</strong> in this project's folders:</p>
    {resolution.truncated ? <p>The search reached its limit. More matches may exist.</p> : null}
    <div className="chat-file-resolution-options">
      {resolution.candidates.map(path => <button key={path} type="button" onClick={() => onSelect(path)}>{path}</button>)}
    </div>
    <button type="button" className="git-dialog-secondary" onClick={onClose}>Cancel</button>
  </dialog>;
}
