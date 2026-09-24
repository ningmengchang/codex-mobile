# Codex Mobile（Codex 随行）

## 会话终端

聊天右上角 `›_` 可直接连接或恢复会话目录下的独立终端，在终端光标处输入命令。手机端铺满可视区域；快捷键、输出转聊天草稿与结束操作位于顶部“⋯”。手动终端不经过 AI 审批；权限、生命周期与验证方式见 [会话终端说明](docs/terminal.md)。

通过手机浏览器控制 Deepin PC 上的 Codex。它不依赖 tmux，而是使用 Codex 官方 App Server 协议：手机 PWA 连接本机 Node.js 网关，网关以 `root` 身份复用 `/root/.codex` 的登录和会话。

## 聊天交互规则（Chat Rules）

聊天框逻辑集中在 `public/js/chat-core.js`（数据层）与 `public/js/chat-view.js`（视图层），规则如下：

1. **数据流**：打开会话只拉最新一页（`thread/turns/list`，默认 20 回合），向上翻按 `cursor` 分页加载更早历史；会话 LRU 缓存（6 个）实现秒开 + 后台静默刷新。
2. **合并去重**：刷新合并时服务端条目优先，SSE 独有条目按 `id` + 内容键合并保留；同一回合内“相同类型 + 相同文本”的卡片只保留一份。
3. **渲染**：增量优先——新回合 `appendTurnSection` 追加、已有回合 `updateTimelineItem` 局部更新；全量渲染仅用于打开会话、刷新合并、加载全部后编号；回合数 > 12 或条目 > 80 才分块渲染。
4. **滚动**：默认钉在最新（`pinnedToBottom`），新内容到达自动滚底且为瞬时定位；上翻超过 120px 暂停跟随并显示“回到最新 ↓”，回到底部 40px 内自动恢复；阅读历史时新内容不打断当前位置。
5. **流式回合**：`turn/started` 新回合追加；`turn/completed` 立即渲染方案卡片并 `force` 刷新，避免旧快照覆盖 SSE 内容。
6. **工具收纳**：命令、文件 diff、思考等默认折叠在“工具与思考 · N”内，主对话只显示问题与结论。

## 会话首页与并行任务

- 手机端冷启动默认进入会话首页，不自动加载上次长会话；点击会话后进入独立聊天详情，返回列表不会停止任务。
- 会话首页跨允许的项目目录读取最近会话，展示所属项目、内容摘要和“规划中 / 执行中 / 待处理 / 已完成 / 失败 / 已停止”状态。
- 多个会话可以同时运行。实时事件始终先更新对应会话的活动状态，只有当前打开会话的消息才会写入聊天时间线。
- 完成和失败状态以未读方式持久化到服务数据目录，打开对应会话并加载完成后才会清除；刷新和 SSE 重连不会丢失。
- 聊天详情继续使用最新 20 回合优先和向上分页加载，桌面端保留左侧会话栏与右侧聊天的双栏结构。

## GPT / DeepSeek / GLM 手动交接

- GPT、DeepSeek 与 GLM 继续使用各自原生的 `CODEX_HOME` 和会话，不做后台同步，也不修改任何 Codex 登录或模型配置。
- 在具体聊天右上角菜单选择“复制交接包”，服务会从本地可见历史、方案、文档索引与 Git 状态生成标准 Markdown；该过程不调用模型，在账号没有额度时也能使用。
- 交接包会自动隐藏常见 API Key、令牌、密码与配对码，默认最多 5 MiB、优先读取完整本地历史，原生分页最多读取最近 500 个回合。
- 生成结果以 `0600` 权限保存在 `/var/lib/codex-mobile/handoffs`，同一 Agent 的同一会话重复生成时原子覆盖，不写入项目仓库。
- 手机只复制一条很短的本机文件读取指令。切换 Agent 后，打开或新建目标会话并粘贴该指令；目标 Agent 必须运行在同一台 Codex Mobile 服务器上。需要反向接力时重复同一流程。
- 手机端与 CLI 只有在连接同一台机器、使用同一 Agent 的 `CODEX_HOME`、恢复同一个原生会话 ID 时才会看到相同历史；同一会话同时只允许一个 writer。

