# AperturePrism-AI-Review 全面优化方案

> 基线版本：**v1.0.34**（2026-08-25）
> 定位：系统级优化总纲。覆盖功能正确性、分析质量、前端体验、性能、稳定性、安全、可观测性、测试、工程效率、部署运维、技术债清理与路线图。
> 使用方式：每条优化项给出「背景 / 目标 / 方案 / 实施步骤 / 验收标准 / 优先级 / 建议负责人」，可直接拆成 GitHub Issue 派发。

---

## 第一章 现状盘点与基线评估

### 1.1 系统定位与技术栈

| 维度 | 现状 |
|---|---|
| 定位 | 面向私有/自托管场景的 GitHub AI Code Review 机器人，含 Issue 分析与 PR 审查，附带机器人多协议接入、记忆、扫描、多角色专家审查等能力 |
| 形态 | Turborepo + pnpm workspaces 单仓，7 个应用 + 16 个共享包 |
| 运行时 | Node.js 22（node:22-alpine 容器）、TypeScript、原生 `http` 服务（无 Express/Fastify 框架） |
| 数据 | PostgreSQL 16 + pgvector（向量检索）、Redis 7（事件流/限流）、17 个 Drizzle 迁移 |
| LLM | 用户自配 OpenAI 兼容 API（LLM 与 Embedding 分开配置），默认模型 gpt-4o-mini |
| 前端 | Vite + React（函数组件 + hooks + hash 路由），无 UI 框架，原生 CSS，本地化字体 |
| 部署 | Docker Compose 六服务（api / web / index-worker / scan-worker / analysis-worker / scheduler），NAS 自托管，镜像走 ghcr.nju.edu.cn 镜像站 |
| 机器人 | 官方 QQ 开放平台（AppID/AppSecret/网关/Intents）+ 三方协议（OneBot 11 / Satori / Milky） |

### 1.2 架构拓扑与数据流

```
GitHub ──webhook──▶ api ──▶ task-engine ──▶ (Redis 队列)
                        │                       │
                        ▼                       ▼
                 settings/db ◀──▶ analysis-worker / index-worker / scan-worker
                        │                       │
                        ▼                       ▼
                 model-router ──▶ LLM / Embedding
                        │
                        ▼
                 事件流(SSE) ──▶ web（React UI）
```

关键数据流说明：
1. **入库链路**：GitHub webhook（或手动触发）→ api 落任务 → analysis-worker 消费 → `recallRelated` 召回候选 → `judgeDuplicates` 模型裁决 → 分析 → 评论/标签回写 GitHub。
2. **索引链路**：index-worker 拉取仓库 → 源码/文档向量化（nemotron-3-embed-1b，2048 维）→ 写入 pgvector → 供分析时检索上下文。
3. **扫描链路**：scheduler 按周期扫描 → scan-worker 执行扫描任务 → 结果落库 → 触发分析。
4. **前端链路**：web 通过 `/api/*` 读数据、SSE 订阅实时事件、`/update/*` 做在线更新。

### 1.3 版本演进史与关键修复（v1.0.1 → v1.0.34）

| 版本 | 关键内容 | 备注 |
|---|---|---|
| v1.0.1 | 首版 + 官网 | 旧升级工具带 EACCES bug |
| v1.0.2 | 修复升级工具 | 自此在线升级可用 |
| v1.0.20 | 在线更新三大根因修复 | compose 重建自身、api 镜像缺 curl、env 正则尾随 `=`、migrate 挂起、pull 范围 |
| v1.0.31 | 设置系统重构（注册表统一事实源）+ 官网 + Pages | `packages/config/src/settings-registry.ts` 成为唯一事实源 |
| v1.0.32 | settings 死代码收尾 + Issue 低信息量先给方向（#16） | 提示词 v5 |
| v1.0.33 | 相关 Issue 过模型裁决（#14） | `judgeDuplicates` 接入分析流程 |
| v1.0.34 | 系统配置去重 + 导航重排 | GitHubAccessPage / AnalysisSettingsPage / SettingsSection 组件、5 组导航 |

### 1.4 问题台账总览（#1–#16 复盘）

全部 16 个 issue 已关闭（截至 v1.0.34），无开放 PR。历史问题按主题归类：

| 主题 | 涉及 issue | 处理状态 | 遗留风险 |
|---|---|---|---|
| 模型路由配置入口缺失 | #2 | v1.0.2x 修复（ProviderPage 加「添加模型」） | 低 |
| 同步仓库失败 | #10、#15 | #10 修复；#15 归因于前端缓存/版本不一致，v1.0.34 后需实测 | 中（见 3.1） |
| Review bot 误关联无关 issue | #14 | v1.0.33 修复（judge 裁决） | 低 |
| 获取模型失败 | #13 | 已修复 | 低 |
| 提示词注入防护 | #12 | 已修复（安全专项） | 低（需持续回归） |
| 连接失败/连接 bug | #8、#9 | 已修复 | 低 |
| 建议类（标题格式/指派等） | #5、#7 | 部分采纳 | 见 3.4 / 待办开关化 |

> 教训沉淀：所有「召回→上屏」的环节必须先过模型裁决（#14 教训）；所有「版本/健康」展示必须有 fallback（#15、更新面板教训）。

### 1.5 现状优势

