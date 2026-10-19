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
