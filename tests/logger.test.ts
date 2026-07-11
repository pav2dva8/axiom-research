import test from "node:test";
import assert from "node:assert/strict";

import { redactLogSecrets } from "../src/ui/logger";

test("redactLogSecrets removes bearer tokens, auth cookies, and proxy passwords", () => {
  const line = [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    "Cookie: auth-access-token=access-secret; auth-refresh-token=refresh-secret; cf_clearance=cf-secret; __cf_bm=bm-secret",
    "proxy=http://user:proxy-pass@example.com:9000",
    "{ username: 'proxy-user', password: 'object-pass', proxyPassword: \"camel-pass\", pass: 'short-pass' }",
  ].join(" ");

  const redacted = redactLogSecrets(line);

  assert.equal(redacted.includes("access-secret"), false);
  assert.equal(redacted.includes("refresh-secret"), false);
  assert.equal(redacted.includes("cf-secret"), false);
  assert.equal(redacted.includes("bm-secret"), false);
  assert.equal(redacted.includes("proxy-pass"), false);
  assert.equal(redacted.includes("object-pass"), false);
  assert.equal(redacted.includes("camel-pass"), false);
  assert.equal(redacted.includes("short-pass"), false);
  assert.match(redacted, /\[jwt\]/);
  assert.match(redacted, /auth-access-token=\[redacted\]/);
  assert.match(redacted, /auth-refresh-token=\[redacted\]/);
  assert.match(redacted, /cf_clearance=\[redacted\]/);
  assert.match(redacted, /__cf_bm=\[redacted\]/);
  assert.match(redacted, /http:\/\/user:\[redacted\]@example\.com:9000/);
  assert.match(redacted, /password: '\[redacted\]'/);
  assert.match(redacted, /proxyPassword: "\[redacted\]"/);
  assert.match(redacted, /pass: '\[redacted\]'/);
});