1. **测试资产厚**：约 70 个测试文件，覆盖 14 个包与 7 个应用，含集成测试（`*.integration.test.ts`）与前端组件测试。
2. **设置系统已规范化**：注册表单一事实源，key/分组/env 兜底/hotReload 元数据齐备，页面归属清晰、无重复。
3. **多协议机器人抽象好**：`channel-adapters` 统一官方 QQ / OneBot / Satori / Milky，命令系统已抽象。
4. **自托管约束下的工程纪律**：镜像走镜像站、在线更新有完整链路与回滚、双 env 文件管理有明确约定。
5. **无框架裸 http + 无 UI 框架**：依赖面小，构建产物小，可控性强。

### 1.6 现状短板与风险清单

| 短板/风险 | 等级 | 说明 |
|---|---|---|
| 前端测试覆盖偏低 | 中 | 22 个页面只有 9 个测试文件，路由/表单/错误态覆盖不足 |
| 双 env 文件易错 | 中 | 改 IMAGE_TAG 必须改根 env；服务级 env_file 与根 env 职责易混 |
| 本地开发受限（SMB） | 中 | `npm ci` 在 SMB 必然失败，typecheck/test 只能靠 CI，迭代反馈慢 |
| 无指标/告警体系 | 中 | 只有日志，无指标采集与主动告警，问题靠用户上报 |
| 分析质量依赖 prompt | 中 | 深度分析（tools/function calling）依赖网关能力，无自动降级矩阵 |
| qq-bot 默认不启动 | 低 | 无凭据时重启循环，需 WebUI 配置后才 `--profile qq up` |
| 更新面板版本探测依赖 ghcr.io 直连 | 低 | 直连有超时先例（走镜像站），registry 探测缺 fallback |
| E2E 缺失 | 中 | 无浏览器级回归，前端重构风险靠人工截图 |

---

## 第二章 优化总体框架

### 2.1 优化维度地图

本方案覆盖 11 个维度，按「用户可感知价值」与「工程健康」双向排布：

```
P0（正确性/安全，先做）
  ① 功能与正确性  ③ 分析智能质量  ⑧ 安全与合规
P1（体验/稳定性/运维，主战场）
  ② 前端体验  ④ 性能资源  ⑤ 稳定性容错  ⑥ 可观测运维  ⑦ 部署体系
P2（工程健康，持续）
  ⑨ 测试质量门禁  ⑩ 工程效率CI/CD  ⑪ 技术债清理
```

### 2.2 优先级模型

每条优化项按三维打分定级：
- **影响**（I）：1-5，用户/业务价值
- **成本**（C）：1-5，实施工作量
- **风险**（R）：1-5，实施风险与回归面

`P = f(I, 1/C, 1/R)`，P0 > P1 > P2 排序实施。下表各章节条目均标注 I/C/R。

### 2.3 目标定义与度量（OKR 式）

**总体目标**：把「能跑的机器人」升级为「可长期运维、质量可度量、体验可信赖的自托管服务」。

| 目标 | 关键结果（可度量） |
|---|---|
| O1 功能可信 | KR1：已安装仓库页/同步链路 30 天无回归（0 复现 #15）<br>KR2：分析-评论-回写全链路 e2e 通过率 ≥ 99%<br>KR3：所有错误路径有用户可读提示（覆盖率 100%） |
| O2 分析质量可度量 | KR1：eval 集规模 ≥ 200 条，标注 2 人仲裁<br>KR2：重复误判率 ≤ 5%（judge 管线）<br>KR3：prompt 版本化，每次改动可回滚 |
| O3 体验统一 | KR1：Web 组件测试覆盖率 ≥ 40%<br>KR2：WCAG AA 达标（键盘可达/对比度）<br>KR3：移动端抽屉导航全页面可用 |
| O4 可运维 | KR1：核心指标可视化（队列深度/失败率/延迟）<br>KR2：关键路径告警 ≤ 5 分钟触达<br>KR3：备份可自动验证恢复（月度演练） |
| O5 工程健康 | KR1：CI 全绿时间 ≥ 99%<br>KR2：发布周期稳定（每周可发）<br>KR3：文档与代码同步（含 RUNBOOK/优化方案） |

---

## 第三章 功能与正确性优化（P0）

### 3.1 已安装仓库页可靠性（#15 收尾与加固）

**背景**：#15「点击已安装仓库后报错（同步仓库失败）」已关闭，归因于浏览器缓存旧前端/版本不一致；但该页链路（ReposPage → `/repositories` → 同步 → `/settings`）仍缺系统性回归保障。

**目标**：该页在任何数据状态下都能正常渲染，错误信息可操作。

**方案**：
1. **前端缓存一致性**：发布新版本时在 index.html 注入版本号与 `Cache-Control: no-cache`，并在构建产物文件名加内容 hash（Vite 已默认，需确认部署层未覆盖）；提供「刷新后仍旧版本」的提示位。
2. **错误分级展示**：ReposPage 将「未安装仓库」「已安装但同步失败」「无 GitHub App」三种状态分开渲染，各带对应动作按钮（去 GitHub 接入 / 重试同步 / 查看日志）。
3. **同步接口幂等**：`POST /repositories/sync` 增加并发锁（Redis），防止重复触发；失败返回结构化原因码而非裸 500。
4. **回归测试**：新增 ReposPage 组件测试覆盖空态/错误态/成功态；新增 `/repositories` 相关 API 集成测试。

