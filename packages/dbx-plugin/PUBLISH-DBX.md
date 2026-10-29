# ApiMan（ProtoView）→ DBX 插件市场上架工作流

本目录是 **ApiMan** DBX 插件（`.dbxp`，基于 ProtoView Client），与 VS Code 扩展（`.vsix`）独立打包、独立上架。

官方文档：[开发和提交 DBX 插件](https://dbxio.com/cn/docs/plugin-development)  
商店仓库：[`t8y2/dbx-store`](https://github.com/t8y2/dbx-store)（**不要**把插件源码 PR 进 `t8y2/dbx`）

---

## 0. 前置条件

| 项 | 说明 |
| --- | --- |
| Node.js | 构建 / Sidecar 运行 ≥ 18；**`dbx-plugin dev` 需要 ≥ 22**（官方 CLI 限制） |
| Go | ≥ 1.22（仅构建：`dbx-plugin package` 会编译 `backend/` 启动器） |
| DBX CLI | `npm i -g @dbx-app/plugin-cli` 或使用 `npx @dbx-app/plugin-cli` |
| DBX 桌面端 | 本地试装未签名包时，在「插件中心」开启 **允许安装未签名开发包** |
| GitHub | 本仓库可发 Release；首次上架需 Fork `dbx-store` 提 PR |

架构：`bin/protoview-dbx`（Go）把 Host 的 stdio 转发给 `runtime/sidecar.js`（Node + `ClientHost`）。

插件身份（发布后勿改 `id` / `publisher`）：

- `id`: `io.github.zhhoceanfly.protoview`
- `publisher`: `zhhoceanfly`（须与 id 命名空间一致）
- Workbench: `io.github.zhhoceanfly.protoview.client`
- 权限含 `host.binary`（Go 启动器会 `spawn node`）
- 运行机需要 **Node.js ≥ 18** 在 PATH

---

## 1. 本地开发

```bash
# 仓库根目录
npm install
npm run build:dbx          # 编译 core + 复制 UI + 安装 runtime 依赖

# 开发宿主需要 Node 22+（本机已装可用：nvm use 22.10.0）
nvm use 22
npm run dev:dbx            # 浏览器打开终端打印的 http://127.0.0.1:5190/
```

仅改前端时：

```bash
cd packages/dbx-plugin
npm run build:ui
# 或 watch：npm run build:ui:watch
```

验收清单：

- [ ] Workbench 能打开，Sidecar 握手成功（无 `Sidecar identity or protocol` 错误）
- [ ] 自定义源：本地目录上传 / Git 拉取后树有接口
- [ ] gRPC / HTTP 调用有结果；压测进度能推送
- [ ] 浅色/深色主题跟随 DBX（`data-dbx-theme`）
- [ ] Manifest 权限仅为 `host.workbench` / `host.events` / `host.storage`

---

## 2. 打未签名候选包

在 `packages/dbx-plugin`：

```bash
npm run package
# 等价于：npm run build && npx @dbx-app/plugin-cli package . --output-dir dist
```

产物：

```
dist/<plugin-id>-<version>-<target>.dbxp
dist/<plugin-id>-<version>-<target>.artifact.json
```

- 含 Node Sidecar 时一般为 **当前平台** target（如 `win-x64` / `linux-x64` / `darwin-arm64`），不是 `universal`
- 多平台请用 CI（见 `.github/workflows/publish-dbx-plugin.yml`）在对应 runner 上各打一份
- **不要**把 `.dbxp` 提交进 Git

本地试装：DBX → 插件中心 → 允许未签名开发包 → 安装上述 `.dbxp`。

---

## 3. 源码 Tag + GitHub Release（第一步）

1. 递增 `packages/dbx-plugin/manifest.json` 的 `version`（及 `.dbx-store.json` / store 候选模板中的版本）
2. 打 **DBX 专用 Tag**（勿用 `ext-v*` / `cli-v*`，避免触发 Open VSX / npm）：
   ```bash
   git tag dbx-v0.1.0 && git push origin dbx-v0.1.0
   ```
   CI（`publish-dbx-plugin.yml`）会打多平台 `.dbxp` 并创建/更新 GitHub Release。
3. 也可本机 `npm run package:dbx` 后手工挂 Release，资产需包含：
   - 每个平台的 `.dbxp`
   - 对应 `.artifact.json`
   - 汇总的 `release-candidates.json`
4. Release 资产 URL 必须是 **HTTPS、不可变**（按 Tag/版本路径）；不要指向 `dbx-store` 已签名包

三渠道 Tag 约定：

| 渠道 | Tag | Workflow |
|------|-----|----------|
| Open VSX | `ext-v0.1.5` | `publish-openvsx.yml` |
| npm CLI | `cli-v0.1.5` | `publish-npm-cli.yml` |
| DBX | `dbx-v0.1.0` | `publish-dbx-plugin.yml` |

`release-candidates.json` 必须符合 `t8y2/dbx-store` 的 `scripts/sync-release-candidate.mjs`（`plugin` + `artifacts`，不是旧的 `id/version/targets`）：

```json
{
  "plugin": {
    "id": "io.github.zhhoceanfly.protoview",
    "publisher": "zhhoceanfly",
    "version": "0.1.1",
    "name": "ApiMan",
    "description": "…",
    "permissions": ["host.workbench", "host.events", "host.storage", "host.binary"]
  },
  "artifacts": [
    {
      "target": "windows-x64",
      "url": "io.github.zhhoceanfly.protoview-0.1.1-windows-x64.dbxp",
      "sha256": "<64 hex>",
      "size": 123456
    }
  ]
}
```

`artifacts[].url` 可用裸文件名（推荐）或指向同一 tag 的完整 GitHub Release HTTPS URL。

计算哈希与大小（示例）：

```bash
# Git Bash / Linux / macOS
sha256sum dist/*.dbxp
wc -c dist/*.dbxp
```

---

## 4. 提交 dbx-store 候选 PR（第二步）

目标仓库：**`t8y2/dbx-store`**，目标分支：**`main`**。

### 4.1 首次上架（手动 PR）

1. Fork `t8y2/dbx-store`
2. 在 PR 中加入：
   - `publishers/zhhoceanfly.json` ← 见本目录 `store/publishers.zhhoceanfly.json`
   - `candidates/io.github.zhhoceanfly.protoview.json` ← 见本目录 `store/io.github.zhhoceanfly.protoview.json`（填真实 sha256/size）
3. 按 PR 模板填写：能力、权限、是否有原生 Sidecar、数据/网络访问说明
4. **不要**提交：`.dbxp` 二进制、完整插件源码、签名私钥、`verified: true`、已签名包 URL
5. CI 会保持红色并提示 `open candidate(s) awaiting DBX Store signing`——这是预期行为，不是作者侧失败

可选：另提 PR 把本仓库登记到 `automation/plugin-sources.json`（`autoUpdate: true`），之后版本可由商店同步机器人自动开候选 PR。

### 4.2 已登记 autoUpdate 时

只发新 Release + `release-candidates.json`；商店同步 Workflow 会更新 `candidates/<id>.json`。无需每个版本手改商店，除非要改展示名/标签等（可改本仓库 `.dbx-store.json`）。

---

## 5. 审核签名与合并（第三、四步）

1. 维护者审查源码、Manifest、权限、SHA-256/size、Sidecar 行为
2. 维护者在候选 PR 上触发受保护的 **Sign plugin PR candidates**（或 `/sign`）
3. Workflow：按 pin 下载未签名包 → 校验 → Ed25519 签名 → 发布正式资产 → 回写 `plugins/*.json` + `catalog/index.json`，并删掉 `candidates/*.json`
4. CI 变绿后，维护者合并 PR → 官方插件中心可见

作者 **不要** 运行 `dbx-plugin keygen`，也 **不要** 在 Manifest/候选里填 `signingKeyId`。

---

## 6. 后续版本更新

1. 改代码，**递增** `manifest.json` 的 `version`（禁止覆盖同版本 Release 资产）
2. 新 Tag + 新候选 Release
3. 自动同步或手动只提交 **新版本** 的 `candidates/<id>.json`
4. 等待签名合并

插件 Bug 在本仓库修；只有目录/文案/哈希等商店元数据才进 `dbx-store`。

---

## 7. 本仓库文件对照

| 路径 | 用途 |
| --- | --- |
| `manifest.json` | 运行时契约（id/version/权限/入口/贡献点） |
| `dbx-plugin.toml` | 打包 include + dev 构建命令 |
| `.dbx-store.json` | 商店展示元数据（可选，首次/改文案时用） |
| `backend/main.go` | Go 启动器（官方 CLI 要求的 native sidecar 入口） |
| `runtime/sidecar.js` | Node JSON-RPC worker（包住 `ClientHost`） |
| `ui/` | 构建产物（来自根目录 `client/`） |
| `store/*.json` | 提交 `dbx-store` 时的 PR 素材模板 |
| `../../scripts/build-dbx-plugin.js` | 一键构建 |
| `../../.github/workflows/publish-dbx-plugin.yml` | Tag `*-dbx` 时打多平台候选包 |

---

## 8. 已知限制（MVP）

- 原生入口是 Go，业务仍在 Node worker；运行机需 Node.js ≥ 18
- 不含 VS Code 侧边栏树、语言服务；DBX 内以 Workbench Client 为主
- 未声明 `host.network:*`；出站由 Node Sidecar 本机发起（gRPC/HTTP 等），不经过浏览器 CSP
- 包内含 `runtime/node_modules`，体积较大；审核若要求纯 Go/Rust 实现可再迭代
