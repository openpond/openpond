import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { PanelRight } from "lucide-react";
const PanelBody = createContext(false);
export const useWorkspacePanelBody = () => useContext(PanelBody);
export const WorkspacePanelHost = createContext<HTMLElement | null>(null);
export const WorkspaceResourceName = createContext<(name: string | null) => void>(() => {});
export function useWorkspaceResourceName(name: string | null) {
  const report = useContext(WorkspaceResourceName);
  useEffect(() => {
    report(name);
  }, [name, report]);
}
export type EvaluationSidebarControl = { open: boolean; toggle: () => void };
export type WorkspaceAction = { id: string; label: string; onSelect: () => void };
const Controls = createContext<{
  open: boolean;
  width: number;
  actions: WorkspaceAction[];
  active: string | null;
  registerClose: (id: string, close: () => void) => () => void;
  dismiss: () => void;
  toggle: () => void;
  resize: (width: number) => void;
  register: (actions: WorkspaceAction[], owner: string) => () => void;
  select: (action: WorkspaceAction) => void;
  show: (id: string) => void;
  close: (id: string) => void;
} | null>(null);
export const useWorkspacePanelControls = () => useContext(Controls);
export function WorkspacePanelControls({
  children,
  onControl,
}: {
  children: ReactNode;
  onControl?: (control: EvaluationSidebarControl | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(440);
  const [registered, setRegistered] = useState<Record<string, WorkspaceAction[]>>({});
  const register = useCallback((items: WorkspaceAction[], owner: string) => {
    setRegistered((current) => ({ ...current, [owner]: items }));
    return () =>
      setRegistered((current) => {
        const next = { ...current };
        delete next[owner];
        return next;
      });
  }, []);
  const actions = useMemo(() => {
    const unique = new Map<string, WorkspaceAction>();
    for (const items of Object.values(registered))
      for (const action of items) unique.set(action.id, action);
    return [...unique.values()];
  }, [registered]);
  const panels = useRef<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const closeHandlers = useRef(new Map<string, () => void>());
  const registerClose = useCallback((id: string, handler: () => void) => {
    closeHandlers.current.set(id, handler);
    return () => {
      if (closeHandlers.current.get(id) === handler) closeHandlers.current.delete(id);
    };
  }, []);
  const resize = useCallback((value: number) => setWidth(Math.max(320, Math.min(800, value))), []);
  const show = useCallback((id: string) => {
    panels.current = [...panels.current.filter((value) => value !== id), id];
    setActive(id);
    setOpen(true);
  }, []);
  const close = useCallback((id: string) => {
    panels.current = panels.current.filter((value) => value !== id);
    setActive((current) => (current === id ? (panels.current.at(-1) ?? null) : current));
    if (!panels.current.length) setOpen(false);
  }, []);
  const select = useCallback(
    (action: WorkspaceAction) => {
      action.onSelect();
      const retained = [...panels.current].reverse().find((id) => id.startsWith(`${action.id}:`));
      if (retained) show(retained);
      else {
        setActive(action.id);
        setOpen(true);
      }
    },
    [show],
  );
  const toggle = useCallback(() => {
    if (!open && !panels.current.length && actions[0]) {
      select(actions.find((action) => action.id === active) ?? actions[0]);
      return;
    }
    setOpen((value) => !value);
  }, [open, actions, active, select]);
  const dismiss = useCallback(() => {
    const handler = active ? closeHandlers.current.get(active) : null;
    if (handler) handler();
    else setOpen(false);
  }, [active]);
  useEffect(() => {
    onControl?.({ open, toggle });
    return () => onControl?.(null);
  }, [onControl, open, toggle]);
  const value = useMemo(
    () => ({
      open,
      width,
      actions,
      active,
      toggle,
      dismiss,
      registerClose,
      resize,
      register,
      select,
      show,
      close,
    }),
    [open, width, actions, active, toggle, dismiss, registerClose, resize, select, show, close],
  );
  return <Controls.Provider value={value}>{children}</Controls.Provider>;
}
export function useWorkspaceActions(actions: WorkspaceAction[]) {
  const controls = useWorkspacePanelControls();
  const register = controls?.register;
  const owner = useId();
  const latest = useRef(actions);
  latest.current = actions;
  const signature = actions.map((action) => `${action.id}:${action.label}`).join("|");
  useEffect(() => {
    if (!register) return;
    return register(
      latest.current.map((action) => ({
        ...action,
        onSelect: () => latest.current.find((item) => item.id === action.id)?.onSelect(),
      })),
      owner,
    );
  }, [register, signature, owner]);
  return (id: string) => {
    const action = latest.current.find((item) => item.id === id);
    if (action) {
      if (controls) controls.select(action);
      else action.onSelect();
    }
  };
}
export function WorkspacePanelToolbar() {
  const controls = useWorkspacePanelControls();
  if (!controls) return null;
  return (
    <div className="evaluation-panel-toolbar">
      <nav aria-label="Sidebar actions">
        {controls.actions.map((action) => (
          <button
            type="button"
            key={action.id}
            aria-pressed={
              controls.active === action.id || controls.active?.startsWith(`${action.id}:`)
            }
            onClick={() => controls.select(action)}
          >
            {action.label}
          </button>
        ))}
      </nav>
      <button
        type="button"
        className="evaluation-panel-icon"
        aria-label="Collapse sidebar"
        onClick={controls.dismiss}
      >
        <PanelRight size={16} />
      </button>
    </div>
  );
}
/** Portals preserve each mounted editor's form state when switching actions or collapsing. */
export function WorkspacePanel({
  children,
  label,
  action,
  onRequestClose,
  visible=true,
}: {
  children: ReactNode;
  label: string;
  action?: string;
  onRequestClose?: () => void;
  visible?:boolean;
}) {
  const host = useContext(WorkspacePanelHost);
  const controls = useWorkspacePanelControls();
  const id = useId();
  const panelId = action ? `${action}:${id}` : id;
  const show = controls?.show;
  const close = controls?.close;
  const latestClose = useRef(onRequestClose);
  latestClose.current = onRequestClose;
  const registerClose = controls?.registerClose;
  useEffect(() => {
    if (!registerClose || !onRequestClose) return;
    return registerClose(panelId, () => latestClose.current?.());
  }, [registerClose, panelId, Boolean(onRequestClose)]);
  useEffect(() => {
    if(visible)show?.(panelId);
    else close?.(panelId);
    return () => close?.(panelId);
  }, [show, close, panelId,visible]);
  return host
    ? createPortal(
        <section aria-label={label} hidden={!visible||Boolean(controls && controls.active !== panelId)}>
          <PanelBody.Provider value>{children}</PanelBody.Provider>
        </section>,
        host,
      )
    : null;
}