**实施步骤**：
1. 复现核对：强刷后打开已安装仓库页，确认 v1.0.34 下正常。
2. 为 web 构建产物加版本指纹 + nginx 缓存策略。
3. 重构 ReposPage 状态分支，抽 `RepositoryStateCard`。
4. 后端同步接口加锁 + 原因码。
5. 补测试并走 CI。

**验收标准**：
- 强刷后必显示最新前端（版本号可见）。
- 同步失败时页面给出可读原因与重试/跳转入口，不再白屏或裸错误。
- 连续并发点同步不产生重复任务。

**优先级**：P0（I5/C3/R3）　**负责人**：前端 + API 双人

### 3.2 仓库同步链路健壮性

**背景**：GitHub App 无 webhooks 权限时需手动配 webhook；同步依赖 App 凭据与网络，历史上多次「同步仓库失败」。

**目标**：同步链路自愈、可诊断。

**方案**：
1. **凭据失效预检**：同步前先探测 GitHub App token（复用 `saveGithubApp` 的验证逻辑），失败直接给「App 凭据失效，去 GitHub 接入更换」。
2. **重试退避**：同步失败按 指数退避（30s/2m/10m）重试 3 次，最终落失败记录到任务表。
3. **限流感知**：捕获 GitHub 429/次限错误，读取 `x-ratelimit-reset`，暂停该仓库直至重置。
4. **同步范围可配**：仓库页提供「仅元数据 / 元数据+Issue+PR / 全量含源码」三档，降低大仓库同步超时。

**验收标准**：构造 App 失效/限流/网络抖动三种故障，均能给出明确错误与恢复路径。

**优先级**：P0（I4/C3/R2）　**负责人**：API + github-adapter 包

### 3.3 GitHub 接入全链路（App / OAuth / Webhook）

**背景**：v1.0.34 已把 GitHub 接入集中到单一页面；但 App/OAuth/Webhook 三者的「状态—配置—验证—回调」闭环仍缺自动化。

**目标**：接入状态一目了然，配置即验证。

**方案**：
1. **状态看板增强**：接入状态区增加「最近验证时间」「token 剩余有效期」「webhook 最近投递 200/非 200」三列。
2. **Webhook 自检**：页面提供「发送测试投递」按钮，直接向本仓库 webhook 发 ping 并回显结果。
3. **OAuth 登录态提示**：当前 OAuth 仅用于登录，若用户未启用 OAuth 登录，页面明示「当前用 WebUI token 登录，OAuth 未生效」。
4. **配置防呆**：App ID 输入框校验纯数字；私钥粘贴校验 PEM 头尾，避免常见复制错误。

**验收标准**：接入页三类状态均有可验证信号；测试投递可回显结果；错误输入有即时校验。

**优先级**：P0（I4/C2/R1）　**负责人**：web + api

### 3.4 分析与审查管线质量

**背景**：分析质量高度依赖 prompt 与模型；已有 #16（低信息量先给方向）、#14（相关 issue 裁决）等经验，仍缺统一的「质量护栏」。

**目标**：分析输出稳定、可解释、可回滚。

**方案**：
1. **Prompt 版本化与回滚**：分析/审查 prompt 抽到独立文件（可参 `issue-analysis/src/prompt.ts`），版本号随 registry 记录，支持按版本切换。
2. **输出 Schema 校验**：分析结果进库前用 `contracts` 包的 schema 校验（如缺字段则告警并降级为「基础评论」），防止模型返回畸形 JSON。
3. **降级矩阵**：按「模型是否支持 tools/function calling」「嵌入是否可用」「源码是否可取」三条件建立降级链，保证最小可用输出。
4. **行为开关化**（历史 #7 待办）：issue 自动指派、标题改写、深度分析等已有全局/仓库级开关（registry 已支持），补「按仓库角色」精细控制。
5. **标题格式规约**（历史 #5 待办）：将标题改写规则文档化，纳入 prompt 与校验双重约束。

**验收标准**：畸形输出不落库且有告警；每个功能点有开关可关闭；prompt 改动可回退上一版本。

**优先级**：P0（I5/C3/R3）　**负责人**：issue-analysis / pr-review / agent-capabilities 包

### 3.5 机器人多协议稳定性

**背景**：channel-adapters 支持官方 QQ + OneBot/Satori/Milky；qq-bot 容器默认不启动（无凭据重启循环）。

**目标**：多协议接入稳定、诊断友好。

**方案**：
1. **凭据门槛前置**：qq-bot 容器启动前检查凭据，缺失时进「待配置」等待态而非重启循环（日志明确提示去 WebUI 配置）。
2. **协议连通自检**：WebUI 机器人页增加「测试连接」按钮，对当前协议发心跳并回显。
3. **消息幂等**：重复事件（断线重发）按 `message id + 会话` 去重，避免重复回复。
4. **适配层统一错误**：把各协议错误归一为「可重试/永久失败/凭据错误」三类，驱动重试策略。

**验收标准**：无凭据容器不循环重启；测试连接回显；重复消息不重复回复。

**优先级**：P1（I3/C2/R2）　**负责人**：channel-adapters + qq-bot

### 3.6 边界与异常场景补全

- 大仓库（>10k files）扫描/向量化：分批 + 超时 + 进度可查。
- 空仓库 / 无语言文件仓库：友好空态。
- Issue 超长正文：截断策略（已有 `EMBED_MAX_CHARS=3000`，补分析侧截断与提示）。
- 模型返回空/超长：长度护栏与重试。
- 时区与日程边界：scheduler 扫固定时区，避免午夜跳动。