## 六个 Agent：GPT / DeepSeek / GLM / Codex1 / Codex2 / Codex3

手机端设置里的 `Agent` 下拉可在多套彼此隔离的 Codex 实例之间切换。切换只会换 `CODEX_HOME` 并重启 App Server，不复制会话、不改动任何登录信息；会话有任务在跑时会先提示，确认后才强制中断，失败会自动回滚到切换前的 Agent。

| Agent | 启动入口 | `CODEX_HOME` | 认证方式 | 默认模型 |
| --- | --- | --- | --- | --- |
| GPT | `/opt/codex-mobile/bin/codex` | `/home/ningmengchang/.codex` | 设备码登录 | `gpt-5.6-sol` |
| DeepSeek | `/home/ningmengchang/.local/bin/codex-ds` | `/home/ningmengchang/.codex-ds` | `key.env` 的 `DEEPSEEK_API_KEY` | `deepseek-v4-flash` |
| GLM | `/home/ningmengchang/.local/bin/codex-glm` | `/home/ningmengchang/.codex-glm` | `key.env` 的 `ZHIPU_API_KEY` | `glm-5.3-flash` |
| Codex1 | `/home/ningmengchang/.local/bin/codex1` | `/home/ningmengchang/.codex1` | 设备码登录（备用账号） | 同 GPT |
| Codex2 | `/home/ningmengchang/.local/bin/codex2` | `/home/ningmengchang/.codex2` | 设备码登录（备用账号） | 同 GPT |
| Codex3 | `/home/ningmengchang/.local/bin/codex3` | `/home/ningmengchang/.codex3` | 设备码登录（备用账号） | 同 GPT |

`Codex1` / `Codex2` / `Codex3` 是给"主号额度用尽后换号继续"准备的备用设备码实例，与主号（GPT）、DeepSeek、GLM 完全隔离：各自 `CODEX_HOME`、各自 `auth.json`、各自会话历史。三个实例的 `skills/` 都用符号链接指向主实例的 `~/.codex/skills`，并叠加共享的 `~/.agents/skills`，因此技能与主号一致，以后新增技能也会自动跟随。

### 绑定设备码（每个账号一次）

```bash
codex1 login --device-auth     # 按提示打开链接、填入设备码，用账号 1 完成登录
codex1 login status            # 期望输出：Logged in using ChatGPT
codex1 exec --skip-git-repo-check "只回复 pong"   # 真实跑一次确认

codex2 login --device-auth     # 账号 2 同理
```

登录只写入 `~/.codex1/auth.json`（或 `~/.codex2/auth.json`）。两个启动脚本内置护栏：`CODEX_HOME` 解析结果必须是各自的实例目录，否则直接报错退出，避免误操作覆盖主号、DeepSeek 或 GLM 的登录信息。

未登录时手机端会把对应 Agent 置灰并显示"（未登录）"；补完 key 的 GLM 显示"（未配置）"。可用性是实时判断的，**登录完成后刷新页面即可切换，不需要改代码或重启服务**。登录后下拉会显示 `Codex1 · 账号邮箱`，便于区分是哪个号。

### 额度用尽后怎么继续

1. 在原账号的会话右上角 `⋯` → 复制交接包。
2. 切换到另一个设备码 Agent（例如 Codex1）。
3. 新建或打开目标会话，粘贴那条读取指令，让新账号接着处理。

交接包按 `codex-handoff-<agent>-<hash>.md` 保存，不同账号互不覆盖；每个 Agent 的模型、强度、上次会话、草稿与收藏也各自独立。

### 再加一个账号

以 Codex3 为模板，新增一个 `codexN` 只需三步：

1. 建目录与配置：`mkdir -p ~/.codexN/skills`，把 `~/.codex/config.toml` 复制成 `~/.codexN/config.toml`（`chmod 600`），再把 `~/.codex/skills/*` 逐个 `ln -s` 进 `~/.codexN/skills`。
2. 复制启动脚本：`cp ~/.local/bin/codex3 ~/.local/bin/codexN`，把里面的 `codex3` / `.codex3` 全部改成 `codexN` / `.codexN`，保持 `chmod 755`。
3. 注册到网关：在 `server/config.mjs` 的 `deviceAccountBackends` 里加一条同构配置（id / label / description / home / skillsEnv），`npm run verify` 后执行 `sudo ./scripts/install-system.sh` 并重启服务。

