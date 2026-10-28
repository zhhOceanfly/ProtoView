# ProtoView

在 VS Code / Cursor 中浏览与调试 Protobuf：按 `package → service → 接口` 组织侧边栏，支持类型跳转、源码定位，并提供 **ProtoView Client**（gRPC / HTTP / SSE / WebSocket 发请求、Auth、压测、链路调试）。

Rider 等环境可用 npm CLI：`npx @zhhoceanfly/protoview` 在浏览器打开同一套 Client。

当前扩展版本：**0.1.5** · CLI：`@zhhoceanfly/protoview@0.1.5`

## 功能概览

### Proto 浏览

- 按 `package` / `service` / RPC 浏览工作区或 Git 仓库中的 `.proto`
- 接口预览：请求/响应 message、字段与 enum 互跳、跳转源码
- 识别常见拦截器标签（Timeout、Auth、Jwt 等）
- Proto 语言：格式化、补全、转到定义

### Proto 来源

侧边栏顶部可切换：

| 模式 | 说明 |
| --- | --- |
| 工作区自动识别（默认） | 扫描当前工程内 `.proto` |
| 自定义 Git | 填写仓库地址与分支，clone/fetch 到系统临时目录后解析 |

私有仓库依赖本机已配置的 Git 凭据。Client 内也可点「自定义源」做同样配置。

### ProtoView Client

侧边栏「打开 ProtoView Client」：

- **接口树**：筛选、展开/收起、亮暗色主题
- **环境**：多环境 host，保存在工作区 `.protoview/environments.json`
- **Message / Metadata / Auth / Docs**：样例生成、格式化、Auth 合并进 Metadata、Docs 跳转源码
- **协议**：每个接口可选 gRPC / HTTP / SSE / WebSocket；HTTP、SSE 再选方法与路径，WebSocket 填路径
- **真实调用**：由扩展宿主（或 CLI 本地服务）发起
- **grpcurl**：一键生成命令（仅 gRPC）
- **压测**：轻量并发；`ghz` 仅在 gRPC 时显示
- **链路调试**：画布拖拽、连线、变量提取、导入/导出配置

## 快速开始

### VS Code / Cursor 扩展

1. 从 Marketplace / Open VSX 安装 **ProtoView**，或「从 VSIX 安装」
2. 打开含 `.proto` 的工作区（或配置 Git 来源）
3. 活动栏打开 **ProtoView** → 预览接口，或打开 **ProtoView Client**

扩展页：

- Marketplace：`https://marketplace.visualstudio.com/items?itemName=zoceanfly.protoview`
- Open VSX：`https://open-vsx.org/extension/zoceanfly/protoview`

### Rider / 无 VS Code：CLI Client

```bash
npm i -g @zhhoceanfly/protoview
protoview --proto ./你的proto目录
# 或
npx @zhhoceanfly/protoview --git https://github.com/org/repo.git --branch main
```

浏览器打开 `http://127.0.0.1:3920/`。更多参数见 [`packages/cli/README.md`](packages/cli/README.md)。

### 设置

| 设置项 | 说明 |
| --- | --- |
| `protoview.showGoogle` | 是否在树中显示 `google.*` 标准包（默认关闭；关闭时仍会解析以便跳转） |

## 开发

```bash
npm install
npm run compile
npm run dev:cli          # CLI 开发：改 client/ 刷新浏览器，改 .ts 自动重启
```

按 **F5**（「运行 ProtoView」）启动扩展调试。调试宿主会 `--disable-extensions`，只加载本仓库开发版，避免与已安装的商店版（同 ID `zoceanfly.protoview`）冲突；主窗口里的商店版不受影响。打包与发布见 **[Publish.md](Publish.md)**。

## 许可

MIT License（仓库根目录 `LICENSE` 文件）。
