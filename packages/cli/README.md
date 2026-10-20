# @zoceanfly/protoview

ProtoView Client **CLI**：在浏览器里调试 gRPC / HTTP / SSE / WebSocket。适合 Rider 等无法安装 VS Code 扩展的 IDE。

与 [Open VSX 扩展](https://open-vsx.org/extension/zoceanfly/protoview) 共用同一套 Client 页面与调用逻辑。

## 安装

```bash
npm i -g @zoceanfly/protoview
# 或
npx @zoceanfly/protoview
```

需要 **Node.js 18+**。Git 来源需本机已安装 `git`。

## 用法

```bash
protoview                       # 扫描当前目录 .proto，打开浏览器
protoview --proto ./api         # 指定目录
protoview --git https://github.com/org/repo.git --branch main
protoview --port 3920 --no-open
```

默认地址：`http://127.0.0.1:3920/`

环境配置保存在工作区目录下的 `.protoview/environments.json`。

## 仓库内开发

在 ProtoView 仓库根目录：

```bash
npm run dev:cli
npm run dev:cli -- --proto ./api --port 3920
```

改 `client/` 后刷新浏览器；改 TypeScript 会自动编译并重启服务。正式发布仍用 `npm run build:cli`。

## 与扩展的差异

| | VS Code / Cursor 扩展 | 本 CLI |
| --- | --- | --- |
| Client 调试 | 有 | 有 |
| 侧边栏 / 语言服务 | 有 | 无 |
| 链路导入导出 | 系统对话框 | 浏览器下载 / 选文件 |

## License

MIT
