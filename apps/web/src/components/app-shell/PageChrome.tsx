"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface PageChromeTargets {
  title: HTMLDivElement | null;
  actions: HTMLDivElement | null;
  setTitle: (element: HTMLDivElement | null) => void;
  setActions: (element: HTMLDivElement | null) => void;
}
const PageChromeContext = createContext<PageChromeTargets | null>(null);

/** Portals keep page actions owned by their page, including local draft state. */
export function PageChromeProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<HTMLDivElement | null>(null);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ title, actions, setTitle, setActions }), [title, actions]);
  return <PageChromeContext.Provider value={value}>{children}</PageChromeContext.Provider>;
}

export function PageChromeBoundary({ children }: { children: ReactNode }) {
  return <PageChromeContext.Provider value={null}>{children}</PageChromeContext.Provider>;
}

export function PageChromeTitleTarget({ children, className = "" }: { children?: ReactNode; className?: string }) {
  const chrome = useContext(PageChromeContext);
  return <div ref={chrome?.setTitle} className={`page-chrome-title-target ${className}`}>
    {children ? <div className="page-chrome-fallback">{children}</div> : null}
  </div>;
}

export function PageChromeActionsTarget({ className = "" }: { className?: string }) {
  const chrome = useContext(PageChromeContext);
  return <div ref={chrome?.setActions} className={className} />;
}

export function PageChromeContent({ title, actions, fallback, children }: { title: ReactNode; actions?: ReactNode; fallback?: ReactNode; children?: ReactNode }) {
  const chrome = useContext(PageChromeContext);
  if (!chrome) return fallback ?? <header>{title}{actions}</header>;
  return <>
    {chrome.title ? createPortal(<div className="page-chrome-title">{title}</div>, chrome.title) : null}
    {chrome.actions && actions ? createPortal(actions, chrome.actions) : null}
    {children}
  </>;
}
