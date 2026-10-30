# dsh-remotion-launcher

方便一键启动mcp工程[Remotion Studio](https://github.com/laojingwei/remotion-studio)用；
在 DeepSeek Harness（DSH）里一键**构建 / 启动 / 停止** [Remotion Studio](https://github.com/laojingwei/remotion-studio-mcp) 动画工程，该工程是mcp模式，启动后需要你自己去配置mcp，配置好后你就可以让dsh去使用生成各种自己想要的网页动画视频。

> 插件和工程是**两个独立包**：本仓库只是启动器，工程是另一个包 `remotion-studio`。
> 工程包安装可选择[github](https://github.com/laojingwei/remotion-studio-mcp)或[npm](https://www.npmjs.com/package/remotion-studio-mcp)官网下载。

## 它做什么

装上后在 DSH 右下角出现一个可拖动的悬浮按钮（🎬），点开是一个面板：


| 区域        | 说明                                                             |
| ----------- | ---------------------------------------------------------------- |
| 工程        | 显示当前工程目录，可**安装 / 更换**（详见下一节）                |
| 构建前端    | 在工程根跑`npx vite build`，输出 `dist/web`                      |
| 启动 / 停止 | `npx tsx server/index.ts`（`PORT=4380`），自动探活 `/api/health` |
| 端口        | 可改，避免和别的软件抢 4380；写进本机配置，重启不丢              |
| 日志        | 构建 / 服务 / 安装的实时输出，环形缓冲 600 行                    |
| MCP 配置    | 一键复制 `mcpServers` JSON（stdio / HTTP 两种接法），粘到连接器即可 |
| 版本与更新  | 启动器自身的新版检查与一键升级（详见「更新」一节）               |

位置、端口、工程目录都存 Host 侧（`~/.dsh/remotion-launcher.json`），换浏览器、换端口不会丢。

---

## 接上 MCP

服务跑起来只是有了编辑器；要 agent 能调工具，还得把工程挂成 MCP 连接器。

面板里的 **MCP 配置** 卡片已经把路径和端口算好了，点「复制 JSON」，粘到连接器管理页的**自定义连接器**里，
再点「信任」就行 —— 不用自己拼工程路径。

两种接法按需切换（选择记在本机）：

| 接法    | 配置内容                                                                | 什么时候用                                                     |
| ------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `stdio` | `command: node` + 工程内的 `tsx` + `server/mcp-proxy.ts`，`SERVER_URL` 指向本机端口 | 常驻子进程，**服务没开也能用**（首次调用会自动拉起）；改工具代码要重连 |
| `HTTP`  | `{ "type": "http", "url": "http://127.0.0.1:<端口>/mcp" }`               | 连已经在跑的服务，不起新进程；服务一停就断                      |

卡片左侧那个小圆点是就绪状态：绿色可直接用，黄点表示还差条件（没装工程 / 依赖没装齐 / 服务没跑），
下方一行会说明差什么。想核对内容就点标题展开 JSON 预览（路径长会折行，不横向切）。

> 复制走 `navigator.clipboard`，被浏览器拦下时自动退回 `execCommand`；两条都不行就直接把
> JSON 展开给你，手动全选复制。

---

## 安装

DSH 版本要求：`>=0.2.1-rc.2`。

### 第一步：装插件（三选一）

**npm（国内推荐走 npmmirror 镜像源）**

```sh
dsh plugin --profile web add dsh-remotion-launcher
```

**GitHub**

```sh
dsh plugin --profile web add github:laojingwei/dsh-remotion-launcher
```

**本地开发**

```sh
dsh plugin --profile web add "link:<插件目录>"
```

也可以走DSH自带的功能：**设置 → 插件 → 添加插件**，填包名或地址。

装完**重启 DSH**（客户端清单在启动时构建）。

### 第二步：拿到工程

插件本身**不含工程**。重启后面板第一行会显示「工程 · 未安装」，点右边「安装」：


| 做法           | 什么时候用                            |
| -------------- | ------------------------------------- |
| **使用此目录** | 你已经 clone / 解压了工程，直接指过去 |
| **下载并安装** | 本机没有工程，从 npm 拉一份           |

「下载并安装」的流程：选目录（弹系统文件夹对话框）→ 选下载源 → 由 host 依次跑

```sh
npm pack remotion-studio-mcp@latest --registry=<下载源> --pack-destination <临时目录>
tar -xzf <tgz> -C <目标目录> --strip-components=1
npm install --registry=<下载源>          # 在目标目录里，最慢的一步
```

也可以自己 clone：

```sh
git clone https://github.com/laojingwei/remotion-studio-mcp.git <工程目录>
cd <工程目录>
npm install
```

然后在面板里 **更换 → 选择该目录 → 使用此目录**。

---

## 工作方式

```
DSH 浏览器页面
   └─ client.js（shell.overlay 悬浮按钮 + 面板）
        │  fetch 同源 /remotion-plugin/*
        ▼
   index.js（host 半部，跑在 DSH 的 Node 进程里）
        ├─ spawn: npx vite build          → <工程>/dist/web
        ├─ spawn: npx tsx server/index.ts → http://localhost:4380
        └─ spawn: npm pack / tar / npm install（只在下载工程时）
```

- host 半部只做进程管理和状态
- 服务地址可以在右侧栏「浏览器」标签里打开，和 agent 共用同一个界面
- DSH 退出时插件会杀掉自己拉起的子进程，避免端口被孤儿进程占用

## 工程目录（安装 / 更换）

面板第一行永远是「工程」，点右边按钮展开卡片：


| 字段           | 说明                                                         |
| -------------- | ------------------------------------------------------------ |
| 目录           | 点「选择」弹系统文件夹对话框，也可以直接粘路径               |
| **使用此目录** | 指向本机**已有**的工程，不下载任何东西                       |
| **下载并安装** | 从 npm 下载一份新工程到这个目录                              |
| 下载源         | `国内镜像 npmmirror` / `npm 官方` / `自定义…`（只影响下载） |

## 更新

### 启动时静默检查

每次 DSH 启动、插件加载 3 秒后，host 半部会去 registry 查一次最新版本（用面板里存的下载源，默认 npmmirror）。**不弹窗、不打断**，只把结果放进状态：

- 有新版本 → 悬浮按钮右上角出现小圆点，点开面板顶部是一条黄色横幅
- 没有新版 / 查不到（离线、镜像没同步）→ 什么都不显示，只在「版本与更新」里留一行检查时间

面板里那个 ⟳ 按钮可以随时手动重查。

### 能不能一键更新，看你是怎么装的

host 半部用 `pluginManager.listBundles()` 的 `source` 判断来源（不是猜目录，GitHub 装的包同样落在 `node_modules` 里）：

| 安装方式 | 来源长什么样 | 面板行为 |
| --- | --- | --- |
| **npm** | `dsh-remotion-launcher@^1.0.6` | 显示「一键更新启动器」，点一下就地升级 |
| **GitHub / Git** | `github:you/repo`、`git+https://…` | 只提示，给出要粘的命令 |
| **本地链接** | `link:D:\…\dsh-remotion-launcher` | 同上（改源码即可，不必更新） |
| **本地目录 / tarball** | `file:…`、`….tgz` | 同上 |

非 npm 安装时，面板里写清楚两步：

```sh
# ① 设置 → 插件 → 找到 dsh-remotion-launcher，卸载
# ② 按原来的方式装回来：
dsh plugin --profile web remove dsh-remotion-launcher
dsh plugin --profile web add github:laojingwei/dsh-remotion-launcher
```

### 一键更新：能热换就热换，换不掉才让你重启

npm 安装的插件走 DSH 自己的插件管理接口，一次点击完成「卸旧 → 装新」：

```
removeBundle(旧版)  →  installBundle(新版)  →  新实例接管？
                                              ├─ 是：已完成，没重启
                                              └─ 否：已装好，重启 DSH 生效
```

- **判定不靠 DSH 的口头承诺**：`ChangeResult.application` 只说明文件写成了，HMR 到底有没有把新代码拉起来，要靠「新实例握手」——装机前在 `~/.dsh/remotion-launcher-update.json` 里写 `installing`，真正跑起来的那份代码会在 `apply()` 时发现「标记里的目标版本 = 自己」，于是回写 `bootedAt`。旧实例等这条证据，等到就是热更新成功，等不到就是需要重启
- 两种情况面板都如实显示：「已更新到 x.y.z（新实例已接管，没重启 DSH）」或「已装好 x.y.z，重启 DSH 后生效，当前运行 a.b.c」，需要重启时还会带上 DSH 给的原因（`host-module` / `package-moved` / `unmanaged-plugin` / `module-comparison`）
- 装完再点更新不会再装一遍，直接告诉你「已经装好，重启生效」
- 卸载后装不上会自动**回滚到开装前盘上那版**，不会把已经装好的新版降回去，也不会让你面对一个消失的插件
- 进度写在同一个标记文件里：DSH 中途退出，下次启动会认出「上次没走完」；确认生效后自动清档
- 宿主没开 HMR 时不做卸载，直接装新版，同样提示重启才生效

> 为什么必须先卸再装：HMR 开着时对一个已安装的包直接 `installBundle`，DSH 会以 `already-installed` 拒绝——覆盖一个正在跑的包会把旧实例留在内存里。

> 环境变量 `DSH_REMOTION_BOOT_WAIT_MS` 可调等待新实例接管的毫秒数（默认 3000），测试里设 0 跳过等待。

## 配置

工程目录的优先级：**面板里选的（存 settings）→ 自动探测 → 环境变量**。

自动探测顺序：插件目录的上一级 → 上一级里的 `remotion-studio/`、`app/` → 再上一层。


| 变量                       | 默认                  | 说明                             |
| -------------------------- | --------------------- | -------------------------------- |
| `REMOTION_STUDIO_ROOT`     | 自动探测              | 工程根；面板里选过之后以面板为准 |
| `REMOTION_PROJECT_PACKAGE` | `remotion-studio-mcp` | 从 npm 下载的工程包名            |
| `REMOTION_PORT`            | `4380`                | 服务端口（面板里也能改）         |
| `DSH_REGISTRY`             | `https://registry.npmmirror.com` | 下载源；**同时用于查更新**，面板里改过之后以面板为准 |

启动时会检查工程根下有没有 `package.json` 和 `server/`；缺了就在日志里说明，并把面板切成「安装工程」形态，而不是让你点一个必然失败的启动按钮。

## 已知行为

- **端口已被占用**：启动前先探 `/api/health`，通就标记「已在运行（非本插件启动）」，不会重复拉起，也无法从这里停止
- **构建串行**：构建进行中再点不会叠加进程
- **构建期间不能启动**：dist 正在重写，这时起服务会读到半份前端
- **服务运行中不能构建 / 换工程 / 改端口**
- **停止卡住**：「停止中」超过 6 秒会把按钮变成「强制重置」，只清插件状态不动进程

## 发布（给维护者）

```sh
npm version patch          # 或 minor / major
npm publish                # 包名 dsh-remotion-launcher（若已占用请改 name 或加 scope）
git push --follow-tags
```

发布前建议在 `package.json` 里补上 `repository` / `homepage` / `bugs` 字段，npm 页面会据此显示源码入口。

## 开发自检

```sh
npm run smoke           # 两个半区的导出契约 + __ModuleLoader__ 格式 + 白名单 require
npm run host-sim        # 用假 Context 跑 apply()，验证路由、状态、落盘
npm run update-sim      # 假 pluginManager + 本地假 registry：热更新 / 拒绝 / 回滚
npm run check:encoding  # Windows：确认 PowerShell 能原样传回中文路径
npm test                # 以上全部
```

都不需要启动 DSH。`host-sim` / `update-sim` 会把配置写在系统临时目录，不碰真实配置，也不联网。
