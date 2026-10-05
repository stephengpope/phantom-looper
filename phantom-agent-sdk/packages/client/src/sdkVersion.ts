// This package's version — the same number as package.json, kept in step by
// the build (phantom-agent-sdk/scripts/assert-sdk-version.mjs). A constant
// rather than a package.json read because the client rides bundled into
// apps (the cli is one file) where no package.json travels with it. Client
// and backend are ONE version: the backend reports its on GET /health, the
// client compares before its first request (BackendClient).
export const SDK_VERSION = '0.1.0';
