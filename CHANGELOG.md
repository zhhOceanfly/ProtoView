# 更改日志

本文件记录 ProtoView 的版本变更。扩展详情页的「更改日志」标签会读取它。

## [0.1.3] — 2026-10-20

### 新增

- Client / 链路节点支持 **SSE**、**WebSocket**（与 gRPC / HTTP 并列选择）
- SSE：按 `text/event-stream` 读取事件流，返回事件列表
- WebSocket：握手后发送 Message，收集服务端文本帧
- Client 左上角「自定义源」：弹层内配置工作区 / Git（不走 VS Code QuickPick），Git 仍拉取到系统临时目录
- 链路调试顶栏「压测」旁增加导入 / 导出，保存节点、连线与协议等配置为 JSON
- npm 包 **`@zhhoceanfly/protoview`**：CLI 本地起服务，浏览器打开 Client（Rider 等可用）

### 调整

- 去掉 AI 页背景音乐与「音乐」按钮
- 商店图标去掉半透明描边，改为实心圆角字标
- 抽离无 vscode 依赖的 `hostCore` / `sourceCore`，扩展与 CLI 共用解析与调用

## [0.1.2] — 2026-10-19

### 调整

- 图标恢复为原来的 **proto** 字标，并加大字号

## [0.1.1] — 2026-10-19

### 新增

- Client 每个接口可在环境左侧选择 **gRPC / HTTP**；HTTP 可再选 GET、POST、PUT、PATCH、DELETE，并填写路径
- HTTP 真实请求与轻量压测（GET/DELETE 走 query，其余发 JSON；Metadata 作为 Header）
- 仅 gRPC 显示 ghz 压测
- 链路节点编辑顶部可设置协议、HTTP 方法、路径和环境；运行与压测按节点自己的配置发送

### 调整

- 链路调试顶栏不再放全局环境，环境改到每个节点
- 补充 `repository` / `homepage`，便于 Marketplace 与 Open VSX 认领

## [0.1.0] — 2026-10-19

首个面向 Marketplace 的发布版本。

### Proto 浏览

- 按 `package → service → 接口` 浏览工作区 / Git 来源中的 `.proto`
- 接口预览：请求/响应 message、字段与 enum 跳转、跳转源码
- 识别 `MetaInf.Meta` 等拦截器标签（Timeout、Auth、JwtSources 等）
- 侧边栏注释展示；接口「定义」悬停查看完整 rpc 原文
- Proto 来源：工作区自动识别，或 Git 地址/分支拉取到临时目录
- `.proto` 语言支持：格式化、补全、转到定义

### ProtoView Client

- 独立 Client：接口树、环境配置（`.protoview/environments.json`）、亮暗色
- Message 样例生成/格式化；左侧接口说明；Metadata 表格
- Auth：None / Bearer / Basic / API Key / OAuth Token / WSSE，发送与 grpcurl 注入 Metadata
- Docs 排版请求/响应字段，支持跳转源码
- 真实 gRPC 调用（扩展宿主进程）；响应区状态条 + JSON
- 生成 grpcurl 命令；可调节 Request/Response 分栏
- 压测：轻量并发；可选本机 ghz 路径与运行

### 链路调试

- 无限画布：从左侧拖入/双击添加接口节点，缩放平移、端口连线
- 节点编辑：嵌套 Message / repeated 增删；Metadata；响应提取变量（嵌套展开，如 `TokenInfo.AccessToken`）
- 运行链路：变量 `{{name}}` 传递；成功/失败着色
- 右键「查看响应」：运行与压测调用历史
- 顶栏环境选择；右侧轻量链路压测抽屉（无 ghz）
- 「链路调试」入口按钮渐变特效

### 其它

- 预览页 AI 小游戏入口与赞赏二维码
- 商店图标与打包脚本（`npm run package`）
