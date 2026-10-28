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
若本机已从商店安装过 ProtoView（同 ID `zoceanfly.protoview`），会与开发版抢激活。`.vscode/launch.json` 使用 `--disable-extensions`，调试窗口里只加载本仓库开发版，主窗口商店版不受影响。仍异常时：扩展面板暂时 **禁用** ProtoView 后再 F5。

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

### GitHub Actions 自动发布

工作流：[`.github/workflows/publish-openvsx.yml`](.github/workflows/publish-openvsx.yml)

**1. 配置仓库密钥（一次性）**

1. 在 [Open VSX Access Tokens](https://open-vsx.org/user-settings/tokens) 创建 Token（需已签署 Publisher Agreement）
2. 打开仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
3. Name 填 `OVSX_PAT`，Value 粘贴 token（形如 `ovsxat_...`）→ Add secret  
   （不要写进代码或提交到 git）

命名空间 `zoceanfly` 若尚未创建，先在本机执行一次 `npm run openvsx:namespace`（CI 不会自动创建）。

**2. 触发发布**

任选其一（发布前先把根目录 `package.json` 的 `version` 升到目标版本并推送）。  
**Tag 前缀与 npm / DBX 分开**，避免一次 push 触发多个发布：

| 渠道 | Tag 示例 | Workflow |
|------|----------|----------|
| Open VSX | `ext-v0.1.5` | `publish-openvsx.yml` |
| npm CLI | `cli-v0.1.5` | `publish-npm-cli.yml` |
| DBX | `dbx-v0.1.0` | `publish-dbx-plugin.yml` |

| 方式 | 操作 |
|------|------|
| 手动 | Actions → **Publish Open VSX** → **Run workflow** |
| Tag | `git tag ext-v0.1.5 && git push origin ext-v0.1.5` |

工作流会 `npm ci` → `npm run publish:openvsx`（打包 VSIX 并用密钥发布）。同一版本已存在时 Open VSX 会拒绝，需先升版本。

Cursor 对 Open VSX 有镜像同步延迟（常见数小时）；也可在 Cursor 里用「从 VSIX 安装」。用完整 ID 搜索：`zoceanfly.protoview`。

## 发布 npm CLI（`@zhhoceanfly/protoview`）

供 Rider 等环境在浏览器使用 ProtoView Client，与扩展共用 Client 页面逻辑。包目录：[`packages/cli`](packages/cli)，说明见 [`packages/cli/README.md`](packages/cli/README.md)。

npm 组织：**`zhhoceanfly`**（与 VS Code Marketplace publisher `zoceanfly` 不同，勿混用）。  
包页面：https://www.npmjs.com/package/@zhhoceanfly/protoview  

### 推荐：GitHub Actions（Trusted Publishing，无浏览器 MFA）

工作流：[`.github/workflows/publish-npm-cli.yml`](.github/workflows/publish-npm-cli.yml)  
本机 `npm publish` 会走交互式 2FA；CI 用 **OIDC Trusted Publishing** 可完全跳过浏览器二次验证，也**不必**长期存放 `NPM_TOKEN`。

**1. 在 npm 绑定 Trusted Publisher（一次性）**

1. 打开包 Settings：https://www.npmjs.com/package/@zhhoceanfly/protoview → **Settings** → **Trusted Publisher**
2. 选 **GitHub Actions**，填写（须与仓库完全一致，区分大小写）：

| 项 | 值 |
| --- | --- |
| Organization or user | `zhhOceanfly`（你的 GitHub 用户/组织名） |
| Repository | `ProtoView` |
| Workflow filename | `publish-npm-cli.yml`（只要文件名，含 `.yml`） |
| Allowed actions | 勾选允许 **`npm publish`**（若界面有该项） |

3. 保存后 **2 天内**必须用该 workflow **成功发布一次**，否则配置过期需重建。

**2. 升版本并触发**

先改 [`packages/cli/package.json`](packages/cli/package.json) 的 `version`（与扩展版本**不必相同**；**同版本不能重复发**），提交推送后任选：

| 方式 | 操作 |
|------|------|
| 手动 | Actions → **Publish npm CLI** → **Run workflow** |
| Tag | `git tag cli-v0.1.5 && git push origin cli-v0.1.5`（tag 名仅作触发，真正版本以 `packages/cli` 的 `version` 为准） |

工作流会 `npm ci` → `build:cli` → `npm publish ./packages/cli`。OIDC 由 `permissions.id-token: write` 提供，无需 Secret。

**3. 备选：Granular Token（未配 Trusted Publisher 时）**

1. npm → Access Tokens → **Granular** → 对该包 Read and write，并勾选 **Bypass 2FA**  
2. 仓库 Settings → Secrets → Actions → 新建 `NPM_TOKEN`  
3. 同一 workflow 会把 `NODE_AUTH_TOKEN` 设为该 Secret（OIDC 不可用时回退）

配好 Trusted Publisher 并验证成功后，建议在包 Settings → **Publishing access** 选「Require 2FA and disallow tokens」，并撤销不再需要的 publish token。

### 本机手动发布（会触发浏览器 / OTP MFA）

1. 在 [npmjs.com](https://www.npmjs.com/signup) **注册官方账号**（不要用 CNPM / npmmirror 注册页）  
2. 已创建组织 [zhhoceanfly](https://www.npmjs.com/settings/zhhoceanfly/members)，且当前账号为 owner / 有 publish 权限  
3. 包为**公开**包（`publishConfig.access: public`）  
4. **登录必须指向官方 registry**（国内若默认源是 npmmirror，直接 `npm login` 会进 CNPM）

```bash
npm config get registry
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

浏览器应打开 **npmjs.org** 的登录/授权页，而不是「Sign up to CNPM」。  
`packages/cli` 已配置 `publishConfig.registry = https://registry.npmjs.org/`。

升版本并发布：

```bash
cd packages/cli
npm version patch    # 或手改 version
cd ../..
npm run publish:cli
```

等价于 `npm run build:cli` + `npm publish ./packages/cli --access public --registry https://registry.npmjs.org/`。

**不要**在仓库根目录执行 `npm publish`：根包 `"private": true`。  
正确包名是 **`@zhhoceanfly/protoview`**（两个 `h`）。

验证：

```bash
npm view @zhhoceanfly/protoview version --registry=https://registry.npmjs.org/
npx @zhhoceanfly/protoview@latest --help
```

构建脚本：[`scripts/build-cli.js`](scripts/build-cli.js)。打进 npm 的内容见 `packages/cli` 的 `files` 字段。

### 常见问题

| 问题 | 处理 |
| --- | --- |
| 打开「Sign up to CNPM」/ `Public registration is not allowed` | 当前默认源是 npmmirror；改用 `npm login --registry=https://registry.npmjs.org/` |
| 本机发布要浏览器 MFA / OTP | 正常；改用上面的 **Trusted Publishing** 工作流即可免交互 |
| CI `Unable to authenticate` / `ENEEDAUTH` | 检查 Trusted Publisher 的用户名/仓库/workflow 文件名是否完全一致；新建后是否已在 2 天内成功发过一次；workflow 是否含 `id-token: write` |
| CI `Cannot publish over existing version` | 先升 `packages/cli` 的 `version` 再跑 workflow |
| `You do not have permission to publish` | 账号不是组织 `zhhoceanfly` 成员；确认登录的是有权限的账号 |
| `Cannot publish over existing version` / `PUT .../protoview`（无 scope） | 误发了根包：用 `npm run publish:cli` 或 CI workflow |
| 发布后 `npx` 仍是旧版 | 镜像延迟：指定版本或查官方 registry |

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
