# Third-party notices (ApiMan DBX runtime)

## Runtime requirement (Node.js)

The Go launcher (`bin/protoview-dbx`, `host.binary`) resolves `node` / `node.exe`
via `PATH` (`exec.LookPath`) and runs `runtime/sidecar.js`. **Node.js ≥ 18 must
be installed on the host.** If Node is missing or too old, the launcher exits
non-zero with an actionable install hint (https://nodejs.org/). This package
does **not** bundle a Node binary under `runtime/node/`.

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
