# WordPress Replica Factory — 控制层说明（仓库版 0.1.1）

首次 GitHub 托管请从 README.md 与 docs/GITHUB_OPERATIONS.zh-CN.md 开始。下文描述原控制层，不表示新增完整采集或部署能力。

生成日期：2026-09-25。

本包用于把“授权网站重建”做成可复用的工程流程：共享 Skills + 项目配置 + 确定性脚本 + 独立验收 + CI/CD。
不是已经能输入任意 URL 就完整复刻、自动部署的成品，也不包含 Reebelo 的素材、字体或主题。
没有访问或修改你的 GitHub、WordPress、服务器或账号；没有实际运行 Reebelo 复刻或远程部署。

## 已实现

- WooCommerce staging MVP：通用主题 scaffold、只读 Downloader reference bundle 接口、WP-CLI staging adapter、隔离 Compose CI 验收与 rollback/cleanup 契约。Issue #4/G3 的独立 visual evaluator 仍未实现。

- 可选下载器 v0.1：单入口多页真实采集、资源落盘/本地化、独立预览与验证。支持 owned loopback fixture 与最小 authorized-public HTTPS 模式；公网模式要求用户明确授权、单一 page origin、显式 asset origins，并拒绝登录/challenge 与业务写请求。owned fixture 已正式存在于 `main`，Downloader 测试直接使用当前 checkout 的 `scripts/fixture_site.py`、RESOURCE_MANIFEST 与 STATE_MATRIX，不再依赖外部 PR checkout。安装、实际入口、固定验收和限制见 `docs/DOWNLOADER.zh-CN.md`。这不表示下列完整平台建设已完成。

- `.agents/skills/` 中一个编排 Skill、三个专项 Skill，以及 AGENTS.md。
- Python 标准库控制脚本：配置验证、工具/可选认证检查、检查点初始化、基准文件哈希封存与验证。
- 严格报告门禁：绑定候选制品、基准和策略摘要，拒绝缺失/重复截图、像素差异、缺图、缺字体、跳过用例、功能失败及旧报告。
- 仅打包显式指定主题目录的 ZIP 工具，拒绝符号链接、隐藏文件与禁止文件类型。
- 19 项控制层单元测试，以及不访问秘密、不部署的 GitHub Actions 工作流；仓库版另外增加文件路径检查及其测试。

## 必须完成的一次性平台建设

`BOOTSTRAP_AGENT_PROMPT.zh-CN.md` 是给 Codex / Antigravity 的施工说明，要求它补齐以下真正执行能力：

- 参考站发现、素材/CSS/状态采集和可重复 Playwright 截图。
- 独立、固定版本的视觉与 WooCommerce 功能评估器。
- 站点级状态机、跨进程持久化预算、锁、Agent 调用、恢复与有界修复循环。
- WordPress 开发环境适配、fixture、内容幂等迁移。
- 与你真实主机相匹配的预览/生产部署、缓存刷新、健康检查、制品校验和回滚。
- 外部可信的基准/策略存储、发布审批及凭据隔离。

`ci-templates/*.example` 都是未启用的模板；其中的适配阻断步骤会明确失败，不能直接当成可用 CD。
`init` 只创建检查点，不会在后台启动 Agent 或持续任务。
`gate` 只检查报告契约，不生成截图，不验证报告是否真实。生产评估必须在 Agent 无法改写的可信执行环境中生成并传递报告。
哈希文件能检测变化，不能证明授权、来源真实性或防止同时替换文件和哈希。必须由外部可信系统提供期望摘要。

## 开始使用

把本目录放在一个新项目仓库中，不要直接覆盖已有项目的 AGENTS.md 或 .gitignore。已有仓库应审阅后合并规则。

```bash
# 在本包根目录执行；仅适用于新仓库，已有仓库不需要 git init。
git init
cp examples/project.example.json project.json
python3 scripts/replica.py validate --project project.json
python3 scripts/replica.py doctor --project project.json --auth
python3 -m unittest discover -s tests -v
```

编辑 project.json 的开发站 URL、WordPress 目录、主题名、页面范围和预算。
授权标记初始为 false：只有真实确认授权或自有素材替代方案后才填写 true。
首页只是样例，不是全站验收清单。发现阶段必须补全实际页面、状态、板块、视口，并冻结策略。
密钥不写进 JSON；通过环境级秘密存储或受限凭据代理提供。

在 Codex 中选择 `$replica-factory`，或在 Antigravity 中要求使用 `replica-factory`。
第一次任务明确要求：先执行 BOOTSTRAP_AGENT_PROMPT.zh-CN.md 的平台建设和端到端验证，再做目标站。
后续站点基于经过验收、固定版本的平台创建独立仓库和 project.json。

## 实际可用命令

```bash
python3 scripts/replica.py --help
python3 scripts/replica.py init --project project.json
# 将下面路径换成 init 输出的真实 state_path。
python3 scripts/replica.py status --state .replica/runs/RUN_ID/state.json

# 下列命令需先由采集器产生 reference/v1。
python3 scripts/replica.py seal --directory reference/v1 --output baseline.lock.json
python3 scripts/replica.py verify --lock baseline.lock.json

# 此包没有生成主题；已有主题后可打包，但这不会部署或批准它。
python3 scripts/replica.py package-theme   --theme-dir wp-content/themes/replica-shop   --output artifacts/replica-shop.zip
```

gate 用法与报告契约见 docs/ADAPTER_CONTRACTS.md。

## 默认设计选择

原生 WordPress 定制主题 + WooCommerce。浏览器自动化选 Playwright 作为确定性引擎；MCP 用于探索与诊断，不是 CI 必须启动的第二套浏览器服务。
共享 Skills 放在 .agents/skills/。Codex 支持仓库级该目录；其他 IDE 的自动发现以当前安装版本实测为准，必要时显式要求读取 Skill。
本机 gh 登录、本机 WordPress 地址、IDE 登录态不会自动成为云端运行器可用的认证或网络入口。
预览自动发布；生产默认审批，不覆盖生产数据库/订单/uploads。自己的商品和文案不同于参考站时，必须分离视觉 fixture 验收与真实业务验收。

## 已验证范围

原 0.1 包记录了 19 项控制层测试。仓库版的本次本地测试结果见 TEST_RESULTS.txt；运行环境及未验证范围在该文件中单独列出。
未运行 GitHub 云端工作流、浏览器采集、真实 WooCommerce 测试、Codex/Antigravity 执行或主机发布。
不要把控制层测试通过当成像素级重建通过。

官方资料见 docs/SOURCES.md；架构与阈值设计为本包的建议，不是工具官方承诺。
