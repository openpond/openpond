import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelLeft, PanelRight } from "lucide-react";
export const WorkspacePanelHost = createContext<HTMLElement | null>(null);
export const WorkspaceResourceName = createContext<(name: string | null) => void>(() => {});
export function useWorkspaceResourceName(name: string | null) { const report = useContext(WorkspaceResourceName); useEffect(() => { report(name); }, [name, report]); }
export type EvaluationSidebarControl = { open: boolean; toggle: () => void };
export type WorkspaceAction = { id: string; label: string; onSelect: () => void };
const Controls = createContext<{
  open: boolean; side: "left" | "right"; width: number; actions: WorkspaceAction[]; active: string | null;
  toggle: () => void; move: () => void; resize: (width: number) => void;
  register: (actions: WorkspaceAction[], owner: string) => () => void; select: (action: WorkspaceAction) => void; show: (id: string) => void; close: (id: string) => void;
} | null>(null);
export const useWorkspacePanelControls = () => useContext(Controls);
export function WorkspacePanelControls({ children, onControl }: { children: ReactNode; onControl?: (control: EvaluationSidebarControl | null) => void }) {
  const [open, setOpen] = useState(false); const [side, setSide] = useState<"left" | "right">("right");
  const [width, setWidth] = useState(440);
  const [registered, setRegistered] = useState<Record<string, WorkspaceAction[]>>({});
  const register = useCallback((items: WorkspaceAction[], owner: string) => {
    setRegistered(current => ({ ...current, [owner]: items }));
    return () => setRegistered(current => { const next = { ...current }; delete next[owner]; return next; });
  }, []);
  const actions = useMemo(() => {
    const unique = new Map<string, WorkspaceAction>();
    for (const items of Object.values(registered)) for (const action of items) unique.set(action.id, action);
    return [...unique.values()];
  }, [registered]);
  const panels = useRef<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const toggle = useCallback(() => setOpen(value => !value), []);
  const move = useCallback(() => setSide(value => value === "right" ? "left" : "right"), []);
  const resize = useCallback((value: number) => setWidth(Math.max(320, Math.min(800, value))), []);
  const show = useCallback((id: string) => { panels.current = [...panels.current.filter(value => value !== id), id]; setActive(id); setOpen(true); }, []);
  const close = useCallback((id: string) => { panels.current = panels.current.filter(value => value !== id); setActive(current => current === id ? panels.current.at(-1) ?? null : current); }, []);
  const select = useCallback((action: WorkspaceAction) => { action.onSelect(); show([...panels.current].reverse().find(id => id.startsWith(`${action.id}:`)) ?? action.id); }, [show]);
  useEffect(() => { onControl?.({open,toggle}); return () => onControl?.(null); }, [onControl,open,toggle]);
  const value = useMemo(() => ({ open, side, width, actions, active, toggle, move, resize, register, select, show, close }), [open, side, width, actions, active, toggle, move, resize, select, show, close]);
  return <Controls.Provider value={value}>{children}</Controls.Provider>;
}
export function useWorkspaceActions(actions: WorkspaceAction[]) {
  const controls = useWorkspacePanelControls(); const register = controls?.register; const owner = useId();
  const latest = useRef(actions); latest.current = actions;
  const signature = actions.map(action => `${action.id}:${action.label}`).join("|");
  useEffect(() => { if (!register) return; return register(latest.current.map(action => ({ ...action, onSelect: () => latest.current.find(item => item.id === action.id)?.onSelect() })), owner); }, [register, signature, owner]);
  return (id: string) => { const action = latest.current.find(item => item.id === id); if (action) { if (controls) controls.select(action); else action.onSelect(); } };
}
export function WorkspacePanelToolbar() {
  const controls = useWorkspacePanelControls(); if (!controls) return null;
  return <div className="evaluation-panel-toolbar"><nav aria-label="Sidebar actions">{controls.actions.map(action => <button type="button" key={action.id} aria-pressed={controls.active === action.id || controls.active?.startsWith(`${action.id}:`)} onClick={() => controls.select(action)}>{action.label}</button>)}</nav><button type="button" className="evaluation-panel-icon" aria-label="Collapse sidebar" onClick={controls.toggle}><PanelRight size={16} /></button><button type="button" className="training-text-button" aria-label={`Move sidebar to ${controls.side === "right" ? "left" : "right"}`} onClick={controls.move}>{controls.side === "right" ? <PanelLeft size={16} /> : <PanelRight size={16} />}Move {controls.side === "right" ? "left" : "right"}</button></div>;
}
/** Portals preserve each mounted editor's form state when moving or collapsing. */
export function WorkspacePanel({ children, label, action }: { children: ReactNode; label: string; action?: string }) {
  const host = useContext(WorkspacePanelHost); const controls = useWorkspacePanelControls(); const id = useId();
  const panelId = action ? `${action}:${id}` : id; const show = controls?.show; const close = controls?.close;
  useEffect(() => { show?.(panelId); return () => close?.(panelId); }, [show, close, panelId]);
  return host ? createPortal(<section aria-label={label} hidden={Boolean(controls && controls.active !== panelId)}>{children}</section>, host) : null;
}
