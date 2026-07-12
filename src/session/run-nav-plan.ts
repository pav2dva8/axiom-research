import type { NavAction } from "./token-navigation-plan";

export async function runNavPlan(
  actions: NavAction[],
  send: (action: NavAction) => void | Promise<void>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<void> {
  const start = now();
  const ordered = [...actions].sort((a, b) => a.atMs - b.atMs);

  for (const action of ordered) {
    const delayMs = Math.max(0, start + Math.max(0, action.atMs) - now());
    if (delayMs > 0) await wait(delayMs);
    await send(action);
  }
}
