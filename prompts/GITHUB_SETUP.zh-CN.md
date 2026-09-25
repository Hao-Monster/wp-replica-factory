# 首次 GitHub 托管任务

在下载并解压本包的根目录中执行。用户应已明确授权创建仓库；以下默认新建本人账号下的私有 `wp-replica-factory`。
若需组织账号，先由用户明确 OWNER；不要猜测组织或改变已有仓库可见性。

使用 factory-maintainer。
先读取 AGENTS.md、README.md、CONTRIBUTING.md、docs/GITHUB_OPERATIONS.zh-CN.md。
本次只把通用框架托管并建立维护入口，不采集网站、不重新安装 WordPress、不升级服务、不部署生产。

检查 git/gh/Python 与 gh 认证，报告缺项但不输出令牌。检查已有 .git、远端和未提交改动；有现成仓库时保留历史，不 reset、不 force push、不覆盖同名远端。
在全新目录中才初始化 main。运行全部本地测试和示例配置验证。
确保所有隐藏的 .agents 和 .github 文件被纳入源码；不要只提交 ZIP。
将真实 project.json、密钥、浏览器状态、数据库和原站素材排除。审阅暂存区并运行 check_repo_files.py；必要时接入独立内容型秘密扫描器，不声称此路径检查能发现所有秘密。

如果尚无对应远程仓库，按用户授权创建 PRIVATE wp-replica-factory，并推送源文件。
若同名仓库已存在，先读取确认是不是该项目；不擅自删除或覆盖。
读取第一次 GitHub Actions 的实际结果；失败则在工作分支修复，不伪报成功。
不要启用 ci-templates 中尚未接通的发布工作流，不自动运行收费 Agent。

生成 CODEOWNERS 时使用真实维护者身份，解释它只有结合实际分支保护才有强制效果。
核对当前私有仓库套餐支持的保护功能；不支持的明确标记，不改成公开仓库来绕过。
单人用户与 Agent 不得共用身份来假装独立审批。生产继续禁用。

依据 ROADMAP 创建首批 4 个小 Issue：自有测试站、确定性采集、真实评估器、一个 WooCommerce 预览闭环。
每个 Issue 给出输入/输出、负向测试、验收标准和依赖，不自动开始所有任务。
输出仓库地址、分支/commit、实际 CI 状态、已完成设置与需人工设置项。
未经单独授权，不配置组织级设置、不购买套餐、不创建 token、不发布正式 release。