**优先级**：P1（I3/C3/R2）　**负责人**：各包 owner 认领

---

## 第四章 分析智能与提示词工程（P0）

### 4.1 Issue 分析质量深化

- **上下文召回增强**：目前靠 embedding 检索（nemotron-3-embed-1b/2048 维）；补「标题相似度 + 代码符号 + 最近编辑文件」多路召回，再合并排序。
- **低信息量识别**：延续 #16，对「信息量不足」的 issue 给出追问方向而非硬分析。
- **建议可执行性**：输出建议尽量带文件路径与行号（已有 deep analysis 能力），并标注置信度。
- **A/B 盲测**：定期抽取真实 issue，用新旧 prompt 各分析一次，双盲评分。

### 4.2 PR 审查质量深化

- **变更面裁剪**：超大 PR 按文件重要性抽样，避免 token 超限导致全量失败。
- **Check Run 与 Review 双通道**：`pr_check_run` + `pr_auto_review` 已支持开关；补「仅 Check 不自动 Review」的中间档。
- **假阳性治理**：对已关闭/已解决 warning 的学习库，避免重复报同类型问题（结合 memory 能力）。
- **多角色专家**：`agent_team_enabled` 已接入，补「专家未配置策略时降级单角色」的兜底。

### 4.3 重复/关联检测管线（judge 深化）

- **召回→裁决→上屏**链路已建立（#14）。优化方向：
  - recall 增加多路信号（标题/正文/代码/标签）并给信号分。
  - judge 输出结构化（related/duplicate/none + 理由 + 置信度），供 UI 展示「为何关联」。
  - eval 集扩充：从真实 issue 沉淀正负样本，纳入 CI 回归（`eval-runner` 已具备框架）。
- **去重写入**：判 duplicate 的 issue 在库里标记主从关系，避免重复分析成本。

### 4.4 模型路由与成本

- **Provider 健康度**：模型路由页展示各 Provider 最近成功率/延迟/配额，失败自动切换备用 Provider。
- **成本看板**：按 Provider/模型统计 token 消耗与估算费用（至少记录 usage 到审计/指标）。
- **模型选择策略**：分析用强模型、摘要/分类用轻模型（默认 gpt-4o-mini）的分层已存在雏形，补显式规则配置。

### 4.5 可评估闭环（eval 深化）

- `packages/duplicate-detection` 已有 eval-runner；推广到 issue-analysis / pr-review：
  - 建立统一 `packages/eval` 或复用 test-support，提供数据集格式与评分脚本。
  - CI 可选跑小型 eval（预算受限），发布前人工跑全量。
  - 结果沉淀为版本化报告（json/md），用于 prompt 迭代对比。

**验收标准**：三大包（issue/pr/duplicate）均有 eval 集与基线分数；prompt 改动可对比分数差异。

**优先级**：P0（I5/C4/R3）　**负责人**：issue-analysis / pr-review / duplicate-detection

---

## 第五章 前端体验与信息架构（P1）

### 5.1 导航与信息架构收尾

v1.0.34 已确立 5 组导航（工作台 / 分析 / 接入与身份 / 数据与运维 / 系统）+ 底部个人设置。收尾项：
1. **引导新手**：首次进入无仓库/无 Provider 时，仪表盘给「三步上手」引导卡（配 GitHub App → 配模型 → 装仓库）。
2. **搜索入口**：页面与设置项较多，侧栏顶部加轻量搜索（路由 + 设置项名），键盘可直达。
3. **分组折叠**：侧栏分组可折叠记忆（localStorage），缓解移动端抽屉层级。
4. **面包屑/当前位置**：topbar 已有 eyebrow+title，补「设置项属于哪页」的一致性提示。

### 5.2 设置系统体验

- **来源徽章统一**：已实现「应用默认 / 已覆盖·数据库 / 来自环境变量」；补「已覆盖·仓库」在全局页的提示与跳转。
- **批量保存**：同一分区的多字段支持「整体保存」，减少多次点击。
- **值预览**：secret 字段提供「显示/隐藏」切换与「复制」。
- **改动即校验**：enum/数字/布尔字段即时校验，非法值保存按钮置灰。

### 5.3 状态反馈与错误恢复

- **全局错误兜底**：React ErrorBoundary + API 错误统一 toaster（已有 errors.ts/ErrorPanel），补「离线检测」横幅。
- **加载骨架**：统一 LoadingRows 骨架，避免跳动。
- **空态设计**：所有列表页（任务/仓库/标签/记忆）提供「空态 + 行动按钮」，遵循「空态即是引导」。

### 5.4 主题 / 可访问性 / 响应式

- **主题**：现有浅/深色切换；补「跟随系统」三态，并保证新组件（SettingsSection 等）token 全覆盖。
- **可访问性**：键盘焦点可见、tab 顺序、aria 标签补全（现有部分页面已做），目标 WCAG AA。
- **移动端**：抽屉导航已实现；补移动端表格横向滚动与卡片化，确保任务/结果页可读。

### 5.5 前端性能

- 路由级懒加载（React.lazy）拆分大页面（ResultsPage/ProviderPage）。
- 大列表虚拟滚动（任务/结果页已用 useInfiniteScroll，评估是否需窗口化）。
- API 缓存：GET 5s 内存缓存已存在（bumpCache 失效），补针对慢接口的请求合并/防抖。

