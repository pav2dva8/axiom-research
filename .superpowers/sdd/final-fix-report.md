# Register Final Fix Report

Date: 2026-07-11

## What changed

- Added `*_fresh_keys.txt` to `.gitignore` so dated fresh-key files at the repo root are ignored.
- Changed register account persistence to write token JSON before appending the secret key to the fresh-keys file.
- Added `RegisterRunError` so register run failures carry accumulated progress counts and the actual output file path.
- Updated the UI server register failure broadcast to reuse service progress instead of resetting counters to `0/0`.
- Added register-service regression coverage for write ordering and accumulated write-failure progress.

## Test output

- `node --import tsx --test tests/register-service.test.ts`: PASS, 7 tests passed. Observed existing `punycode` deprecation warning.
- `node --import tsx --test tests/register-config.test.ts tests/register-service.test.ts tests/auth-signup-signature.test.ts`: PASS, 11 tests passed. Observed existing `punycode` deprecation warning.
- `npm run build:web`: PASS. Observed existing `MODULE_TYPELESS_PACKAGE_JSON` warning for `src/ui/web/postcss.config.js`.
- `npm run build`: PASS.

## Commits

- `42178ae fix(register): preserve write-failure progress`
