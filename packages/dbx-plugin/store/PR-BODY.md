## Summary

- First listing for **ApiMan** (`io.github.zhhoceanfly.protoview`)
- Publisher: `zoceanfly` (unverified)
- Unsigned candidates from https://github.com/zhhOceanfly/ProtoView/releases/tag/dbx-v0.1.1
- Package/manifest version: **0.1.0** (tag `dbx-v0.1.1` is the Release label only)

## Files in this PR

- `publishers/zoceanfly.json`
- `candidates/io.github.zhhoceanfly.protoview.json`

## Targets

| target | sha256 (prefix) | size |
| --- | --- | --- |
| darwin-arm64 | `239ad399…` | 4056557 |
| linux-x64 | `9cce4506…` | 4152038 |
| windows-x64 | `f204fb6b…` | 4219841 |

## Capabilities / permissions / native sidecar

- Contributions: `connection-provider` + `workbench` + toolbar command
- Permissions: `host.workbench`, `host.events`, `host.storage`
- Native sidecar: Go launcher + Node.js worker (Node ≥ 18 required on PATH at runtime)
- Network: no `host.network:*`; outbound gRPC/HTTP from sidecar process
- Candidate package is unsigned (awaiting DBX Store signing)

## Test plan

- [ ] Candidate schema validates
- [ ] SHA-256 / size match Release asset bytes
- [ ] Manifest id / version / publisher match candidate (`0.1.0`)
- [ ] Maintainer signing workflow after review
