# 更改日志

本文件记录 ProtoView 的版本变更。扩展详情页的「更改日志」标签会读取它。

## [0.1.0] — 2026-03-23

### 新增

- 按 `package` → `service` → 接口浏览工作区中的 `.proto`
- 接口预览：请求/响应 message、字段跳转、enum 跳转
- 识别 `MetaInf.Meta` 拦截器标签（Timeout、Auth、JwtSources、SessionConfig、LimitConfig 等）
- 接口名旁「定义」按钮，悬停展示完整 rpc 原文
- 侧边栏显示接口注释；支持跳转源码与重新解析
- 预览页「AI」入口：随机背景乐、山海解谜，通关后显示爱心与赞赏二维码
- ProtoView 商店图标（带 proto 字样）
- Proto 来源：默认工作区自动识别，或填写 Git 地址/分支拉取到系统临时目录后解析
- 独立入口「打开 ProtoView Client」：侧边栏浏览全部接口 + 环境/地址配置（文件存储，无 SQLite）
- Client 完善：package/service/接口树、亮暗色、刷新、Message 自动生成/格式化、Metadata 表格、顶部环境配置
- Client 侧边栏全部展开/收起、生成 grpcurl、Docs 按预览页排版请求/响应字段
- Client 响应区改为状态条 + JSON 块；VS Code 内由插件进程发送真实 gRPC
- Client Auth：None / Bearer / Basic / API Key / OAuth Token / WSSE，发送与 grpcurl 合并注入 Metadata
- Client Docs「跳转到源码」；编辑器内 Proto 格式化、类型补全、转到定义
- Client Message 左侧接口说明/定义；压测 Tab（轻量自建 + ghz 命令/运行）
- 压测可配置本机 ghz 路径；链路调试无限画布（拖拽/连线/变量/运行结果着色）