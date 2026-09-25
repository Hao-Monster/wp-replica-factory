# GitHub 托管与日常操作

本说明针对 0.1.1 仓库版，使用 Bash（macOS/Linux/WSL）。当前本地代码可以测试；上传 GitHub 不会自动补齐采集器、调度器或部署器。

## 1. 创建通用框架仓库

解压到新目录，进入含 AGENTS.md 和 .agents 的根目录。已有 Git 仓库不要重新初始化、覆盖远端或 force push；先合并规则和检查历史。
不要只把 ZIP 上传到 GitHub，要把解压后的源码纳入版本管理，隐藏目录也必须包含。

```bash
cd wp-replica-factory-github-v0.1.1
# 本机已经登录的 gh 仍需检查；不要运行或分享 gh auth token。
gh auth status
git --version
python3 --version

# 仅在全新目录执行。
git init -b main
python3 -m unittest discover -s tests -v
python3 scripts/replica.py validate --project examples/project.example.json

git add .
python3 scripts/check_repo_files.py
git diff --cached --check
git diff --cached --stat
# 在本地检查实际内容，避免把可能的秘密粘到聊天或 Issue。
git diff --cached
```

任何检查失败先停止。确认暂存文件正确后，执行下面这组会创建远程私有仓库的命令。
初次提交若缺少 git user.name/user.email，设置你自己的提交身份，不伪造作者。

```bash
git commit -m "chore: initialize replica factory framework"
# 不写 OWNER 时默认当前认证用户；组织仓库改成 OWNER/wp-replica-factory。
gh repo create wp-replica-factory --private --source=. --remote=origin --push

gh repo edit --default-branch main --enable-issues --delete-branch-on-merge
gh repo view --web
gh run list --workflow control-tests.yml --limit 5
```

同名仓库已存在时停止，不删除/覆盖。若你已在网页上创建了确认属于此项目的空仓库，可另行添加其 origin 后 push；不要重复 create。
当前框架仓库无需设为 Template。后续精简的站点模板再单独标记，避免复制整套框架后误以为会自动同步。

## 2. 配置真实保护

到 Settings 的分支保护/Rulesets 区域，为 main 要求 PR、control-tests 成功、禁止强推与删除。
按可用能力启用审核和 code-owner 审查；实际检查名称以第一次 GitHub CI 显示为准。
将 .github/CODEOWNERS.example 中的占位符替换为有写权限的维护者，另存为 CODEOWNERS。示例文件本身不会生效。

私有仓库的保护能力取决于套餐；不能启用的明确记录。不要为了拿免费功能擅自公开仓库。
单人维护者不能给自己创建的 PR 形成独立审核。需要强制隔离时，Agent 使用受限独立身份提交，维护者审核；独立身份/权限必须实际配置，不能只靠提示词。
不要把个人管理员 gh 凭据原样授予不受信任的网页采集 Agent。

Settings → Actions 的默认工作流 token 使用最低权限。当前 CI 只需 contents: read。
暂时不配置生产秘密，不启用 ci-templates 中的未接通模板，不接任意评论触发的收费模型循环。

## 3. 固定初始版本（维护者操作）

第一次远程 CI 确实通过后，在已审阅且工作区干净的 main 上创建预发布。

```bash
git switch main
git pull --ff-only
# 确认 git status 干净，HEAD 就是已审阅/已通过 CI 的提交。
git status --short
git tag -a v0.1.1 -m "Framework scaffold; not end-to-end ready"
git push origin v0.1.1
gh release create v0.1.1 --verify-tag --prerelease \
  --title "v0.1.1 - framework scaffold" \
  --notes "GitHub-ready control-plane scaffold. Capture, evaluator, scheduler and deployment adapters are not implemented."
```

不要移动已有 tag；错误修复发布新版本。版本号与功能成熟度分别记录。
完整采集和发布未实现前，不能把框架 release 描述成一键复刻产品。

## 4. 日常改善

先建 Issue（在网页选择模板更方便），或：

```bash
gh issue create \
  --title "feat: deterministic capture on an owned fixture page" \
  --body "Implement deterministic page/region capture on an owned fixture. Include missing-asset and state-coverage failures. No external commercial site or production deployment."
```

把实际 Issue 编号与 prompts/IMPROVE_FACTORY.zh-CN.md 交给 Agent。每次只做一个可审阅改动。
示例分支操作，42 必须换成真实 Issue 编号：

```bash
git switch main
git pull --ff-only
git switch -c feat/42-deterministic-capture
# Agent 实现、补测试与文档；确认权限边界。
python3 -m unittest discover -s tests -v
python3 scripts/replica.py validate --project examples/project.example.json
# git add 实际修改的明确文件后运行：
python3 scripts/check_repo_files.py
git diff --cached --check
git commit -m "feat: add deterministic capture fixture"
git push -u origin HEAD
gh pr create --draft --base main --fill
```

只在 PR 中根据真实 CI 结果修复；你审阅后合并。CI 通过不证明 AI 会正确复刻，视觉/功能集成测试需要后续真实实现。
维护者按批次发布框架版本；各站点通过另一个升级 PR 获取改进，不全站无审核自动更新。

## 5. 数据放在哪里

Git：通用代码、Skills、测试、脱敏小 fixture、文档和版本锁。
每站点私有仓库：主题、自定义插件、可公开于该团队的业务规则和脱敏配置。
受限制品/对象存储：已授权素材、完整截图、差异图、运行报告与日志；设访问控制及保留期限，日志需脱敏。
秘密存储或本机被忽略文件：凭据、cookie、真实连接信息；不进入通用仓库。

.gitignore 不会清除已跟踪文件或历史；check_repo_files.py 会检查索引，但不会检查所有秘密内容。泄露时先轮换凭据，不是仅删除文件。

## 6. 两条 CI/CD

框架：PR → 测试/自有 fixture 回归 → 维护者合并 → 版本发布。
站点：固定框架版本 → 站点修改 → 视觉/功能验收 → 预览 → 审批生产 → 健康检查/代码回滚。
当前只接通第一条中的基础控制层测试，其他阶段见 ROADMAP.md。

## 核验来源

官方文档核对日期：2026-09-25。项目设计属于本仓库建议，不是官方功能承诺。

- GitHub CLI repo create: https://cli.github.com/manual/gh_repo_create
- GitHub CLI repo edit: https://cli.github.com/manual/gh_repo_edit
- GitHub CLI PR create: https://cli.github.com/manual/gh_pr_create
- GitHub CLI release create: https://cli.github.com/manual/gh_release_create
- GitHub templates: https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template
- Protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- CODEOWNERS: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
- Secure use: https://docs.github.com/en/actions/reference/security/secure-use
- Codex skills: https://developers.openai.com/codex/skills
