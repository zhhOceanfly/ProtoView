# ProtoView

在 VS Code / Cursor 里浏览 Protobuf。工作区中的 `.proto` 会按 `package` 归类，其下再按 `service`、接口展开。点开接口可以看到请求和响应 message，类型、message、enum 之间可以互相跳转，也能回到源码。

## 本地运行

```bash
npm install
npm run compile
```

用「运行 ProtoView」启动调试（F5）。新窗口会打开当前工程，活动栏或面板里出现 **ProtoView**。

## 图标

- `media/icon.png`：商店和扩展详情里的图标。
- `media/icon.svg`：活动栏使用的单色图标，会跟着主题变色。

## package.json 各项是做什么的

| 字段 | 作用 |
| --- | --- |
| `name` | 扩展 ID 的后半段，只能用小写和连字符。商店地址里是 `publisher.name`，这里是 `protoview`。 |
| `displayName` | 商店和扩展列表里给人看的名字，搜索时主要匹配它。 |
| `description` | 商店简介，一句话说明做什么。 |
| `version` | 语义化版本。每次发布都要比商店里已有版本更高。 |
| `publisher` | 发布者 ID。现在的 `local` 只能本地调试；发布前要改成你在 Marketplace 里创建的发布者 ID。 |
| `icon` | 商店图标，指向 `media/icon.png`（至少 128×128）。 |
| `keywords` | 商店搜索关键词。 |
| `engines.vscode` | 能安装这个扩展的最低 VS Code 版本。 |
| `categories` | 商店分类。 |
| `activationEvents` | 何时加载扩展：打开 ProtoView 视图、执行相关命令，或工作区里存在 `.proto`。 |
| `main` | 扩展入口，编译后的 `out/extension.js`。 |
| `contributes.commands` | 命令面板里的命令。`category` 为 `ProtoView` 时，显示成「ProtoView: …」。 |
| `contributes.viewsContainers` | 活动栏上的 ProtoView 入口。`title` 是标签文字，`icon` 是活动栏图标。 |
| `contributes.views` | 这个入口里的树。拖到面板后，标签名也来自容器的 `title`。 |
| `contributes.menus` | 刷新按钮、树节点右键「跳转到源码」、编辑器右键「预览光标所在定义」。 |
| `contributes.configuration` | 设置项 `protoview.showGoogle`：是否在树里显示 `google.*` 标准包。 |
| `scripts` | `compile` 编译 TypeScript，`watch` 持续编译。 |

`id`（例如 `protoview.explorer`）是程序内部标识，不要随意改，菜单和激活事件都靠它。

## 发布到商店，让别人能搜到

1. 打开 [Visual Studio Marketplace 管理页](https://marketplace.visualstudio.com/manage)，用微软账号创建一个 **Publisher**。记下发布者 ID。
2. 把 `package.json` 里的 `publisher` 改成这个 ID。`displayName` 保持 `ProtoView`，别人在扩展商店搜这个名字就能找到。
3. 在 [Azure DevOps](https://dev.azure.com/) 创建一个个人访问令牌（Personal Access Token），组织选 All accessible organizations，权限勾选 **Marketplace → Manage**。
4. 安装发布工具并登录：

```bash
npm install -g @vscode/vsce
vsce login <你的发布者ID>
```

5. 确认已经 `npm run compile`，然后发布：

```bash
vsce publish
```

`vsce` 会按 `.vscodeignore` 打包。源码、`Proto` 示例和 `node_modules` 不会打进去，`out/`、`media/` 和本说明会打进去。

只想先发给同事、不公开到商店时，可以：

```bash
vsce package
```

得到 `protoview-0.1.0.vsix`。对方在 VS Code 里选择「从 VSIX 安装…」即可，不需要上架。

发布之后，扩展页地址形如 `https://marketplace.visualstudio.com/items?itemName=<publisher>.protoview`。更新时把 `version` 加一，再执行一次 `vsce publish`。
