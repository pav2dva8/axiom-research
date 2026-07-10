import {
  buildDeployTokenInfo,
  parseDeployWatchInput,
  type ParsedDeployWatchInput,
} from "./deploy-watcher";
import type { TokenInfo } from "./viewer-service";

export interface DeployWatchTarget {
  parsed: ParsedDeployWatchInput;
  tokenInfo: TokenInfo;
  resolvedByAxiom: boolean;
}

export function resolveDeployWatchTarget(input: string): DeployWatchTarget {
  const parsed = parseDeployWatchInput(input);
  return {
    parsed,
    tokenInfo: buildDeployTokenInfo(parsed),
    resolvedByAxiom: false,
  };
}
