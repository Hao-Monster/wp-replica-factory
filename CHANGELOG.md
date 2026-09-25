# Changelog

## Unreleased

- 新增独立 Node 下载器 v0.1，选择性复用固定 OpenDesign web-clone 子集，保留其目录 MIT 许可和根许可说明。
- 新增 download/verify/preview/compare：真实浏览器响应体、三页发现、query/内容变体映射、CSS/HTML 解析改写、独立预览和原生 HAR。
- PR #5 固定版本仅作只读测试依赖；自有站双视口和断源菜单/筛选/懒加载验证，不接入 Reebelo、WordPress、WooCommerce 或生产。
- 新增错误输入、损坏资源、预算、重定向、越界路径、哈希/空报告和退出码不一致等反例；保留旧 Python 门禁及其测试。
- **需维护者审核：** 新增只读下载 CI 与采集/预览网络边界。公共网页模式仍 blocked；只上传自有 fixture 的脱敏报告和截图，保留 7 天，不上传 raw/site/HAR/字体。
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
