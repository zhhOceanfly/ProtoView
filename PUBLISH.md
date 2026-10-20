# ProtoView 打包与发布

本文说明如何打包、发布 **VS Code Marketplace**、**Open VSX（Cursor）** 以及 **npm CLI（`@zhhoceanfly/protoview`）**。日常使用说明见 [README.md](README.md)。

要求：**Node.js 18+**（推荐 **20.x**；Node 22 下全局 `@vscode/vsce@4` 可能报错）。

## 本地脚本一览

在仓库根目录：

| 脚本 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run compile` | 编译扩展 TypeScript → `out/` |
| `npm run watch` | 监听编译 |
| `npm run package` | 编译并打出 `protoview-x.y.z.vsix` |
| `npm run package:precheck` | 预览将打进 VSIX 的文件 |
| `npm run package:fresh` | 删除旧 vsix 后重新打包 |
| `npm run clean:vsix` | 删除根目录下所有 `.vsix` |
| `npm run publish` | 发布到 VS Code Marketplace（需已 login） |
| `npm run publish:patch` / `publish:minor` | 升版本并发布到 Marketplace |
| `npm run openvsx:namespace` | 在 Open VSX 创建 publisher 命名空间（首次） |
| `npm run publish:openvsx` | 打 VSIX 并发布到 Open VSX |
| `npm run build:cli` | 构建 npm 包 `@zhhoceanfly/protoview` |
| `npm run dev:cli` | CLI 开发模式：tsc watch + 直连 `client/`，改代码自动重启 |
| `npm run publish:cli` | 构建并 `npm publish` CLI 包 |

本地调试扩展：按 **F5**（「运行 ProtoView」）打开 Extension Development Host。

`packages/**` 已写入 [.vscodeignore](.vscodeignore)，打 VSIX 时不会打进 CLI 产物。

## 发布到 VS Code Marketplace

1. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建 Publisher（本扩展 `publisher` 为 `zoceanfly`）  
   管理页 URL 形如：`https://marketplace.visualstudio.com/manage/publishers/zoceanfly`  
   确认登录的 **Microsoft 账号** 就是拥有该 Publisher 的账号。
2. **方式 A（推荐，无需 PAT）**：先打包，再在管理页网页上传：

```bash
npm run package
# 得到 protoview-x.y.z.vsix → 管理页 → 上传新版本
```

3. **方式 B（`vsce` + Azure DevOps PAT）**：PAT 必须由「拥有 publisher 的同一个 Microsoft 账号」创建。

#### 创建正确的 PAT

1. 用**无痕窗口**打开 https://dev.azure.com → 登录，确认头像/邮箱是 Marketplace 里 `zoceanfly` 的那个账号（不要误登公司账号）  
2. 右上角头像 → **Personal access tokens** → **New Token**  
   （或：https://dev.azure.com → 任意组织 → User settings → Personal access tokens）  
3. 表单按下面填：

| 项 | 值 |
| --- | --- |
| Name | 任意，如 `vsce-protoview` |
| Organization | **All accessible organizations**（不要只选某个无关组织） |
| Expiration | 按需（如 90 天） |
| Scopes | **Custom defined** → 点 **Show all scopes** → 找到 **Marketplace** → 勾选 **Manage** |

4. **Create** 后立刻复制 token（只显示一次）

#### 登录并发布

```bash
npx vsce login zoceanfly
# 粘贴上面的 PAT；成功应提示 verification succeeded

npm run publish
# 或 npm run publish:patch / publish:minor
```

也可不 `login`，临时用环境变量（PowerShell）：

```powershell
$env:VSCE_PAT="你的PAT"
npm run publish
```

扩展页：`https://marketplace.visualstudio.com/items?itemName=zoceanfly.protoview`

仅内部分发时，对方可用「从 VSIX 安装…」安装 `protoview-*.vsix`。

#### 常见问题（`vsce login` / `publish`）

| 报错 / 现象 | 原因与处理 |
| --- | --- |
| `TF400813` + 用户 `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` | PAT 无效或**账号对不上**：Azure 解析不到身份。用**拥有 publisher 的同一 Microsoft 账号**按上文重建 PAT（建议无痕窗口确认账号），Organization 选 **All accessible organizations**，Scopes 勾 **Marketplace → Manage**，再 `npx vsce login zoceanfly` |
| `Access Denied` / View user permissions | `package.json` 的 `publisher` 与 Marketplace 上的 ID 不一致；本仓库必须是 `zoceanfly` |
| PAT 已过期 | 重建 PAT 并重新 `vsce login` |
| 提示输入 PAT 后仍失败 | 不要用 GitHub Token / npm Token；必须是 **Azure DevOps PAT**；勿多粘空格/换行 |
| 不想折腾 PAT | 用方式 A：`npm run package` 后在管理页上传 `.vsix` |

## 发布到 Open VSX（Cursor）

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

脚本说明见 [`scripts/openvsx-publish.js`](scripts/openvsx-publish.js)。发布后页面：  
`https://open-vsx.org/extension/zoceanfly/protoview`

Cursor 对 Open VSX 有镜像同步延迟（常见数小时）；也可在 Cursor 里用「从 VSIX 安装」。用完整 ID 搜索：`zoceanfly.protoview`。

## 发布 npm CLI（`@zhhoceanfly/protoview`）

供 Rider 等环境在浏览器使用 ProtoView Client，与扩展共用 Client 页面逻辑。包目录：[`packages/cli`](packages/cli)，说明见 [`packages/cli/README.md`](packages/cli/README.md)。

npm 组织：**`zhhoceanfly`**（与 VS Code Marketplace publisher `zoceanfly` 不同，勿混用）。

### 前置条件

1. 在 [npmjs.com](https://www.npmjs.com/signup) **注册官方账号**（不要用 CNPM / npmmirror 注册页）  
2. 已创建组织 [zhhoceanfly](https://www.npmjs.com/settings/zhhoceanfly/members)，且当前账号为 owner / 有 publish 权限  
3. 包为**公开**包（`publishConfig.access: public`；首次发布 scoped 包必须 `--access public`）  
4. **登录必须指向官方 registry**（见下；国内若把默认源改成了 npmmirror，直接 `npm login` 会进 CNPM 并报 `Public registration is not allowed`）

```bash
# 查看当前源（若是 registry.npmmirror.com / cnpmjs，发布前不要用默认 login）
npm config get registry

# 只对官方源登录（推荐；不必改掉日常安装用的镜像）
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

浏览器应打开 **npmjs.org** 的登录/授权页，而不是「Sign up to CNPM」。  
`packages/cli` 已配置 `publishConfig.registry = https://registry.npmjs.org/`，`npm run publish:cli` 会发到官方源；日常 `npm install` 仍可用你在 `~/.npmrc` 里配的 npmmirror。

组织已创建则为 `zhhoceanfly`；包名必须是 `@zhhoceanfly/protoview`（两个 `h`）。

### 发版步骤

1. **确认 / 升版本**（版本号在 [`packages/cli/package.json`](packages/cli/package.json) 的 `version`；**同版本不能重复发布**）：

```bash
# 可选：在 packages/cli 下升版本（会改 package.json）
cd packages/cli
npm version patch    # 0.1.0 → 0.1.1
# 或 npm version minor / major
cd ../..
```

也可手改 `packages/cli/package.json` 的 `version`，与扩展 `package.json` 版本**不必相同**。

2. **构建并发布**（在仓库根目录）：

```bash
npm run publish:cli
```

等价于：

```bash
npm run build:cli
npm publish ./packages/cli --access public --registry https://registry.npmjs.org/
```

**不要**在仓库根目录执行 `npm publish`：根 `package.json` 已设 `"private": true`（VS Code 扩展只走 Marketplace / Open VSX）。  
旧脚本曾用 `npm publish --prefix packages/cli`，在部分环境下会误发根包名 `protoview`（未 scoped）；若你曾因此把 `protoview@0.1.3` 发到 npm，可在 72 小时内撤销：

```bash
npm unpublish protoview@0.1.3 --registry=https://registry.npmjs.org/
```

正确包名是 **`@zhhoceanfly/protoview`**。也可：

```bash
cd packages/cli && npm publish --access public --registry https://registry.npmjs.org/
```

3. **验证**：

```bash
npm view @zhhoceanfly/protoview version
npx @zhhoceanfly/protoview@latest --help
# 或全局
npm i -g @zhhoceanfly/protoview
protoview --proto ./你的proto目录
```

包页面：https://www.npmjs.com/package/@zhhoceanfly/protoview  

构建脚本：[`scripts/build-cli.js`](scripts/build-cli.js)。打进 npm 的内容见 `packages/cli` 的 `files` 字段（`bin` / `dist` / `public` / `README.md`），不含仓库源码树。

### 常见问题

| 问题 | 处理 |
| --- | --- |
| 打开「Sign up to CNPM」/ `Public registration is not allowed` | 当前默认源是 npmmirror；改用 `npm login --registry=https://registry.npmjs.org/`，到 npmjs.com 注册/登录 |
| `You need to authorize this machine` / 401 | 对官方源重新 `npm login --registry=https://registry.npmjs.org/`；检查 token 未过期 |
| `You do not have permission to publish` | 账号不是组织 `zhhoceanfly` 成员，或未开通 publish；确认登录的是 owner 账号 `zoceanfly` |
| `Cannot publish over existing version` / `PUT .../protoview`（无 scope） | 误发了根包：用修好的 `npm run publish:cli`；可选 `npm unpublish protoview@x.y.z` |
| `Cannot publish over existing version`（URL 含 `@zhhoceanfly%2fprotoview`） | 该版本已在 npm，先升 `packages/cli` 的 `version` 再发 |
| `Package name too similar` / scope 冲突 | 确认包名为 `@zhhoceanfly/protoview`，组织为 `zhhoceanfly` |
| 发布后 `npx` 仍是旧版 | 镜像同步延迟：用 `npx @zhhoceanfly/protoview@x.y.z`，或 `npm view @zhhoceanfly/protoview version --registry=https://registry.npmjs.org/` |

### 本地试跑（不发布）

```bash
npm run build:cli
node packages/cli/bin/protoview.js --proto ./你的proto目录 --port 3920
```

### 开发调试（免每次 build）

```bash
npm run dev:cli
# 或带参数
npm run dev:cli -- --proto ./你的proto目录 --port 3920
```

- 改 `client/`（页面 JS/CSS）→ **浏览器刷新**即可  
- 改 `src/` 或 `packages/cli/src` → 自动 `tsc` 并重启服务  
- 开发时静态资源直连仓库 `client/`，不必再 `build:cli` 复制到 `public/`  
- **正式发布前仍须** `npm run publish:cli`（或至少 `build:cli`），确保 `public/` / `dist/` 为最新产物

## 图标资源

- `media/icon.png`：商店与扩展详情（≥128×128 PNG）
- `media/icon.svg`：活动栏单色图标（随主题变色）
