# WordPress Replica Factory — 框架交接与维护记录（Antigravity E）

日期：2026-09-27  
维护者：Antigravity E (Framework Maintainer)  
仓库：`Hao-Monster/wp-replica-factory`  
本地独立工作目录：`E:\CodeWorkstation\wp-replica-factory-E`  
工作分支：`feat/reference-state-handoff-mvp`  

---

## 1. 角色与边界

1. **唯一可写仓库**：`Hao-Monster/wp-replica-factory`。
2. **非商城页面开发者**：不碰 `Hao-Monster/reebelo-replica` 及其本地工作目录，不接管 A/B/C/D 权限与服务器。
3. **安全操作边界**：严禁 SSH/SCP/远程 Docker 操作；不访问 reebelo-staging/bingo-dev；无真实生产凭据；不修改生产数据库/支付/真实库存；不自动合并或批准 PR。

---

## 2. 既有模块与能力边界核验

1. **视觉评估器（G2）**：已于 PR #11 合并至 main (`d1a2d6e4567b569dd67e94ec596bc99abf6110c8`)。
2. **下载器 v0.1（Issue #2 / #10）**：已合并至 main。支持 owned-fixture 与 authorized-public 两种模式；具备 challenge 安全分类与防护机制。
3. **PR #12 基线核查**：
   - 分支：`feat/issue-4-remote-staging-core`
   - Head commit：`05cde405acb556b786c707fe49963d2b7d4b890c`
   - 状态：**OPEN**（尚未合并至 main，作为待审核的只读前序成果）。
   - CI 验证记录：
     - Staging core (36263681617, checkout SHA `daddb6f1554822ae9b55c6cc78f17e399a50282b`): 成功通过 14-case 视觉验收（0 差异像素）与清理所有权断言。订单后端确认运行在 legacy 模式。
     - Framework checks (36263681585): 通过。
     - Downloader checks (36263681562): 通过。
     - Visual evaluator (36263681612): 通过。
4. **字体文件差异诊断与保护**：
   - 现象：在 Windows 下克隆后，`git status` 显示 `tests/fixtures/owned-site/assets/FixtureSans-*.ttf` modified。
   - 根因：`.gitattributes` 中 `tests/fixtures/owned-site/** text eol=lf` 规则致使 git 对目录内二进制 .ttf 应用文本换行符转换过滤，产生非实质 diff。
   - 状态：磁盘文件 SHA 与 git blob 和 `RESOURCE_MANIFEST.json` 保持 100% 一致；不得通过改 manifest 强行通过，保护旧工作区。

---

## 3. 本轮增量：显式交互状态完整性与组件资源交接（Issue #13）

### 目标与解决的痛点
- 解决“点击按钮未真正打开弹窗却判定完成”；
- 解决“缺失必须状态却通过缩小集合假通过”；
- 解决“资源有 URL 记录但本地文件缺失或校验不严”；
- 解决“原资源未关联到具体交互组件与状态”。

### 架构与核心实现
- **独立自有测试 Fixture**：位于 `tests/fixtures/state-handoff/`（地区/语言选择器样例：关闭 → 打开 [挂载到 body 的 Portal] → 二级语言列表展开 → 关闭复原）。
- **状态合同引擎**：`tools/downloader/state-handoff.mjs`：
  - 前置条件与动作序列执行
  - 后置断言验证（全局/Portal 选择器、真实可见性、文本/数量断言、路由核验）
  - 状态转移断言（`restores_state`）
  - 组件资源扫描（`currentSrc`/`srcset` 未下载候选、CSS 背景图、inline SVG 摘要）
- **完整性与防伪门禁**：
  - `verifyStateHandoff`：严格检查全部必须状态与双视口证据；逐一核对资源磁盘文件与 SHA256。
  - 阻断篡改：即使修改报告 `status=complete`，只要磁盘文件缺失或哈希不符立即阻断。
- **CI 自动化**：已在 `.github/workflows/downloader-tests.yml` 中接入 `node tests/downloader/state-handoff.mjs`。

---

## 4. 本地复现命令

```bash
# 1. 运行本轮交互完整性与资源交接验收（包含正负例与两次一致性对比）
node tests/downloader/state-handoff.mjs

# 2. 运行 Downloader 单元与公网测试
node --test tests/downloader/unit.test.mjs
node tests/downloader/challenge.mjs
node tests/downloader/public-mvp.mjs

# 3. 运行视觉评估器回归
node tests/visual-evaluator.mjs

# 4. 运行控制层与仓库文件门禁
python -m unittest discover -s tests -v
python scripts/check_repo_files.py
```

---

## 5. 未验证范围

1. PR #12 尚未合并到 main，WooCommerce 远端 staging 流程未纳入当前工作分支基线。
2. 真实商业站点（如 Reebelo 在线环境）未进行实时联网抓取（本轮严格采用自有脱敏独立 fixture）。
3. HPOS（高性能订单存储）及多币种支付网关未在本次增量范围。
