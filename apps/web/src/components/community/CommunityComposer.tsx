import type { ChatAttachment, CommunityMember, CommunityMessage } from "@openpond/contracts";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ComposerAttachmentPreview,
  createAttachmentId,
  readComposerAttachmentPayload,
  type ComposerAttachmentDraft,
} from "../chat/ComposerAttachments";
import {
  ComposerInlineInput,
  type ComposerInlineInputHandle,
} from "../chat/ComposerInlineInput";
import { ArrowUp, Paperclip, X } from "../icons";

const MAX_BODY_LENGTH = 20_000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function CommunityComposer(props: {
  members: CommunityMember[];
  replyTo: CommunityMessage | null;
  busy: boolean;
  disabled?: boolean;
  onCancelReply: () => void;
  onSearchMembers: (query: string) => Promise<CommunityMember[]>;
  onSend: (input: {
    body: string;
    mentionUserIds: string[];
    attachments: ChatAttachment[];
    replyToMessageId: string | null;
  }) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const [attachments, setAttachments] = useState<ComposerAttachmentDraft[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [encodingAttachments, setEncodingAttachments] = useState(false);
  const [searchedMembers, setSearchedMembers] = useState<CommunityMember[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<ComposerInlineInputHandle | null>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const mention = useMemo(() => activeMention(body, cursorIndex), [body, cursorIndex]);
  const mentionKey = mention ? `${mention.start}:${mention.end}:${mention.query}` : null;
  const mentionQuery = mention?.query ?? null;
  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const candidates = new Map<string, CommunityMember>();
    for (const member of [...props.members, ...searchedMembers]) candidates.set(member.userId, member);
    const query = mention.query.toLowerCase();
    return [...candidates.values()].filter((member) => {
      const value = `${member.handle ?? ""} ${member.name ?? ""}`.toLowerCase();
      return value.includes(query);
    }).slice(0, 8);
  }, [mention, props.members, searchedMembers]);
  const showMentionMenu = Boolean(
    mention && mentionKey !== dismissedMentionKey && mentionMatches.length > 0,
  );
  const inputDisabled = Boolean(props.disabled || props.busy || encodingAttachments);
  const canSend = !inputDisabled && (Boolean(body.trim()) || attachments.length > 0);

  useEffect(() => {
    if (mentionQuery == null) {
      setSearchedMembers([]);
      return;
    }
    let active = true;
    const timeout = window.setTimeout(() => {
      void props.onSearchMembers(mentionQuery).then(
        (members) => { if (active) setSearchedMembers(members); },
        () => { if (active) setSearchedMembers([]); },
      );
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [mentionQuery, props.onSearchMembers]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionKey]);

  useEffect(() => {
    return () => releaseAttachmentPreviews(attachmentsRef.current);
  }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    setAttachmentError(null);
    setEncodingAttachments(true);
    try {
      const payloads = await Promise.all(attachments.map(readComposerAttachmentPayload));
      const sent = await props.onSend({
        body,
        mentionUserIds: mentionedIds(body, props.members),
        attachments: payloads,
        replyToMessageId: props.replyTo?.id ?? null,
      });
      if (!sent) return;
      releaseAttachmentPreviews(attachments);
      setBody("");
      setCursorIndex(0);
      setAttachments([]);
      props.onCancelReply();
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setEncodingAttachments(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (showMentionMenu) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (current + 1) % mentionMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((current) => (current - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseMention(mentionMatches[mentionIndex] ?? mentionMatches[0]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMentionKey(mentionKey);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    setAttachmentError(null);
    const remaining = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (remaining === 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      resetFileInput();
      return;
    }
    const incoming = [...files];
    const selected = incoming.slice(0, remaining);
    const invalid = selected.find((file) => !SUPPORTED_IMAGE_TYPES.has(file.type));
    const oversized = selected.find((file) => file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES);
    if (invalid) {
      setAttachmentError(`${invalid.name} is not a supported image type.`);
      resetFileInput();
      return;
    }
    if (oversized) {
      setAttachmentError(`${oversized.name} must be smaller than 12 MB.`);
      resetFileInput();
      return;
    }
    const drafts = selected.map((file): ComposerAttachmentDraft => ({
      id: createAttachmentId(),
      file,
      name: file.name,
      mediaType: file.type,
      sizeBytes: file.size,
      kind: "image",
      previewUrl: URL.createObjectURL(file),
    }));
    setAttachments((current) => [...current, ...drafts]);
    if (incoming.length > remaining) {
      setAttachmentError(`Only ${MAX_ATTACHMENTS} images can be attached to one message.`);
    }
    resetFileInput();
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function resetFileInput() {
    if (fileRef.current) fileRef.current.value = "";
  }

  function chooseMention(member: CommunityMember) {
    if (!mention) return;
    const replacement = `@${mentionLabel(member)} `;
    const nextBody = `${body.slice(0, mention.start)}${replacement}${body.slice(mention.end)}`;
    const nextCursor = mention.start + replacement.length;
    setBody(nextBody);
    setCursorIndex(nextCursor);
    setDismissedMentionKey(null);
    window.requestAnimationFrame(() => inputRef.current?.focusAtPromptIndex(nextCursor));
  }

  return (
    <form
      className={`composer dock community-composer${attachments.length > 0 ? " has-attachments" : ""}${attachmentError ? " has-attachment-error" : ""}`}
      onSubmit={submit}
    >
      {props.replyTo ? (
        <div className="community-composer-reply">
          <span><strong>Replying to</strong>{props.replyTo.body.slice(0, 100) || "message"}</span>
          <button type="button" aria-label="Cancel reply" onClick={props.onCancelReply}><X size={13} /></button>
        </div>
      ) : null}
      {showMentionMenu ? (
        <div className="community-mention-menu" role="listbox" aria-label="Community members">
          {mentionMatches.map((member, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === mentionIndex}
              key={member.userId}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseMention(member)}
            >
              <strong>{member.name ?? member.handle ?? "Community member"}</strong>
              {member.handle ? <small>@{member.handle}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer-input-shell">
        {attachments.length > 0 ? (
          <div className="composer-attachments" aria-label="Selected attachments">
            {attachments.map((attachment) => (
              <ComposerAttachmentPreview
                attachment={attachment}
                key={attachment.id}
                onRemove={() => removeAttachment(attachment.id)}
              />
            ))}
          </div>
        ) : null}
        {attachmentError ? <div className="composer-attachment-error" role="status">{attachmentError}</div> : null}
        <div
          className="composer-textarea-frame"
          onClick={(event) => {
            if (event.target === event.currentTarget) inputRef.current?.focusAtPromptIndex(cursorIndex);
          }}
        >
          <ComposerInlineInput
            ref={inputRef}
            disabled={inputDisabled}
            onCursorChange={setCursorIndex}
            onKeyDown={keyDown}
            onPromptChange={(value, nextCursor) => {
              const nextValue = value.slice(0, MAX_BODY_LENGTH);
              setBody(nextValue);
              setCursorIndex(Math.min(nextCursor, nextValue.length));
            }}
            onTokenPositionChange={() => undefined}
            placeholder={props.disabled ? "Accept the community rules to post" : "Message community"}
            prompt={body}
            token={null}
          />
        </div>
        <div className="composer-primary-controls team-chat-composer-controls">
          <input
            ref={fileRef}
            className="composer-file-input"
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => addFiles(event.currentTarget.files)}
          />
          <button
            type="button"
            className="composer-icon"
            aria-label="Attach images"
            disabled={inputDisabled || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={17} />
          </button>
          <div className="composer-spacer" />
          <button type="submit" className="send-button" aria-label="Send message" disabled={!canSend}>
            <ArrowUp size={17} />
          </button>
        </div>
      </div>
    </form>
  );
}

function activeMention(value: string, cursorIndex = value.length): { start: number; end: number; query: string } | null {
  const cursor = Math.max(0, Math.min(cursorIndex, value.length));
  const match = /(?:^|\s)@([\w-]*)$/.exec(value.slice(0, cursor));
  if (!match || match.index == null) return null;
  const at = match.index + match[0].indexOf("@");
  return { start: at, end: cursor, query: match[1] ?? "" };
}

function mentionedIds(value: string, members: CommunityMember[]): string[] {
  const handles = new Set([...value.matchAll(/(?:^|\s)@([\w-]+)/g)].map((match) => match[1]?.toLowerCase()));
  return members.filter((member) => handles.has(mentionLabel(member).toLowerCase())).map((member) => member.userId);
}

function mentionLabel(member: CommunityMember): string {
  return member.handle ?? member.name?.replace(/[^\w-]/g, "") ?? member.userId;
}

function releaseAttachmentPreviews(attachments: ComposerAttachmentDraft[]) {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}
