# 多站点复用与版本升级

## 最终仓库关系

```text
OWNER/wp-replica-factory          通用工具、Skills、评估器、框架测试、版本发布
OWNER/replica-site-template       稳定后抽出的轻量站点骨架（现在不必创建）
OWNER/shop-001                    一个站点，固定一个框架版本
OWNER/shop-002                    另一个站点，独立业务/配置/权限
```

早期只创建框架库，跑通一个隔离试点。不要立刻复制几十份完整框架。
不要用长期分支代表不同客户；普通 feature 分支是短期开发工具，客户/站点应在独立仓库。

## Template 不是升级系统

GitHub 模板用于一次性初始化文件，新项目不是自动跟随框架 main 的依赖。
框架修改不会自动传播；不要把 template、fork、clone、版本依赖当成同一种机制。
目前无需把框架本身标记为 Template。站点初始化器完成后，精简站点骨架才适合标记。

## 建议实施的 G5 方案

框架作为固定版本依赖，站点初始化器只生成主题骨架、站点配置、薄 Skill 入口及版本锁。
先支持一种分发方式：建议原型期使用固定 commit 的 Git submodule；稳定后按需要转为固定摘要的发布包/OCI 镜像。
Git submodule 本身不提供安全隔离；受保护评估器与生产发布仍应在独立权限环境运行。

初始化器需要实际实现这些工作：

1. 创建全新站点目录，拒绝覆盖现有代码。
2. 安装指定框架 commit，不隐式跟随 main/latest。
3. 在站点根部安装 .agents/skills 入口。不能假设 IDE 会自动扫描深层 submodule 中的 Skills。
4. 调整 Skill/脚本的相对路径，正确区分「框架目录」与「站点工作目录」。
5. 从不含秘密的配置模板生成站点配置，并记录使用的框架版本、commit、报告 schema 和执行环境。
6. 验证版本锁与实际依赖一致，并检查已有本地更改；版本字段不是装饰。
7. 生成 CI 的框架引用，并在有权限的 CI 里验证私有依赖能读取。

本包没有实现这些初始化/升级命令；不要宣传 `factory new` 或 `factory upgrade` 已可运行。
原始 project.json 中的 factory_version 仅是声明字段，当前 validate 不会替你验证已安装依赖版本。

## 升级必须是独立 PR

框架修复 → 全套自有回归通过 → 发布新版本 → 站点提出升级 PR → 更新实际依赖和锁 → 该站点完整视觉/功能测试 → 维护者合并。
生产使用被测试的同一制品，升级框架不自动改变已经上线的站点。
升级工具必须保留主题定制、商品、上传目录、配置、基准与预算状态；检查策略变化另行审批。
回滚恢复旧框架依赖和旧代码制品，不默认回滚生产数据库。

## 重用 GitHub Actions 的注意点

可复用 workflow 应提供 workflow_call，并以经验证的完整 commit SHA 引用，不能把当前 control-tests.yml 直接当成跨仓库调用接口。
`uses: OWNER/REPO/.github/workflows/file.yml@SHA` 中的引用必须实际存在，不能在 workflow YAML 里动态读取 JSON 再拼接 uses。
跨仓库调用中，普通 actions/checkout 默认检出调用方代码，不会自动把框架脚本放到本地；共享 workflow 必须显式取得固定版本的框架。
私有框架 workflow 的共享权限、私有依赖读取权限和 token 范围分别配置；调用方默认 GITHUB_TOKEN 不等于能读取其他私有仓库源码。
重用一个 workflow 不代表可信隔离已经实现；普通 Agent 不能修改生产发布器的受保护实现和策略。

## 优化什么才会积累

某站点按钮颜色不对 → 站点仓库修复，不回流进通用框架。
任何站点都可能漏采 CSS 背景图 → 制作自有最小页面，在框架修复采集器并加入回归。
普通修复能覆盖基准 → 框架安全问题，补独立验收/权限隔离，并加入拒绝路径测试。
将这些案例记录成测试与版本化规则，而不是只堆积聊天记录或无限加长 SKILL.md。

## 核验来源

- Templates: https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template
- Reusable workflows: https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- Private sharing: https://docs.github.com/en/actions/how-tos/reuse-automations/share-with-your-organization
- Git submodules: https://git-scm.com/book/en/v2/Git-Tools-Submodules
- Codex skill discovery: https://developers.openai.com/codex/skills
