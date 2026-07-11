export type RunViewerState = "pending" | "connecting" | "connected" | "failed" | "disconnected";
export type AccountAuthStatus = "loggedIn" | "expired" | "needsLogin" | "banned";

export const VIEWER_STATUS_META: Record<RunViewerState, { label: string; className: string }> = {
  pending: {
    label: "pending",
    className: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  },
  connecting: {
    label: "connecting",
    className: "border-sky-500/40 bg-sky-500/15 text-sky-300",
  },
  connected: {
    label: "connected",
    className: "border-emerald-400/45 bg-emerald-500/15 text-emerald-200",
  },
  failed: {
    label: "failed",
    className: "border-red-500/45 bg-red-500/15 text-red-300",
  },
  disconnected: {
    label: "disconnected",
    className: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400 line-through",
  },
};

export const ACCOUNT_AUTH_STATUS_META: Record<AccountAuthStatus, { label: string; title: string; className: string }> = {
  loggedIn: {
    label: "ok",
    title: "Logged in",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  },
  expired: {
    label: "due",
    title: "Needs refresh",
    className: "border-amber-500/25 bg-amber-500/10 text-amber-300",
  },
  needsLogin: {
    label: "login",
    title: "Needs login",
    className: "border-red-500/25 bg-red-500/10 text-red-300",
  },
  banned: {
    label: "ban",
    title: "Banned",
    className: "border-red-500/45 bg-red-500/15 text-red-300 line-through",
  },
};

export function accountRunStatus(authStatus: AccountAuthStatus, viewerState?: RunViewerState) {
  if (viewerState) {
    const meta = VIEWER_STATUS_META[viewerState];
    return {
      label: meta.label,
      title: meta.label,
      className: meta.className,
    };
  }

  return ACCOUNT_AUTH_STATUS_META[authStatus];
}