登录仍然是 `codexN login --device-auth`；未登录时该 Agent 在手机端显示"（未登录）"并置灰。

GLM 实例按智谱 Coding Plan 官方文档接入 OpenAI Responses 协议：

- `config.toml` 使用 `model_provider = "ZAI"`、`base_url = "https://open.bigmodel.cn/api/v1"`、`wire_api = "responses"`，`model_catalog_json` 指向实例内的 `models.json`（声明 `glm-5.3` 与 `glm-5-turbo`）。
- 套餐可用模型共三个：`glm-5.3`（旗舰）、`glm-5.3-flash`（快速多模态，当前默认）、`glm-5-turbo`（Agent 优化）。默认模型可用 `CODEX_MOBILE_GLM_MODEL` 覆盖；手机端也可在“模型”下拉里对各 Agent 单独选择，选择结果保存在浏览器本地。
- API Key 只保存在 `~/.codex-glm/key.env`（权限 `0600`），由启动脚本导出为 `ZHIPU_API_KEY`，Codex 通过 provider 的 `env_key` 读取；Key 不写入 `config.toml`，也不进入版本库。
- 未填写 Key 时 GLM 在手机端自动置灰，避免切过去之后停在“Codex 启动中”。
- 自检与真实请求校验：`codex-glm --version`、`codex-glm exec --skip-git-repo-check "只回复 pong"`。
- 若该端点忽略 `env_key`，在 `[model_providers.ZAI]` 段补 `experimental_bearer_token = "<API Key>"`（文件保持 `0600`）后重试。

命令行使用同一实例，历史与手机端一致：

```bash
codex-glm
codex-glm exec "只回复 pong"
```

三个 Agent 的模型、推理强度、上次打开的会话、草稿与收藏都在手机端按 Agent 分别保存，来回切换不会互相覆盖。

## 能力

- 新建、查看和恢复 Codex 会话，实时显示回复、计划、工具调用、命令输出和 diff。
- 可在“执行 / 规划”间切换：规划模式使用只读沙箱并展示结构化计划，确认后可一键按方案实施。
- 在手机处理命令、文件和权限审批，回答 Codex 的选项问题，停止或追加运行中的指令。
- 审批支持“自动审查”和“每次问我”；自动审查会按风险判断，不等于无条件放行，高风险请求仍可能要求手机确认。
- 自动收集每个回合新增、修改和删除的文件；预览 Markdown、代码、图片、PDF、Office、HTML、音视频。
- `.xlsx` 默认使用适合手机的工作表视图，可切换 Sheet、查看合并单元格并横向滚动；也可切换到 PDF 版式视图。
- 从产出物直接发起“让 Codex 修改”，文件路径会作为下一条指令上下文。
- 使用手机键盘的系统听写输入，不采集或上传录音。
- 仅监听 `127.0.0.1`，推荐通过 SSH 本地端口转发访问。

## 运行结构

```text
手机 PWA ── SSH 隧道 ──> 127.0.0.1:3765
                              │
                         Node.js 网关 (ningmengchang)
                              │ JSONL / stdio
                         Codex App Server
                              │
                         /home/ningmengchang/.codex
```

网关不向浏览器开放任意 Shell、文件写入或删除接口。浏览器只能创建/恢复会话、发送回合、追加/停止和处理 Codex 发起的审批。

## 规划与审批

- 选择“规划”后，当前回合会使用 Codex 官方 Plan 协作模式和只读沙箱，并禁止升级权限。Codex 可以检查代码、提出选项问题并更新计划，但不能修改项目文件。
- 方案完成后，可以选择“继续完善方案”，也可以点“按此方案实施”。后者会切回执行模式，并显式恢复当前项目的工作区写入权限。
- “自动审查”把额外权限请求交给 Codex 风险审查器；它可能允许、拒绝或把高风险决定交给你。“每次问我”则把权限请求直接显示为手机端审批卡片。
- 模式、审批方式、模型和推理强度在回合执行中会锁定，回合结束后才能修改，避免中途切换产生误解。

