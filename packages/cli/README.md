# @zhhoceanfly/protoview

当前版本：**0.1.5**

ProtoView Client **CLI**：在浏览器里调试 gRPC / HTTP / SSE / WebSocket。适合 Rider 等无法安装 VS Code 扩展的 IDE。

与 [Open VSX 扩展](https://open-vsx.org/extension/zoceanfly/protoview) 共用同一套 Client 页面与调用逻辑。

## 安装

```bash
npm i -g @zhhoceanfly/protoview
# 或
npx @zhhoceanfly/protoview
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

## 自定义 Proto 来源

浏览器内点「自定义源」：

1. **自定义目录**：点「浏览」用浏览器选文件夹（可能提示确认上传），或直接填本机绝对路径 → 再点 **应用并刷新**
2. **自定义 Git**：填地址与分支 → 应用并刷新（clone 到系统临时目录）

## 跳转源码

顶部「源码」下拉（仅 CLI / 浏览器）：

| 选项 | 行为 |
| --- | --- |
| **内置预览**（默认） | 右侧边栏显示 `.proto` 并定位行 |
| Cursor / VS Code / 记事本 | 调起对应本机应用 |
| 系统自动 | 探测 `cursor` → `code` → JetBrains → `subl` |

也可环境变量指定：

```bash
# Windows PowerShell
$env:PROTOVIEW_EDITOR="cursor"
protoview --proto ./api

# 或自定义命令模板
$env:PROTOVIEW_EDITOR="cursor -g {file}:{line}"
$env:PROTOVIEW_EDITOR="idea --line {line} {file}"
```

## 仓库内开发

在 ProtoView 仓库根目录：

```bash
npm run dev:cli
npm run dev:cli -- --proto ./api --port 3920
```

改 `client/` 后刷新浏览器；改 TypeScript 会自动编译并重启服务。正式发布用 `npm run build:cli` / `npm run publish:cli`，或 GitHub Actions（见仓库 `PUBLISH.md`）。

## 与扩展的差异

| | VS Code / Cursor 扩展 | 本 CLI |
| --- | --- | --- |
| Client 调试 | 有 | 有 |
| 侧边栏 / 语言服务 | 有 | 无 |
| 跳转源码 | 编辑器内直接打开 | 内置预览，或 Cursor / VS Code / 记事本等 |
| 选本地目录 | VS Code 系统对话框 | 浏览器选文件夹上传，或填绝对路径 |
| 链路导入导出 | 系统对话框 | 浏览器下载 / 选文件 |

## License

MIT
