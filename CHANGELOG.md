# 更改日志

本文件记录 ProtoView 的版本变更。扩展详情页的「更改日志」标签会读取它。

## [0.1.0] — 2026-03-23

### 新增

- 按 `package` → `service` → 接口浏览工作区中的 `.proto`
- 接口预览：请求/响应 message、字段跳转、enum 跳转
- 识别 `MetaInf.Meta` 拦截器标签（Timeout、Auth、JwtSources、SessionConfig、LimitConfig 等）
- 接口名旁「定义」按钮，悬停展示完整 rpc 原文
- 侧边栏显示接口注释；支持跳转源码与重新解析