## 安装

要求：Node.js 18+、Codex CLI、`/home/ningmengchang/.codex/auth.json`；Office 版式预览需 LibreOffice 和 Poppler，Excel 表格预览需 Python 3 与 openpyxl。

```bash
cd /home/ningmengchang/ideaProjects/codex-mobile
npm run verify
sudo ./scripts/install-system.sh
```

安装脚本会把经过测试的网关代码和当前 Codex 可执行文件部署到 `/opt/codex-mobile`，并由 systemd 以 `ningmengchang` 用户运行。服务启动后会输出一次性 8 位配对码。以后可随时重新生成：

```bash
sudo /usr/bin/node /opt/codex-mobile/scripts/pair.mjs
```

状态和日志：

```bash
systemctl status codex-mobile
journalctl -u codex-mobile -f
```

## 手机 SSH 隧道

在支持端口转发的手机 SSH 客户端中创建 Local Forward：

```text
本地地址：127.0.0.1
本地端口：3765
远程地址：127.0.0.1
远程端口：3765
```

也可在带终端的 SSH 客户端运行等价命令：

```bash
ssh -N -L 3765:127.0.0.1:3765 <PC用户名>@<PC地址>
```

保持隧道后，在手机浏览器打开 `http://127.0.0.1:3765`，输入配对码，并通过“添加到主屏幕”安装 PWA。固定使用相同本地端口，才能保持同一个浏览器来源和登录状态。

手机系统可能在后台暂停 SSH 客户端；重新打开隧道后，PWA 的 SSE 连接会自动恢复并补齐最近事件。

## 运行用户与文件所有权

- App Server、凭据和服务状态以 `ningmengchang` 管理，复用 `/home/ningmengchang/.codex` 的模型与登录配置，不复制、不改所有权。
- `/var/lib/codex-mobile` 与 `/var/cache/codex-mobile` 是服务数据，由 `ningmengchang` 所有。
- 每个 Codex 回合开始和结束时，网关对当前项目做有界快照。
- 对修改前属于 `ningmengchang` 的文件，以及在 `ningmengchang` 目录中本回合新建的普通产物，网关只按精确路径调用 `/root/.codex/bin/fix-ningmengchang-ownership` 并立即校验。
- 既有系统管理目录、符号链接、其他文件系统挂载点、`.git`、依赖缓存等不会被递归 chown。

## 配置

可在 `/etc/codex-mobile.env` 覆盖：

```bash
CODEX_MOBILE_PORT=3765
CODEX_MOBILE_ALLOWED_ROOTS=/home/ningmengchang/ideaProjects
CODEX_MOBILE_MAX_FILE_BYTES=536870912
CODEX_MOBILE_LOG_LEVEL=info
CODEX_MOBILE_DEFAULT_MODEL=gpt-5.6-sol
CODEX_MOBILE_DEFAULT_EFFORT=max
CODEX_MOBILE_GLM_BIN=/home/ningmengchang/.local/bin/codex-glm
CODEX_MOBILE_GLM_HOME=/home/ningmengchang/.codex-glm
CODEX_MOBILE_GLM_MODEL=glm-5.3
CODEX_MOBILE_GLM_EFFORT=max
CODEX_MOBILE_HANDOFF_MAX_BYTES=5242880
CODEX_MOBILE_HANDOFF_RECENT_TURNS=500
```

多个允许根目录使用 Linux 路径分隔符 `:`。服务默认不接受外网连接，不要把监听地址改成 `0.0.0.0`。

模型与推理强度的默认值也可以在 `/etc/codex-mobile.env` 覆盖；用户通过手机设置手动改过的选择会保存在浏览器本地，并优先于默认值。

升级 Codex CLI 后运行协议检查：

```bash
sudo /usr/bin/node /opt/codex-mobile/scripts/check-protocol.mjs
```

## 开发与测试

测试使用临时目录和模拟 App Server，不会读取或更改 Codex 凭据：

```bash
npm run check
npm test
npm run verify
```

卸载服务（保留配对和缓存数据）：

```bash
sudo ./scripts/uninstall-system.sh
```
