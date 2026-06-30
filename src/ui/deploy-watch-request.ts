import {
  DeployWatchCanceledError,
  type DeployWatchEvent,
} from "./deploy-watcher";

export type DeployWatchRequestPhase = "preparing" | "watching" | "starting";

export interface DeployWatchRequestState {
  ca: string;
  pairAddress: string;
  phase: DeployWatchRequestPhase;
  canceled: boolean;
  cancelMessage: string;
  terminalEventBroadcasted: boolean;
}

interface DeployWatchRequestInput {
  ca: string;
  pairAddress: string;
}

export function createDeployWatchRequestState({
  ca,
  pairAddress,
}: DeployWatchRequestInput): DeployWatchRequestState {
  return {
    ca,
    pairAddress,
    phase: "preparing",
    canceled: false,
    cancelMessage: "Deploy watch canceled.",
    terminalEventBroadcasted: false,
  };
}

export function markDeployWatchPhase(
  request: DeployWatchRequestState,
  phase: DeployWatchRequestPhase,
): void {
  request.phase = phase;
}

export function shouldBroadcastDeployWatchEvent(
  request: DeployWatchRequestState,
  event: DeployWatchEvent,
): boolean {
  if (event.state !== "canceled" && event.state !== "failed") {
    return true;
  }

  if (request.terminalEventBroadcasted) {
    return false;
  }

  request.terminalEventBroadcasted = true;
  return true;
}

export function cancelDeployWatchRequestState(
  request: DeployWatchRequestState,
  message: string,
): DeployWatchEvent | null {
  request.canceled = true;
  request.cancelMessage = message;

  if (request.phase === "starting") {
    return null;
  }

  return {
    state: "canceled",
    message,
    ca: request.ca,
    pairAddress: request.pairAddress,
  };
}

export function throwIfDeployWatchRequestCanceled(
  request: DeployWatchRequestState,
): void {
  if (request.canceled) {
    throw new DeployWatchCanceledError(request.cancelMessage);
  }
}
