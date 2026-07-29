import {
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { addMenuAnchorStyle, slashMenuAnchorStyle } from "./ComposerLayout";
import type { ComposerCommandMenuItem } from "./ComposerCommandMenu";
import type { ComposerInlineInputHandle } from "./ComposerInlineInput";

type NullableStringSetter = Dispatch<SetStateAction<string | null>>;

export function useComposerMenuInteractions({
  activeMentionKey,
  activeSkillKey,
  activeSlashKey,
  addMenuIndex,
  addMenuItems,
  addMenuOpen,
  addMenuPanelRef,
  addMenuRef,
  attachmentCount,
  composerRef,
  createImproveActive,
  goalRuntimeActive,
  inputRef,
  inputShellRef,
  mentionQuery,
  prompt,
  selectedActionId,
  selectAddMenuItem,
  setActionIndex,
  setActionMenuDismissedPrompt,
  setAddMenuIndex,
  setAddMenuOpen,
  setAddMenuQuery,
  setMentionMenuDismissedPrompt,
  setMentionIndex,
  setSkillIndex,
  setSkillMenuDismissedPrompt,
  skillMatchCount,
  skillQuery,
  slashMatchCount,
  slashQuery,
  showActionMenu,
  showMentionMenu,
  showSkillMenu,
}: {
  activeMentionKey: string | null;
  activeSkillKey: string | null;
  activeSlashKey: string | null;
  addMenuIndex: number;
  addMenuItems: ComposerCommandMenuItem[];
  addMenuOpen: boolean;
  addMenuPanelRef: RefObject<HTMLDivElement | null>;
  addMenuRef: RefObject<HTMLDivElement | null>;
  attachmentCount: number;
  composerRef: RefObject<HTMLFormElement | null>;
  createImproveActive: boolean;
  goalRuntimeActive: boolean;
  inputRef: RefObject<ComposerInlineInputHandle | null>;
  inputShellRef: RefObject<HTMLDivElement | null>;
  mentionQuery: string | undefined;
  prompt: string;
  selectedActionId: string | null;
  selectAddMenuItem: (item: ComposerCommandMenuItem) => void;
  setActionIndex: Dispatch<SetStateAction<number>>;
  setActionMenuDismissedPrompt: NullableStringSetter;
  setAddMenuIndex: Dispatch<SetStateAction<number>>;
  setAddMenuOpen: Dispatch<SetStateAction<boolean>>;
  setAddMenuQuery: Dispatch<SetStateAction<string>>;
  setMentionMenuDismissedPrompt: NullableStringSetter;
  setMentionIndex: Dispatch<SetStateAction<number>>;
  setSkillIndex: Dispatch<SetStateAction<number>>;
  setSkillMenuDismissedPrompt: NullableStringSetter;
  skillMatchCount: number;
  skillQuery: string | undefined;
  slashMatchCount: number;
  slashQuery: string | undefined;
  showActionMenu: boolean;
  showMentionMenu: boolean;
  showSkillMenu: boolean;
}): {
  actionMenuStyle: CSSProperties;
  addMenuStyle: CSSProperties;
  mentionMenuStyle: CSSProperties;
  skillMenuStyle: CSSProperties;
} {
  const [mentionMenuStyle, setMentionMenuStyle] = useState<CSSProperties>({});
  const [skillMenuStyle, setSkillMenuStyle] = useState<CSSProperties>({});
  const [actionMenuStyle, setActionMenuStyle] = useState<CSSProperties>({});
  const [addMenuStyle, setAddMenuStyle] = useState<CSSProperties>({});

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  useEffect(() => {
    setSkillIndex(0);
  }, [skillMatchCount, skillQuery]);

  useEffect(() => {
    setActionIndex(0);
  }, [slashMatchCount, slashQuery]);

  useEffect(() => {
    const input = inputRef.current?.element;
    const container = input?.parentElement;
    if (!input || !container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => inputRef.current?.resize());
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!addMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      const inputArea = inputRef.current?.element?.parentElement;
      if (
        !addMenuRef.current?.contains(target) &&
        !addMenuPanelRef.current?.contains(target) &&
        !inputArea?.contains(target)
      ) {
        setAddMenuOpen(false);
        setAddMenuQuery("");
        setMentionMenuDismissedPrompt(activeMentionKey);
        setActionMenuDismissedPrompt(activeSlashKey);
        setSkillMenuDismissedPrompt(activeSkillKey);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setAddMenuOpen(false);
        setAddMenuQuery("");
        setMentionMenuDismissedPrompt(activeMentionKey);
        setActionMenuDismissedPrompt(activeSlashKey);
        setSkillMenuDismissedPrompt(activeSkillKey);
        return;
      }
      if (addMenuItems.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAddMenuIndex((current) => (current + 1) % addMenuItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setAddMenuIndex(
          (current) => (current - 1 + addMenuItems.length) % addMenuItems.length
        );
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setAddMenuIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setAddMenuIndex(addMenuItems.length - 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = addMenuItems[addMenuIndex] ?? addMenuItems[0];
        if (item) selectAddMenuItem(item);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeMentionKey,
    activeSkillKey,
    activeSlashKey,
    addMenuIndex,
    addMenuItems,
    addMenuOpen,
  ]);

  useLayoutEffect(() => {
    if (!addMenuOpen) return;
    const inputShell = inputShellRef.current;
    if (!inputShell) return;
    const inputShellElement = inputShell;

    function updateAddMenuPosition() {
      setAddMenuStyle(addMenuAnchorStyle(inputShellElement));
    }

    updateAddMenuPosition();
    window.addEventListener("resize", updateAddMenuPosition);
    window.addEventListener("scroll", updateAddMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateAddMenuPosition);
      window.removeEventListener("scroll", updateAddMenuPosition, true);
    };
  }, [addMenuOpen, attachmentCount, createImproveActive, goalRuntimeActive]);

  useLayoutEffect(() => {
    if (!showActionMenu) return;
    const input = inputRef.current?.element;
    const composer = composerRef.current;
    if (!input || !composer) return;
    const inputElement = input;
    const composerElement = composer;

    function updateSlashMenuPosition() {
      setActionMenuStyle(slashMenuAnchorStyle(inputElement, composerElement));
    }

    updateSlashMenuPosition();
    window.addEventListener("resize", updateSlashMenuPosition);
    window.addEventListener("scroll", updateSlashMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateSlashMenuPosition);
      window.removeEventListener("scroll", updateSlashMenuPosition, true);
    };
  }, [
    attachmentCount,
    createImproveActive,
    goalRuntimeActive,
    prompt,
    selectedActionId,
    showActionMenu,
  ]);

  useLayoutEffect(() => {
    if (!showSkillMenu) return;
    const input = inputRef.current?.element;
    const composer = composerRef.current;
    if (!input || !composer) return;
    const inputElement = input;
    const composerElement = composer;

    function updateSkillMenuPosition() {
      setSkillMenuStyle(slashMenuAnchorStyle(inputElement, composerElement));
    }

    updateSkillMenuPosition();
    window.addEventListener("resize", updateSkillMenuPosition);
    window.addEventListener("scroll", updateSkillMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateSkillMenuPosition);
      window.removeEventListener("scroll", updateSkillMenuPosition, true);
    };
  }, [
    attachmentCount,
    createImproveActive,
    goalRuntimeActive,
    prompt,
    selectedActionId,
    showSkillMenu,
  ]);

  useLayoutEffect(() => {
    if (!showMentionMenu) return;
    const input = inputRef.current?.element;
    const composer = composerRef.current;
    if (!input || !composer) return;
    const inputElement = input;
    const composerElement = composer;

    function updateMentionMenuPosition() {
      setMentionMenuStyle(slashMenuAnchorStyle(inputElement, composerElement));
    }

    updateMentionMenuPosition();
    window.addEventListener("resize", updateMentionMenuPosition);
    window.addEventListener("scroll", updateMentionMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMentionMenuPosition);
      window.removeEventListener("scroll", updateMentionMenuPosition, true);
    };
  }, [
    attachmentCount,
    createImproveActive,
    goalRuntimeActive,
    prompt,
    selectedActionId,
    showMentionMenu,
  ]);

  return {
    actionMenuStyle,
    addMenuStyle,
    mentionMenuStyle,
    skillMenuStyle,
  };
}
