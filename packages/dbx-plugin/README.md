# ApiMan for DBX

将 ApiMan（ProtoView Client）以 DBX 插件（`.dbxp`）形式运行：Workbench UI + Node Sidecar（复用仓库内 `ClientHost` / gRPC 等核心）。

商店展示名：**ApiMan**；稳定插件 ID 仍为 `io.github.zhhoceanfly.protoview`。

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

运行已安装插件的 Sidecar 仍只需 **Node.js ≥ 18** 在 PATH 中；仅 `dbx-plugin dev` 要求 22+。

## 上架

完整步骤见 [PUBLISH-DBX.md](./PUBLISH-DBX.md)。商店 PR 提交到 [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store)，不要提交到 `t8y2/dbx`。