**验收标准**：首次加载 LCP < 2s（4G）；组件测试覆盖率 ≥ 40%；键盘可达所有功能；三态主题无漏色。

**优先级**：P1（I4/C4/R2）　**负责人**：web 前端

---

## 第六章 性能与资源优化（P1）

### 6.1 索引 / Embedding 性能

- **并发控制**：index-worker 向量化并发限制 + 批大小参数化，避免打爆 embedding API。
- **增量索引**：按文件 mtime/hash 增量更新（库已有 `issue_documents_content_hash` 先例），避免全量重建。
- **缓存命中**：相同/相似文件内容去重 embedding，用内容 hash 建缓存表。
- **超长裁剪**：已有 `EMBED_MAX_CHARS=3000`；补「摘要式截断」（取首尾+关键符号）而非硬切。

### 6.2 扫描与存储

- **扫描窗口**：大仓库错峰扫描，支持 cron 表达式配置（scheduler 已有 consolidation）。
- **存储水位**：文档/结果表清理策略（保留 N 天/按仓库），防磁盘膨胀。
- **向量检索调优**：pgvector 索引类型（HNSW vs IVFFlat）按数据量选择，监控查询延迟。

### 6.3 API 与缓存策略

- 热点 GET（概览/任务列表）加 Redis 缓存（当前为进程内 5s）。
- SSE 心跳与断线重连参数化，避免无效长连接。
- 慢查询分析：对 `/repositories`、任务列表等加执行耗时日志与索引核对。

### 6.4 资源配额与弹性

- compose 顶层 `mem_limit`/`cpus` 已示范（务必同步 NAS 本地 compose）；为 analysis-worker（LLM 密集）与 index-worker（embedding 密集）单独设配额。
- 队列积压时自动节流（Redis 队列深度阈值）。

**验收标准**：10k 文件仓库全量索引在可接受窗口完成；embedding 调用无 429；磁盘有清理策略保障。

**优先级**：P1（I4/C3/R3）　**负责人**：index-worker / scan-worker / scheduler / database

---

## 第七章 稳定性、容错与自愈（P1）

### 7.1 任务队列可靠性

- 任务表增加：可见性超时（visibility timeout）、失败原因、重试次数、死信队列。
- Worker 崩溃恢复：启动时认领未完成任务（幂等）。
- 队列深度指标化，超过阈值告警（对接第九章）。

### 7.2 幂等与重试

- 所有 GitHub 写操作（评论/标签/check/review）按「issue/pr id + 版本」幂等，避免重复评论（#14 教训扩展）。
- 网络抖动重试：统一 retry 中间件（可复用于 github-adapter / model-router）。

### 7.3 依赖健康与降级

- 健康检查分层：`/health/live`（存活）、`/health/ready`（依赖就绪）已有；补各 worker 的 self-check。
- 降级矩阵：embedding 不可用→退关键词召回；LLM 不可用→停自动分析、保留手动；Redis 不可用→任务挂起不丢。

### 7.4 崩溃恢复与数据一致性

- 分析/审查的「进行中」状态超时重置（防止永久卡死）。
- 事务边界梳理：写库与写 GitHub 的顺序（先落库后回调 or 先回调后落库）统一，保证最终一致 + 重放机制。

**验收标准**：故障注入（杀 worker / 断 Redis / 断 GitHub）后系统可自愈或明确降级，任务不静默丢失。

**优先级**：P1（I5/C4/R4）　**负责人**：task-engine / analysis-worker / api

---

## 第八章 安全与合规（P0）

### 8.1 凭据与密钥管理

- 现状：Provider 凭据、GitHub App 私钥、OAuth secret 经 AES-GCM（CREDENTIAL_MASTER_KEY）加密入库；引导项仅 env。
- 优化：
  1. **密钥轮换**：支持按 key 强制轮换（旧值保留宽限期、标记过期）。
  2. **CREDENTIAL_MASTER_KEY 管理**：文档化生成/备份/恢复流程；缺失时引导面板已给出明确提示（保留）。
  3. **凭据来源审计**：审计日志记录「谁在何时改了什么密钥」。

### 8.2 认证与会话

- WebUI token 单一入口 + OAuth 登录并存；补：会话有效期、失败锁定（防爆破）、token 前缀展示便于辨识。
- 登录接口限流（Redis 已有限流能力，接入登录路径）。

### 8.3 授权与最小权限

- 角色体系：现有 admin/用户 两级（0011_users_admin 迁移）；补「只读操作员」角色（可看不可改）。
- API 层统一鉴权中间件，避免新端点漏鉴权（#15 页面 401 教训：访问控制要可预期、错误可读）。

### 8.4 Webhook 签名与输入校验

- Webhook secret 校验已实现；补：payload 大小上限、事件类型白名单、来源 IP 可选校验。
- 所有外部输入（webhook/机器人消息/仓库设置）过校验层（contracts 包 schema），防注入。

### 8.5 审计日志

- 已存在 `audit` 模块（0012_audit_log + integration 测试）；扩：设置变更、凭据变更、用户管理、更新操作均记录操作人/时间/前后值（脱敏）。

### 8.6 提示词注入防护

