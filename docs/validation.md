# Local validation — 2026-11-13

Candidate: `@vocloner/sdk@0.1.0-beta.1`. Environment: Node.js 22.14.0, npm 10.9.2, TypeScript 5.9.3.
No service credentials were used.

`npm run check` passed:

- Public OpenAPI/Postman SHA-256 provenance and generated types are current.
- Strict SDK and example compilation passes.
- **58 tests pass:** 16 client, 24 transport/audio, 10 webhook, 8 generator.
- Formatting passes.
- The real npm tarball contains 17 allowed files, no runtime dependencies and no backend imports.
  Offline installation in a clean temporary project, both exported entry points, an injected mock
  request and consumer TypeScript checks pass.

The independent review identified recovery metadata lost after malformed accepted responses, a timer
leaked for an invalid supplied job, unbounded/unsanitized stream cancellation and case-sensitive
UUID comparisons. These were corrected; seven regression cases failed before and passed after the
corrections.

The package check creates local subprocesses for npm and TypeScript. A sandbox that prohibits those
subprocesses must allow that local check; otherwise it cannot claim isolated-package installation
was verified. Unit tests run in a single process so they report actual cases rather than child-file
wrappers.

## Not yet validated

- Node.js 24 execution and GitHub Actions. A 22/24 CI matrix is configured only.
- Live API/MCP availability, OAuth in real clients, service worker deployment, real voice
  generation, watermark verification, quotas or Storage in staging.
- Recovery of pending backend mutation claims. The SDK bounds retries and reports the state; this
  candidate does not change the backend.
- Uploads/cloning and other planned SDK methods. The beta implements ten operations.
- npm scope/repository ownership, GitHub/npm/MCP Registry publication.

The repository has independent Git history and is configured for `Vocloner/vocloner-integrations`.
GitHub authentication and upload are separate from these local checks. The tarball is a local build
artifact, not an npm release.
