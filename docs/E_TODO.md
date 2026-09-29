# E-DL TODO — 域名下载功能交付清单

> 维护者：Antigravity E（Framework Maintainer）
> 创建：2026-09-29
> 分支：`feat/reference-pipeline-mvp`
> 
> 每项记录实现版本和实际验证结果。
> 写完代码但未运行，记"待验收"；真正操作通过，才改为 [x]。
> 新会话先读此表和对应checkpoint，不依赖聊天记忆。

---

## E-DL-01：单域名入口连接真实任务后端

- **目标**：用户只输入域名，程序自动生成运行配置，连接真实下载后端
- **实现文件**：
  - `tools/dl/cli.mjs` — `start <domain>` / `ui` / `resume` / `status` 命令
  - `tools/dl/crawl-manager.mjs` — `CrawlRun` 类 + `runCrawl()` 编排
  - `tools/dl/ui-server.mjs` — HTTP管理接口 `POST /api/runs`
- **复用**：`tools/downloader/download.mjs`（Playwright采集）、`tools/pipeline/queue.mjs`（Crawlee持久队列）
- **状态**：[ ] 待验收
- **验证方法**：
  ```powershell
  node tools/dl/cli.mjs --help
  node tools/dl/cli.mjs start example.com --max-pages 1
  ```

---

## E-DL-02：自动发现并逐页保存完整HTML

- **目标**：从首页自动发现Sitemap，枚举全站URL，边发现边保存完整渲染后HTML
- **实现文件**：
  - `tools/dl/crawl-manager.mjs`
    - `discoverSitemapUrls()` — robots.txt + 常见sitemap路径
    - `parseSitemap()` — sitemap/sitemap_index 递归解析
    - `extractLinks()` — 渲染后HTML href提取
    - `shouldCrawl()` / `dedupeKey()` — URL过滤与去重
    - `downloadPage()` — 调用现有downloader，保存完整HTML
- **状态**：[ ] 待验收
- **验证方法**：
  ```powershell
  # 启动受控测试站后：
  node tools/dl/cli.mjs start 127.0.0.1:PORT --max-pages 10
  # 验证：多个不同页面HTML各自包含真实内容（非首页副本）
  ```

---

## E-DL-03：真实进度、暂停及重启恢复

- **目标**：显示真实计数，Ctrl+C暂停后重启从断点继续，已保存页面不重抓
- **实现**：
  - `CrawlRun.saveCheckpoint()` — 每页后写 `.crawl-checkpoint.json`
  - `CrawlRun.recordPage()` — 实时写 `crawl-index.json`
  - `runCrawl()` — `_pausing` flag安全停止；resume时读index跳过已保存页
  - Crawlee持久队列 — 重启后待处理任务自动继续
- **状态**：[ ] 待验收
- **验证方法**：
  ```powershell
  # 启动后Ctrl+C暂停，再resume
  node tools/dl/cli.mjs start 127.0.0.1:PORT
  # Ctrl+C
  node tools/dl/cli.mjs resume .replica/dl/<dir>
  # 检查：已保存页面数不变，队列继续消费
  ```

---

## E-DL-04：页面明细、输出索引与隔离查看

- **目标**：`crawl-index.json` 记录每页状态；UI展示明细；已保存HTML可在隔离沙盒中查看
- **实现**：
  - `crawl-index.json` — `{pages: {url: {status, htmlPath, title, savedAt, error}}}`
  - `ui-server.mjs` `GET /api/runs/:id/pages/:captureId` — 沙盒查看（严格CSP，不回源）
  - `tools/dl/ui.html` — 任务列表、进度统计、页面明细表格、查看链接
- **状态**：[ ] 待验收
- **验证方法**：
  ```powershell
  node tools/dl/cli.mjs ui --port 7832
  # 浏览器打开 http://127.0.0.1:7832
  # 点击已保存页面"查看"链接，确认内容与URL对应，非首页副本
  ```

---

## E-DL-05：从用户界面完成实际验收并交付

- **目标**：端到端验收：受控测试站 + Reebelo诊断，UI实际操作录像
- **验收子项**：
  - [ ] 受控测试站：只输入首页URL，自动发现>1页，各页内容不同
  - [ ] 受控站：中途暂停、重启后恢复，成果保留
  - [ ] 受控站：故意让一页失败，其他照常保存，失败原因可见
  - [ ] 受控站：打开保存的首页、列表页、详情页，确认内容各异
  - [ ] Reebelo：实际尝试，返回真实发现/成功/失败/阻塞诊断
- **状态**：[ ] 待验收

---

## 未完成/已知缺口（本轮）

- [ ] **受控测试站扩展**：当前pipeline-site fixture仅3页，需补>50页覆盖sitemap/分页/JS链接场景的测试站
- [ ] **并发支持**：当前为串行（`concurrency: 1`），Playwright多实例并发需要额外内存管理
- [ ] **assetOrigins自动发现**：当前依赖资源采集后回填，首页可能资源不完整
- [ ] **JS渲染发现的链接**：当前从rendered.html提取，已覆盖Playwright渲染后DOM；但SPA路由可能需要追加发现
- [ ] **整站页数验证**：Reebelo因WAF/Challenge受阻时，仅记录诊断，不计入完成
- [ ] **UI实际录像**：需在安装完成后录制

---

## 本轮实际复用的上游模块与版本

| 模块 | 来源 | 版本/commit |
|------|------|-------------|
| `tools/downloader/download.mjs` | 本仓库（已合并） | HEAD `5fdc986` |
| `tools/pipeline/queue.mjs` | 本仓库（已合并） | HEAD `5fdc986` |
| `@crawlee/core` | npm | 3.18.1 |
| `playwright` | npm | 1.55.0 / Chromium 140 |
| `parse5` | npm | 7.3.0 |

---

## Checkpoint

- 分支：`feat/reference-pipeline-mvp`
- HEAD：`5fdc986` (待本轮commit后更新)
- 新文件：
  - `tools/dl/crawl-manager.mjs` — 整站爬取编排
  - `tools/dl/ui-server.mjs` — 本地HTTP管理接口
  - `tools/dl/ui.html` — 管理界面
  - `tools/dl/cli.mjs` — 域名入口CLI
  - `docs/E_TODO.md` — 本文件
