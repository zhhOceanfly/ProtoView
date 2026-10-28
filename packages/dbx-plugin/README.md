# ApiMan for DBX

将 ApiMan（ProtoView Client）以 DBX 插件（`.dbxp`）形式运行：Workbench UI + Node Sidecar（复用仓库内 `ClientHost` / gRPC 等核心）。

商店展示名：**ApiMan**；稳定插件 ID 为 `io.github.zhhoceanfly.protoview`；publisher 为 **`zhhoceanfly`**。

**运行时：** 打包时下载官方 Node 到 `runtime/node/` 一并打进 `.dbxp`，用户无需本机安装 Node。Go 启动器优先用内置二进制（仍声明 `host.binary`）。

**体积 / 许可：** `runtime/node_modules/` 来自 sidecar 的 npm 依赖（`@grpc/grpc-js` 等），来源与许可见包内 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)（打进 `.dbxp`，见 `dbx-plugin.toml` 的 `include`）。

商店候选文件必须命名为 `candidates/io.github.zhhoceanfly.protoview.json`（不要多一层 `candidates.` 前缀）。素材在 `store/`。

## 快速开始

```bash
# 仓库根目录
npm install
npm run build:dbx
npm run package:dbx
```

本地开发宿主（**需要 Node.js 22+**，`@dbx-app/plugin-cli` 限制）：

```bash
nvm use 22          # 本机若用 nvm；当前仓库构建可用 18/20
npm run dev:dbx
```

试装：在 DBX「插件中心」开启未签名开发包，安装 `dist/*.dbxp`。

正式包自带 Node；仅本地 `dbx-plugin dev` 要求宿主 Node 22+。

## 上架

完整步骤见 [PUBLISH-DBX.md](./PUBLISH-DBX.md)。商店 PR 提交到 [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store)，不要提交到 `t8y2/dbx`。
