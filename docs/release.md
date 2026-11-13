# Release preparation

This repository is a local beta, not a deployed service or published npm package. See the
[dated local validation](validation.md) for evidence and remaining limits.

1. Confirm the GitHub owner/repository, npm scope/package availability, license ownership and
   private security reporting channel. Add verified repository metadata to package.json and update
   placeholder/provisional statements.
2. Run `npm ci` and `npm run check` on a clean checkout. Inspect the package file list, source
   history and lockfile. Include no backend code, credentials or real audio.
3. Verify REST and MCP separately in an authorized staging environment. Validate worker, quota,
   consent, watermark enforcement, authenticated downloads, revocation, loss of response,
   cancellation and mutation recovery. Use two different owners and authorized voice recordings. Do
   not announce live availability from unit tests alone.
4. Prepare a concrete GitHub/npm release candidate for owner review. Creating source code locally
   does not authorize publication or service activation.
5. Once publication is authorized, configure the package and trusted npm publisher with the exact
   repository/workflow identity. The included release workflow validates only; it deliberately
   contains no publish command. Add publication as a separately reviewed change after the package
   and ownership exist.
6. After endpoint validation, consider MCP Registry remote metadata. This is separate from the REST
   SDK package; no server package is needed just to describe an existing remote endpoint.

The workspace root is private; only `packages/sdk` is a publishable package. Document service
status, tested client versions and remaining limitations in the release notes. Keep the backend's
operational runbooks private.