- #12 已修复并有回归资产；持续：
  - issue/PR 正文作为「数据」而非「指令」进入 prompt，加隔离标记。
  - 模型输出中若包含「忽略系统提示」类指令，丢弃并告警。
  - 补充注入样本到 eval 集，纳入 CI。

**验收标准**：注入样本全通过防护；密钥轮换可操作；登录有防爆破；所有管理操作有审计。

**优先级**：P0（I5/C3/R3）　**负责人**：api / database / config / security 专项

---

## 第九章 可观测性与运维（P1）

### 9.1 日志体系

- 统一日志格式（JSON，含 requestId/任务 id/仓库/耗时），日志级别开关已支持（`log_level`）。
- 日志分级检索：WebUI「日志总览」已有，补按任务 id / 仓库 / 级别过滤。
- 关键错误（worker 崩溃、凭据失效、分析失败）独立 ERROR 流。

### 9.2 指标与告警

- 引入轻量指标：队列深度、任务成功率/耗时、LLM 调用延迟/失败率、embedding 429、webhook 投递成功率、容器重启次数。
- 采集方式：优先进程内汇总 + `/metrics` 端点（Prometheus 文本格式），无外部依赖，WebUI「运维」页可视化。
- 告警：阈值规则（如任务失败率 > 20%）+ 推送（可复用机器人通道或 webhook）。

### 9.3 健康检查与自检

- 各容器补齐 `/health/live`、`/health/ready`（api 已有，worker 补 self-check）。
- 定时自检任务：scheduler 定期探活各 worker，失联告警。

### 9.4 备份与恢复

- 已有导出/导入（settings+policies+providers，密钥脱敏）与 scripts/backup.mjs。
- 优化：PG 全量备份（pg_dump）+ Redis RDB 定期；备份保留策略；**月度恢复演练**并出报告。
- 备份清单文档化（RUNBOOK 补充），含 CREDENTIAL_MASTER_KEY 单独备份提示。

### 9.5 在线更新体验

- 更新历史已有；补：更新前备份自动触发（已有 backupBefore）、更新失败回滚报告、更新面板显示「上次成功版本 + 本次变更摘要」。
- `/update/status` 的 registry 探测加镜像站 fallback，避免直连超时显示「未知」（本次已排查为瞬态，仍建议加固）。

**验收标准**：核心指标可查可告警；备份可一键恢复（演练通过）；更新有完整审计轨迹。

**优先级**：P1（I4/C4/R2）　**负责人**：observability / api / scheduler

---

## 第十章 测试与质量门禁（P1）

### 10.1 测试覆盖现状

- 现状：约 70 个测试文件；后端包覆盖良好（settings/github-app/webhooks/repository-settings/duplicate-detection/issue-analysis/pr-review 均有），含集成测试。
- 短板：前端仅 9 个文件（nav/provider/ui/toast/error-states/pr-result/tasks-sort 等），22 个页面未覆盖；API 层 main.ts 测试少；无 E2E。

### 10.2 分层策略

| 层 | 目标 | 工具 | 覆盖率目标 |
|---|---|---|---|
| 单元 | 纯函数/规则（registry、diff、normalize、title 等） | vitest | ≥ 70% |
| 集成 | DB/Redis/任务引擎/worker handler | vitest + testcontainers 或 compose 服务 | 关键路径全覆盖 |
| 组件 | 前端页面与组件 | RTL + vitest | ≥ 40%（页面级） |
| E2E | 登录→配置→装仓库→触发分析→回写 | Playwright | 核心 3 条路径 |

### 10.3 前端组件测试优先清单

1. ReposPage（含 #15 场景的空/错/成功态）
2. GitHubAccessPage / AnalysisSettingsPage（SettingsSection 渲染与保存）
3. ConfigPage（瘦身后）+ UpdatePanel（阶段/成功/失败）
4. ProviderPage（添加模型表单）
5. 移动端抽屉导航行为（nav 组件）

### 10.4 质量门禁与 CI

- CI 必须跑：`typecheck` + `lint` + `unit` + `integration`；前端组件测试纳入。
- 覆盖率阈值：新代码块不允许降覆盖率（turborepo 缓存外 diff 覆盖）。
- PR 模板加「改动影响面 + 测试 + 回归」勾选，质量门禁未过不可合并。
- E2E 在发布前跑冒烟（可选夜间全量）。

**验收标准**：CI 全绿；前端组件测试 ≥ 40%；发布流程含冒烟 E2E。

**优先级**：P1（I4/C4/R3）　**负责人**：各包 owner + 前端

---

## 第十一章 工程效率与 CI/CD（P2）

### 11.1 本地开发体验（SMB 限制）

- 已知：`npm ci` 在 SMB 必然失败（workspaces 符号链接）。缓解：
  1. 文档化「Linux/WSL/真机」推荐开发路径（README 增加）。
  2. 提供 `docker-compose.dev.yml` 内的开发容器（挂载 + node_modules 放容器内），绕开 SMB。
  3. CI 加 `cache`（turbo remote cache 或 action cache），加速反馈。

### 11.2 构建与发布流水线

- docker-publish.yml 已自动化（tag push → 构建 → 推镜像 → Release）。优化：
  1. 构建矩阵加 `cache-from`/`cache-to`，加速镜像构建。
  2. 版本号生成与 tag 关联脚本化（改版本 → 自动 bump 全部 workspaces → 更新 lock → 打 tag）。
  3. 镜像多架构（amd64/arm64）评估，降低 NAS 换机迁移成本。

