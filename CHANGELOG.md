# Changelog

## Unreleased

- Add the independent deterministic visual evaluator for trusted baselines and candidate screenshots. Issue #3/G2 remains separate from site rebuild and production release.

## Unreleased

- Add challenge-aware public capture diagnostics with controlled AWS-like fixtures. Challenge pages stop capture with `blocked` / `challenge_detected`; page runtime errors are recorded separately and do not alone fail an otherwise valid capture. No WAF/CAPTCHA bypass is introduced.

## Unreleased

- 新增独立 Node 下载器 v0.1，选择性复用固定 OpenDesign web-clone 子集，保留其目录 MIT 许可和根许可说明。
- 新增 download/verify/preview/compare：真实浏览器响应体、三页发现、query/内容变体映射、CSS/HTML 解析改写、独立预览和原生 HAR。
- owned fixture 已作为框架正式组成部分进入 `main`；Downloader 直接使用当前 checkout 的 fixture、required-state contract 与运行时数据，自有站双视口和断源菜单/筛选/懒加载验证不依赖外部 PR checkout。
- 新增错误输入、损坏资源、预算、重定向、越界路径、哈希/空报告和退出码不一致等反例；保留旧 Python 门禁及其测试。
- **需维护者审核：** 扩展只读 Downloader CI，加入 controlled authorized-public HTTPS/DNS/redirect/write-safety 测试；公网 MVP 使用统一 network guard、CONNECT 前 DNS/IP 校验、`needs_approval` 与 sanitized network report。CI 仍不上传 raw/site/HAR/字体。
- 该子阶段不完成整个 Issue #2/G1，不引入可信逐像素评估或生产发布，不自动升级已有项目。

尚未实现的能力见 ROADMAP.md。不要将规划写成已完成。

## 0.1.1 — 2026-09-25

仅做 GitHub 托管与持续维护准备；未改变原复刻控制层算法。

- 新增 README.md、VERSION、CONTRIBUTING、路线图、仓库操作和版本复用说明。
- 新增首次托管/持续改进提示词与 factory-maintainer Skill。
- 新增 Issue、PR 模板及未启用的 CODEOWNERS 示例。
- 加强 .gitignore，防止本机配置、会话、运行证据与业务数据进入通用仓库。
- 新增 Git 索引文件名检查与相应测试，并接入无秘密 CI。
- 示例目标改为保留示例域；授权仍为 false。
- 浏览器采集、真实视觉评估、站点生成/升级和生产发布仍未实现。

## 0.1.0 — 原始启动包

提供四个重建 Skills、Python 控制层、19 项测试、平台建设规格与未启用的 CI/CD 示例。

## Unreleased

- Added a local-only owned fixture site with fixed product data, resource manifest, lifecycle commands, responsive grid, lazy background/SVG state, and menu/filter states.
- Added Playwright browser acceptance and negative lifecycle tests; CI runs the locked fixture browser job without external site or production access.
- Hardened fixture run-directory ownership and reset boundaries; runtime pages now read the managed seed copy.
- Made versioned resource/state manifests authoritative and expanded browser observations and negative tests.

## 2026-09-25

- Bound browser semantic comparison failures to a non-zero acceptance exit code and validated the complete wrapper report structure.
- Unified positive and negative lazy-background checks, including actual desktop/mobile viewport dimensions.
- Hardened Issue #1 fixture lifecycle against existing and dangling symlink/junction targets and unowned directories.
- Added real lazy-background response, decode, applied-style, and controlled negative browser checks.
- Restricted fixture health checks to explicit local HTTP origins and rejected redirects before following them.
- Added structured acceptance failure evidence with always-run CI artifact upload while preserving test exit codes.
