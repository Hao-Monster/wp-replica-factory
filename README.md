# WordPress Replica Factory

用于持续开发「授权网站 → WordPress + WooCommerce 高保真重建」工具链的框架仓库。

**当前版本 0.1.1：控制层 + GitHub 仓库管理准备版，不是完整自动复刻器。**
本分支新增可选的下载器 v0.1：固定 OpenDesign 子集与 Playwright，在自有 fixture 上落盘 HTML/资源并独立预览；完整状态采集、可信视觉评估、持续调度器和部署适配器仍待实现。CI 不运行模型、不爬取外站、不连接 WordPress、不部署。

## 从这里开始

下载、文件验证、断源预览与固定验收：`docs/DOWNLOADER.zh-CN.md`。
命令入口：`node tools/downloader/cli.mjs --help`。owned fixture 已正式进入 `main`，Downloader 验收直接使用当前 checkout 的 `scripts/fixture_site.py` 与 `tests/fixtures/owned-site/`。

- 首次上传 GitHub：`docs/GITHUB_OPERATIONS.zh-CN.md`。
- 交给 IDE 的首次仓库托管任务：`prompts/GITHUB_SETUP.zh-CN.md`。
- 每次框架改进：`prompts/IMPROVE_FACTORY.zh-CN.md` 与 `CONTRIBUTING.md`。
- 自有测试站：`docs/FIXTURE_SITE.zh-CN.md`。
- 平台建设技术规格：`BOOTSTRAP_AGENT_PROMPT.zh-CN.md`。
- 建设优先级：`ROADMAP.md`。
- 多站点复用与升级：`docs/VERSIONING_AND_REUSE.zh-CN.md`。
- 原控制层的命令和边界：`README.zh-CN.md`。

## 本地检查

Python 3.10+、Git。建议 macOS/Linux/WSL 环境。

```bash
python3 -m unittest discover -s tests -v
python3 scripts/replica.py validate --project examples/project.example.json
# Git 初始化、git add 后检查索引内的文件名；不读取密钥内容。
python3 scripts/check_repo_files.py
```

`check_repo_files.py` 只是敏感文件名/运行产物路径检查，不是完整秘密扫描器。
提交前还要人工审阅暂存区；涉及 token 或私钥内容的检测另接专业扫描器。

## 仓库边界

框架仓库存通用 Skills、代码、测试、适配器契约和脱敏示例，不存具体店铺、第三方素材、真实商品/订单、浏览器会话或服务器配置。
每个真实站点使用独立私有仓库及隔离运行环境。
`project.json` 被默认忽略；框架 CI 使用 `examples/project.example.json`。

`.github/CODEOWNERS.example` 只是未启用样例。改成真实审核人并保存为 `CODEOWNERS` 后，还要在 GitHub 上启用相应保护，才有实际审批约束。

## 版本不等于功能成熟度

`VERSION` 仅表示此框架源码的发布版本。没有端到端证据，不得将功能标记为已完成。
模板创建的仓库不会自动获得后续框架修改；旧站点升级必须另开 PR 并测试。
发布、凭据、生产审批与框架升级不能交给普通站点修复 Agent 自行决定。

当前未为用户选定开源许可证；默认先使用私有仓库。公开前人工核对代码、依赖、素材来源及许可。