### 11.3 版本管理与 Release

- Release 已自动化；补：
  1. CHANGELOG 自动生成（conventional commits）。
  2. Release 描述模板（新功能 / 修复 / 迁移 / 部署说明），与 RUNBOOK 联动。
  3. 版本兼容矩阵文档（schema 版本 ↔ 容器版本 ↔ 前端版本）。

### 11.4 协作规范

- 提交信息规范（feat/fix/refactor/security 前缀 + issue 号，仓库已实践）。
- 分支策略：轻量 feature branch + PR（当前单人直推 main 可保留，但 PR 门禁开启）。
- 文档即代码：改动影响部署/RUNBOOK 时必须同步文档（纳入 PR 门禁）。

**验收标准**：一次 tag 全程自动化 ≤ 20 分钟；CHANGELOG 自动产出；文档与版本绑定。

**优先级**：P2（I3/C3/R2）　**负责人**：维护者

---

## 第十二章 部署与运维体系（P1）

### 12.1 配置治理（双 env 文件）

- 现状：根 `.env.production`（--env-file，IMAGE_TAG/AP_VERIFY）+ `docker/.env.production`（服务级 env_file，真实密钥）。易混。
- 优化：
  1. **单一来源模板**：`docker/.env.production` 作为唯一机密源，根 env 只留 compose 变量（IMAGE_TAG 等），减少双写。
  2. **校验脚本**：部署前脚本校验必填项（POSTGRES_PASSWORD、WEBUI_API_TOKEN、CREDENTIAL_MASTER_KEY、EMBEDDING_*、DEFAULT_LLM_MODEL）。
  3. **变量清单**：维护 `.env.example` 与生产 env 的 diff 文档（新增变量必须同步三处：example / 根 env / 服务 env）。

### 12.2 部署流程标准化

- 部署脚本化（本次已用 base64 脚本完成 pull+up）；沉淀为 `scripts/deploy.sh`，支持 `--tag` 参数与回滚（旧 tag 一键 up）。
- 部署前检查：磁盘、镜像站连通、目标 tag 存在。
- 回滚演练：`up -d` 回退旧 IMAGE_TAG 的完整步骤入 RUNBOOK。

### 12.3 环境一致性

- 生产 compose 与仓库 docker/ 源同步机制（改 compose 必须同步 NAS 本地），用 diff 校验脚本。
- 镜像一致性：记录每次发布对应 commit sha（Release 描述含 digest）。

### 12.4 灾难恢复演练

- 季度演练：全量备份 → 新机恢复 → 数据校验 → 出报告。
- 在线更新失败回滚演练（模拟 update.sh 中断）。

**验收标准**：部署/回滚均可脚本一键；配置校验前置；年度至少 2 次演练记录。

**优先级**：P1（I4/C3/R2）　**负责人**：维护者 + NAS 环境

---

## 第十三章 技术债清理专项（P2）

### 13.1 死代码与未接线模块

- v1.0.32 已清理一轮；继续：
  - 扫描未引用的 export（ts-prune 或手动）——重点 `packages/*/src` 与 `apps/web/src/pages`。
  - 移除 `docs/screenshots` 中无链接引用的旧图，避免误导。
  - 检查 `apps/api/src/main.ts`（4820 行）按路由拆分模块，提升可测性（对应 10.2 API 测试）。

### 13.2 依赖治理

- 核对 `package.json` 与 lock 一致（npm 直连会因 workspaces 失败，靠 CI 校验）。
- 升级策略：安全更新即时、功能更新季度评估；`pnpm`/`npm` 统一（当前 npm workspaces 与 pnpm-workspace.yaml 并存，明确取舍）。

### 13.3 遗留兼容层

- 移除 v1.0.31 之前未接线的设置读取路径（如旧 ConfigPage 直读逻辑），确保设置只走 registry。
- 迁移脚本清理：确认 0000-0017 迁移在干净库可全量回放。

### 13.4 文档同步

- 更新 RUNBOOK：新增优化方案索引、部署/回滚、备份恢复、密钥管理、告警规则。
- 更新 PROJECT_DESIGN：反映 v1.0.31-34 的设置系统与导航架构。
- README 补「开发环境（SMB 规避）」「测试运行」章节。

**验收标准**：无未引用 export 告警；文档与代码无重大漂移；迁移可干净重放。

**优先级**：P2（I2/C3/R1）　**负责人**：维护者

---

## 第十四章 路线图与里程碑

### 14.1 阶段划分

| 阶段 | 主题 | 主要交付 | 大致版本目标 |
|---|---|---|---|
| Phase A | 正确性加固 | #15 收尾与回归、同步链路、错误分级、前端缓存一致性 | v1.0.35–v1.0.37 |
| Phase B | 分析质量 + 安全 | prompt 版本化、eval 集、注入回归、密钥轮换、审计扩围、角色细化 | v1.0.38–v1.0.41 |
| Phase C | 可观测 + 稳定性 | 指标/告警、任务可靠性、降级矩阵、备份演练、更新面板加固 | v1.0.42–v1.0.45 |
| Phase D | 工程化收尾 | 前端测试补齐、E2E 冒烟、部署脚本化、配置治理、文档同步 | v1.0.46+ |

> 说明：以上版本号为示意，实际以功能聚合发布，不强制逐版本对应。

