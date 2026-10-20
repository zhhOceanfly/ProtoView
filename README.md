# ProtoView

在 VS Code / Cursor 中浏览与调试 Protobuf：按 `package → service → 接口` 组织侧边栏，支持类型跳转、源码定位，并提供 **ProtoView Client**（gRPC / HTTP / SSE / WebSocket 发请求、Auth、压测、链路调试）。

当前版本：**0.1.2**

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

私有仓库依赖本机已配置的 Git 凭据。

### ProtoView Client

侧边栏「打开 ProtoView Client」：

- **接口树**：筛选、展开/收起、亮暗色主题
- **环境**：多环境 host，保存在工作区 `.protoview/environments.json`
- **Message / Metadata / Auth / Docs**：样例生成、格式化、Auth 合并进 Metadata、Docs 跳转源码
- **协议**：每个接口可选 gRPC / HTTP / SSE / WebSocket；HTTP、SSE 再选方法与路径，WebSocket 填路径
- **真实调用**：均由扩展宿主进程发起（明文 / TLS；SSE 收事件流，WebSocket 收文本帧）
- **grpcurl**：一键生成命令（仅 gRPC）
- **压测**：轻量并发对上述协议可用；`ghz` 仅在 gRPC 时显示
- **链路调试**：画布拖拽接口、连线、变量提取；节点内选择协议与环境；可查看运行与压测历史

## 快速开始

1. 安装扩展后打开含 `.proto` 的工作区（或配置 Git 来源）
2. 活动栏打开 **ProtoView** 侧边栏
3. 点击接口预览，或打开 **ProtoView Client** 调试

### 设置

| 设置项 | 说明 |
| --- | --- |
| `protoview.showGoogle` | 是否在树中显示 `google.*` 标准包（默认关闭；关闭时仍会解析以便跳转） |

## 开发与打包

要求：**Node.js 18+**（推荐 **20.x**；Node 22 下全局 `@vscode/vsce@4` 可能报错）。

```bash
npm install
npm run compile           # 编译 TypeScript → out/
npm run watch             # 监听编译
npm run package           # 编译并打出 protoview-x.y.z.vsix（含生产依赖）
npm run package:precheck  # 预览将打进包的文件
npm run package:fresh     # 删除旧 vsix 后重新打包
```

本地调试：按 F5（「运行 ProtoView」）打开 Extension Development Host。

### 发布到 VS Code Marketplace

1. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建 Publisher（本扩展 `publisher` 为 `zoceanfly`）
2. **方式 A（推荐，无需 PAT）**：`npm run package` 后，在管理页上传生成的 `.vsix`
3. **方式 B**：创建 [Azure DevOps PAT](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)（Marketplace → Manage），再执行：

```bash
npx vsce login zoceanfly
npm run publish
# 或 npm run publish:patch / publish:minor
```

扩展页：`https://marketplace.visualstudio.com/items?itemName=zoceanfly.protoview`

### 发布到 Open VSX（让 Cursor 能搜到）

Cursor 默认走 [Open VSX](https://open-vsx.org/)，需单独发布（与 VS Code 商店无关）。

1. 登录 https://open-vsx.org → Profile **签署** Eclipse Open VSX Publisher Agreement  
2. [Access Tokens](https://open-vsx.org/user-settings/tokens) 创建 Token（**只放在环境变量里，不要写进仓库**）  
3. 本机（推荐 Node 20）：

```bash
nvm use 20.18.0
export OVSX_PAT=ovsxat_你的token   # PowerShell: $env:OVSX_PAT="ovsxat_你的token"

npm run openvsx:namespace          # 首次创建命名空间 zoceanfly（只需一次）
npm run publish:openvsx            # 打包并发布到 Open VSX
```

脚本说明见 `scripts/openvsx-publish.js`。发布后页面：  
`https://open-vsx.org/extension/zoceanfly/protoview`  
Cursor 索引可能有延迟；也可在 Cursor 里用「从 VSIX 安装」。

仅内部分发时，对方可用「从 VSIX 安装…」安装 `protoview-*.vsix`。

### 图标

- `media/icon.png`：商店与扩展详情（≥128×128 PNG）
- `media/icon.svg`：活动栏单色图标（随主题变色）

## 许可

MIT License（仓库根目录 `LICENSE` 文件）。
