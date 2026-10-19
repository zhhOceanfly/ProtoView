# 更改日志

本文件记录 ProtoView 的版本变更。扩展详情页的「更改日志」标签会读取它。

## [0.1.1] — 2026-10-19

### 新增

- Client 每个接口可在环境左侧选择 **gRPC / HTTP**；HTTP 可再选 GET、POST、PUT、PATCH、DELETE，并填写路径
- HTTP 真实请求与轻量压测（GET/DELETE 走 query，其余发 JSON；Metadata 作为 Header）
- 仅 gRPC 显示 ghz 压测
- 链路节点编辑顶部可设置协议、HTTP 方法、路径和环境；运行与压测按节点自己的配置发送
- 活动栏与商店图标改为单色 **PV** 字标

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
