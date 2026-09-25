# CI/CD 与长期自动修复设计

## 两条循环

开发循环：读取失败证据 → 最小修复 → 本地构建 → 独立评估 → 持久化状态。
发布循环：候选提交 → CI → 隔离预览 → 远端复验 → 批准 → 生产 → 健康检查/代码回滚。
不建议每次改 1px 都走生产部署。按组件里程碑提交；候选失败时可提供标明“不合格”的调试预览，但不能发布生产。

## 三个权限域

采集 runner：只有公开/获准浏览器访问与基准写入权限，不能取得生产凭据。
编码 runner：读取只读基准，写候选代码与工作分支，访问测试数据库；不能改评估器或发布策略。
评估/发布控制侧：独立版本的验收器、基准摘要和策略；发布阶段单独注入生产凭据，不运行未审阅代码中的发布脚本。
如果 PHP 候选在预览执行，预览也必须是无真实客户/支付凭据的隔离环境。

## 建议工作流

ci.yml：对 PR 做无生产密钥的构建、PHP lint、测试和秘密扫描。UI 评估由可信评估器运行。
preview.yml：内部可信候选通过最低安全检查后发布隔离预览，完整 gate 通过才标 PREVIEW_READY。
release.yml：只发布已经验证的不可变制品，使用真实审批机制，不重新构建另一个包。
repair.yml：可信控制器有界触发，读取失败证据后运行 Agent；修复补丁只能修改允许目录，随后重新跑独立 CI。

一个 reusable workflow 只存一份并固定 SHA，各站点仓库仅传 project_id 和候选制品引用，不能传任意 shell。
优先将策略/验收器/发布代码放在普通修复 Agent 无权写入的控制仓库。
不对 secrets 使用 `secrets: inherit` 全量传递，显式划分所需凭据。

## GitHub 特别注意

本机 gh 登录不传给 GitHub Actions。CI 需要自身的 GITHUB_TOKEN、GitHub App、OIDC 或环境秘密。
使用 GITHUB_TOKEN 的 push 不自动触发新 push 工作流；当前部分 PR 事件会等待审批。持续自修复需显式设计可信 dispatch 或使用限定作用域的 GitHub App token。
创建 Environment 名称不等于启用了审批；私有仓库保护能力受 GitHub 套餐影响。不能假定所有账号都能使用 required reviewers。
若套餐不支持需要的审批机制，使用独立发布控制仓库/服务与独立身份。普通编码 token 不得触发生产。
使用站点 + environment 作为 concurrency key；新 CI 可以取消旧 CI，但已经开始切换版本的部署应完成/回滚，不随意中断。
运行器对仓库事件、branch 和调用者做 allowlist。公共 fork 不得进入带部署/API key 的 runner。
`workflow_run` 和 `pull_request_target` 不是天然安全；禁止在高权限任务中 checkout/执行不可信候选代码。

## 凭据与网络

本机 Docker / localhost WordPress 无法直接由云端 runner 访问；推荐 runner 内独立测试站，或受限网络中的隔离 runner。
不开放 wp-admin/数据库到公网只是为了让 CI 能连接。
浏览器不共享日常 profile；模型只看到密钥引用名，不看值。CI 任务不把模型 API key 放在整个 job 的通用环境里。
操作系统/容器层隔离密钥，不依赖 .gitignore 当访问控制。

## GitHub Actions 示例范围

`.github/workflows/control-tests.yml` 是可运行的控制层单元测试，不是视觉/部署 CI。
`ci-templates/preview.yml.example` 与 `release.yml.example` 故意保留阻断步骤，需实现可信适配器后才启用。
示例中的 environment 本身不能提供审批保证；必须在平台配置并验证真正的审批和权限。

## 自动修复终止策略（建议初值，不是性能承诺）

每任务最多 12 轮，总运行预算 120 分钟；连续 3 轮没有可测改善停止；累计 token 上限 500000。
预算保存在外部状态，不跟随工作区清理或 job 重启归零。
引用源站更新不能静默换基准；作为单独 reference refresh 任务审批后重新验收。
