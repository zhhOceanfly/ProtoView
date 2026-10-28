# Third-party notices (ApiMan DBX runtime)

## Bundled Node.js

`runtime/node/` contains an official Node.js binary downloaded at package build
time from `https://nodejs.org/dist/` (see `runtime/node/VERSION` / `README.md`).
Node.js is MIT-licensed; upstream `LICENSE` is copied into that folder when
present in the archive.

The Go launcher prefers this bundled binary (`host.binary`); PATH Node is only a
fallback for local development if the bundle is missing.

## npm dependencies in `runtime/node_modules/`

Produced by `npm install` for the sidecar worker `runtime/sidecar.js`
(see `runtime/package.json`). Direct dependencies:

| Package | License | Role |
| --- | --- | --- |
| `@grpc/grpc-js` | Apache-2.0 | gRPC client |
| `@grpc/proto-loader` | Apache-2.0 | load `.proto` |
| `protobufjs` | BSD-3-Clause | encode/decode |

Transitive packages keep their upstream licenses inside each package directory
under `runtime/node_modules/` (or re-check via `npm ls` after install).

Plugin source code is MIT — see root `LICENSE` in this package.
