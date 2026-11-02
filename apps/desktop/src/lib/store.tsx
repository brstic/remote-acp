import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, onBridgeEvent } from "./api";
import type { Snapshot, UiEvent } from "./types";

export type Route = "overview" | "providers" | "websites" | "activity" | "settings" | "diagnostics" | "help";

export interface Toast {
  id: number;
  kind: "error" | "info" | "success";
  text: string;
}

interface Ctx {
  snap: Snapshot | null;
  loadError: string | null;
  refresh: () => void;
  route: Route;
  navigate: (r: Route) => void;
  focusTaskId: string | null;
  setFocusTaskId: (id: string | null) => void;
  toasts: Toast[];
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  /** Run an action, toasting its error. Returns true on success. */
  run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
}

const BridgeCtx = createContext<Ctx | null>(null);

export function BridgeProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>("overview");
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pending = useRef<number | null>(null);
  const nextToast = useRef(1);

  const fetchNow = useCallback(async () => {
    try {
      const s = await api.snapshot();
      setSnap(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(String((e as Error).message ?? e));
    }
  }, []);

  // Coalesce bursts of state_changed events (streaming) into one fetch per frame.
  const refresh = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      void fetchNow();
    }, 60);
  }, [fetchNow]);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = nextToast.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      try {
        await fn();
        if (success) toast("success", success);
        refresh();
        return true;
      } catch (e) {
        toast("error", String((e as Error).message ?? e));
        refresh();
        return false;
      }
    },
    [toast, refresh],
  );

  useEffect(() => {
    void fetchNow();
    let unlisten: (() => void) | undefined;
    onBridgeEvent((e: UiEvent) => {
      switch (e.type) {
        case "task_delta":
          setSnap((s) => {
            if (!s) return s;
            return {
              ...s,
              tasks: s.tasks.map((t) => {
                if (t.id !== e.taskId) return t;
                const tr = [...t.transcript];
                const last = tr[tr.length - 1];
                if (last && last.type === "agent") tr[tr.length - 1] = { ...last, text: last.text + e.text };
                else tr.push({ type: "agent", text: e.text });
                return { ...t, transcript: tr };
              }),
            };
          });
          break;
        case "error":
          toast("error", e.message);
          refresh();
          break;
        case "pairing_requested":
          setRoute("websites");
          refresh();
          break;
        default:
          refresh();
      }
    }).then((u) => (unlisten = u));
    // Periodic refresh keeps relative times and expiries fresh.
    const iv = window.setInterval(() => void fetchNow(), 5000);
    return () => {
      unlisten?.();
      window.clearInterval(iv);
    };
  }, [fetchNow, refresh, toast]);

  // Theme: follow OS unless overridden.
  useEffect(() => {
    const theme = snap?.settings.theme ?? "system";
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [snap?.settings.theme]);

  const value = useMemo<Ctx>(
    () => ({
      snap,
      loadError,
      refresh,
      route,
      navigate: setRoute,
      focusTaskId,
      setFocusTaskId,
      toasts,
      toast,
      dismissToast,
      run,
    }),
    [snap, loadError, refresh, route, focusTaskId, toasts, toast, dismissToast, run],
  );
  return <BridgeCtx.Provider value={value}>{children}</BridgeCtx.Provider>;
}

export function useBridge(): Ctx {
  const c = useContext(BridgeCtx);
  if (!c) throw new Error("useBridge outside provider");
  return c;
}
