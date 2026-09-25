---
name: replica-factory
description: 对已授权参考网站执行 WordPress 与 WooCommerce 高保真重建的编排流程。用于网站复刻、逐板块视觉修复、恢复重建任务和提交预览发布。先检查适配器是否就绪；不把此 Skill 当作自主调度器，不直接部署生产。
---

# Replica Factory

## 开始
读取根目录 AGENTS.md、README.zh-CN.md、project.json 与 docs/ADAPTER_CONTRACTS.md。
先执行 `python3 scripts/replica.py --help`。只运行已实现命令，不虚构 `replica start` 一类现成工具。
使用者尚未复制配置时，可从 examples/project.example.json 创建 project.json；保留所有未知项为待确认，不编造凭据。
执行 validate 和 doctor；doctor --auth 仅在允许检查本机已登录 CLI 时使用。
缺少采集/视觉/部署适配器时，按 BOOTSTRAP_AGENT_PROMPT.zh-CN.md 进行一次性平台建设，而不是宣称已经开始完整自动流水线。

## 流程
PREFLIGHT → DISCOVER → CAPTURE → FREEZE → BUILD → EVALUATE → REPAIR → EVALUATE → PREVIEW_READY → RELEASE_APPROVAL → RELEASE。
任何阶段可进入 BLOCKED。达到上限进入 EXHAUSTED。

PREFLIGHT：确认工作目录、开发站、WP-CLI/可用接口、GitHub 认证、隔离浏览器、授权范围、存储和预算。
DISCOVER：建立路径 × 视口 × 状态 × 板块矩阵，发现未覆盖页面；将动态内容、已授权素材和商业功能分别建模。
CAPTURE：调用 capture-reference 子 Skill；页面采集与生产权限严格分离。
FREEZE：将基准包和策略包哈希交给外部可信存储或受保护分支。普通修复无法替换它们。
BUILD：调用 wp-rebuild 子 Skill。先全局 tokens、header/footer，再页面模板和 WooCommerce 交互。
EVALUATE：由独立的可信评估器重新截图并产生报告。使用 gate 验证报告对应当前候选制品、基准和策略。
REPAIR：调用 visual-repair 子 Skill，按失败区域做最小改动；复验全部受影响模板。
PREVIEW_READY：可信流水线部署不可变制品到隔离预览站；重新检查远端制品版本、缓存和运行情况。
RELEASE：只由外部发布流程取得生产凭据并发布同一已验证制品。无审批就停止在 PREVIEW_READY。

## 恢复
读取 .replica/runs/<run-id>/state.json、最新可信评估报告、Git 状态与构建摘要。
这些状态是检查点，不是授权证明。不要凭旧会话中的“已通过”跳过测试。
每轮使用单独工作树/候选提交；评估失败时记录差异，不强行覆盖工作区。
调度器应独立于 IDE 进程运行，并具有持久化预算和站点级锁；启动包尚未实现该调度器。

## 停止条件
缺少授权、凭据或必要页面状态：BLOCKED。
预算达到上限或连续无改善达到上限：EXHAUSTED。
全部批准范围的门禁通过且远端预览复验通过：PREVIEW_READY。
不得将相似度、Agent 退出码或一页通过当作全站完成。

## 每次汇报
报告候选摘要、范围覆盖、素材缺失、精确像素差异、功能失败、剩余预算、预览地址和阻塞项。
不要输出秘密、cookie、完整 HAR、付款信息或生产客户数据。