### 14.2 里程碑与验收

| 里程碑 | 验收标准 |
|---|---|
| M1（Phase A 完成） | 已安装仓库页 30 天零复现；同步失败有可读错误；强刷必为最新前端 |
| M2（Phase B 完成） | 三包均有 eval 基线；注入样本全通过；密钥可轮换；审计可查 |
| M3（Phase C 完成） | 核心指标可见并告警可达；故障注入可自愈/降级；恢复演练通过 |
| M4（Phase D 完成） | 前端组件测试 ≥ 40%；E2E 冒烟通过；部署/回滚脚本化；文档同步 |

### 14.3 资源与协作建议

- 每阶段以独立 issue 拆解派发，沿用「feat/fix + issue 号」提交规范。
- 单人维护可并行：前端（web）+ 后端（api/workers）+ 包（issue-analysis/pr-review）三条线。
- 关键外部依赖：模型网关能力（tools/function calling）、镜像站可用性、NAS 磁盘容量。

---

## 第十五章 风险登记册

| # | 风险 | 等级 | 缓解措施 |
|---|---|---|---|
| R1 | 前端测试补齐导致回归面扩大 | 中 | 组件测试随页面重构同步写；先覆盖高频页 |
| R2 | eval 集标注主观性 | 中 | 双人仲裁 + 样本来源真实 issue |
| R3 | 指标/告警引入新依赖 | 低 | 优先进程内汇总 + 文本 metrics，不强制 Prometheus 生态 |
| R4 | 密钥轮换破坏现有凭据 | 中 | 宽限期 + 明确文档 + 回滚预案 |
| R5 | 备份演练耗时/占空间 | 低 | 按数据量分层（settings-only 每日，全量周/月） |
| R6 | 镜像站/直连网络波动 | 中 | 探测加 fallback；部署脚本预检 |
| R7 | 多分支策略增加单人负担 | 低 | 保持轻量，PR 门禁可后置 |

---

## 附录 A：问题台账表（#1–#16 全量）

| # | 标题 | 状态 | 对应修复 | 优化链接 |
|---|---|---|---|---|
| 1 | （首版安装/向导相关） | CLOSED | — | — |
| 2 | 模型路由页面缺少配置入口 | CLOSED | ProviderPage 添加模型表单 | 3.3 / 5.2 |
| 3 | bug | CLOSED | — | — |
| 4 | bug | CLOSED | — | — |
| 5 | 建议（标题格式等） | CLOSED | 部分采纳 | 3.4.5 |
| 6 | 审核 issue 建议 | CLOSED | — | — |
| 7 | 建议（指派/开关化） | CLOSED | 部分采纳 | 3.4.4 |
| 8 | 连接 bug | CLOSED | — | — |
| 9 | 一直连接失败 | CLOSED | — | — |
| 10 | 同步仓库失败 | CLOSED | 修复 | 3.2 |
| 11 | 关于 issue2 审核结果建议 | CLOSED | — | — |
| 12 | 提示词注入防护验证 | CLOSED | 修复+回归资产 | 8.6 |
| 13 | 获取模型失败 | CLOSED | 修复 | 4.4 |
| 14 | Review bot 误关联无关 issue | CLOSED | v1.0.33 judge 裁决 | 4.3 |
| 15 | 点击已安装仓库后报错 | CLOSED | 缓存/版本归因 | 3.1 |
| 16 | 分析低信息量先给方向 | CLOSED | v1.0.32 prompt v5 | 4.1 |

## 附录 B：设置项注册表全量清单（v1.0.34）

| 分组 | 设置项 | 归属页 | 覆盖粒度 |
|---|---|---|---|
| github | github_webhook_enabled / github_webhook_secret / github_app_id / github_app_private_key | GitHub 接入 | 全局 |
| auth | webui_api_token | 系统配置 | 全局 |
| auth | oauth_client_id / oauth_client_secret | GitHub 接入 | 全局 |
| issue | spam_handling / issue_auto_assign / issue_assignee / issue_rewrite_title / issue_deep_analysis / issue_reanalyze_min_change | 分析设置 | 全局+仓库 |
| pr | pr_check_run / pr_auto_review | 分析设置 | 全局+仓库 |
| embedding | embedding_base_url / embedding_api_key / embedding_model | 模型路由 | 全局 |
| qq | qq_bot_protocols / qq_official_app_id / qq_official_app_secret / qq_official_gateway_url / qq_official_intents | 机器人 | 全局 |
| ops | log_level / agent_team_enabled / scan_enabled | 系统配置 | 全局 |

## 附录 C：优化项速查表（按优先级）

| 优先级 | 章节 | 条目 |
|---|---|---|
| P0 | 3.1/3.2/3.3/3.4 / 4.1-4.5 / 8.1-8.6 | #15 收尾、同步链路、GitHub 接入、分析管线、eval 闭环、安全合规全套 |
| P1 | 3.5/3.6 / 5.1-5.5 / 6.1-6.4 / 7.1-7.4 / 9.1-9.5 / 10.1-10.4 / 12.1-12.4 | 机器人稳定性、前端体验、性能、稳定性、可观测、测试、部署 |
| P2 | 11.1-11.4 / 13.1-13.4 | 工程效率、技术债清理 |

---

*文档维护：随版本迭代更新基线版本号、附录 A/B/C；新增 issue 同步登记。*
