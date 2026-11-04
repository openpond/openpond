import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from "react";

type Guard = () => Promise<boolean>;
const Context = createContext<((guard: Guard) => () => void) | null>(null);
export type DraftNavigationBoundaryHandle = {
  requestLeave(action: () => void | Promise<void>): Promise<void>;
};

/** Section changes ask only the editors they will unmount. Global navigation
 * still asks every registered editor, including the retained parent experiment. */
export function DraftNavigationBoundary({
  children,
  handle,
}: {
  children: ReactNode;
  handle: Ref<DraftNavigationBoundaryHandle>;
}) {
  const guards = useRef(new Set<Guard>());
  const deciding = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const register = useCallback((guard: Guard) => {
    guards.current.add(guard);
    return () => {
      guards.current.delete(guard);
    };
  }, []);
  useImperativeHandle(
    handle,
    () => ({
      async requestLeave(action) {
        if (deciding.current) return;
        deciding.current = true;
        try {
          for (const guard of [...guards.current].reverse()) if (!(await guard())) return;
          if (mounted.current) await action();
        } finally {
          deciding.current = false;
        }
      },
    }),
    [],
  );
  return <Context.Provider value={register}>{children}</Context.Provider>;
}

export function useScopedDraftNavigation(guard: Guard) {
  const register = useContext(Context);
  const current = useRef(guard);
  current.current = guard;
  useEffect(() => register?.(() => current.current()), [register]);
}
