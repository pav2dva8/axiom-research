import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelDeployWatchRequestState,
  createDeployWatchRequestState,
  markDeployWatchPhase,
  shouldBroadcastDeployWatchEvent,
  throwIfDeployWatchRequestCanceled,
} from "../src/ui/deploy-watch-request";
import { DeployWatchCanceledError } from "../src/ui/deploy-watcher";

test("deploy watch request cancellation records state and emits one canceled event before starting", () => {
  const request = createDeployWatchRequestState({
    ca: "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
    pairAddress: "Amk61ySm6z9hWSRSEsCKiMMb3i1G8ph89wNP9FzhBzsN",
  });

  const event = cancelDeployWatchRequestState(
    request,
    "Deploy watch canceled by Stop.",
  );

  assert.deepEqual(event, {
    state: "canceled",
    message: "Deploy watch canceled by Stop.",
    ca: request.ca,
    pairAddress: request.pairAddress,
  });
  assert.throws(
    () => throwIfDeployWatchRequestCanceled(request),
    DeployWatchCanceledError,
  );
  assert.equal(shouldBroadcastDeployWatchEvent(request, event!), true);
  assert.equal(shouldBroadcastDeployWatchEvent(request, event!), false);
});

test("deploy watch request cancellation during viewer start does not emit a watch canceled event", () => {
  const request = createDeployWatchRequestState({
    ca: "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
    pairAddress: "Amk61ySm6z9hWSRSEsCKiMMb3i1G8ph89wNP9FzhBzsN",
  });
  markDeployWatchPhase(request, "starting");

  assert.equal(
    cancelDeployWatchRequestState(request, "Deploy watch canceled by Stop."),
    null,
  );
});
