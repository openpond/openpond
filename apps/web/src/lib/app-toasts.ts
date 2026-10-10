export type ThreadToastTarget = {
  sessionId: string;
  turnId?: string;
  questionId?: string;
  approvalId?: string;
  runId?: string;
};

export type AppToast = {
  id: number;
  createdAt: number;
  message: string;
  title?: string;
  detail?: string;
  tone: "success" | "error" | "info";
  actionLabel?: string;
  onAction?: () => void | boolean | Promise<void | boolean>;
  dedupeKey?: string;
  groupKey?: string;
  kind?: "completion" | "attention" | "team";
};

export type AppToastOptions = Omit<AppToast, "id" | "createdAt" | "message" | "tone">;
export type ShowAppToast = (message: string, tone?: AppToast["tone"], options?: AppToastOptions) => number;

export function enqueueAppToast(toasts: AppToast[], toast: AppToast): AppToast[] {
  const duplicate = toasts.find(item => toast.dedupeKey && item.dedupeKey === toast.dedupeKey);
  if (duplicate) return toasts;
  const grouped = toasts.find(item => toast.groupKey && item.groupKey === toast.groupKey);
  if (grouped && grouped.kind === "attention") {
    return toasts.map(item => item.id === grouped.id ? { ...toast, id: item.id, createdAt: item.createdAt } : item);
  }
  const next = [toast, ...toasts.filter(item => !toast.groupKey || item.groupKey !== toast.groupKey)];
  if (next.length <= 23) return next;
  let expendable = -1;
  for (let index = next.length - 1; index >= 3; index--) {
    if (next[index]!.kind !== "attention") { expendable = index; break; }
  }
  next.splice(expendable === -1 ? next.length - 1 : expendable, 1);
  return next;
}
