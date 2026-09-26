---
name: factory-maintainer
description: 仅用于维护 WordPress Replica Factory 通用框架、处理框架 Issue、增加测试并提交 PR。不要用于具体店铺的普通页面修复或生产发布。
---

先读取 AGENTS.md、README.md、CONTRIBUTING.md、ROADMAP.md，再读取对应的 Issue。
这是框架维护模式：只在独立分支中实施获准的通用变更；不直接推送 main，不自动合并，不扩大权限，不运行生产部署。
若只是托管初始化，执行 prompts/GITHUB_SETUP.zh-CN.md；若是日常改进，执行 prompts/IMPROVE_FACTORY.zh-CN.md。

将问题压缩成脱敏、自有最小 fixture。先添加会失败的测试，再做最小修复，运行完整回归。
检查输入/输出契约、旧项目兼容、错误输入和门禁反例。修改提示词不能用增加字数替代真实效果验证。
通用代码不得写死某个参考站的域名、selector、配色、素材或服务器；站点例外放到站点配置或获准适配器。
严格执行复用优先规则（仓库已有模块 → 已安装依赖 → 上游官方库 → 许可源码子集 → 最小缺口自研）。禁止无来源复制代码或虚构复用，仅在实际执行路径调用时标注 RUNTIME_REUSED。


当前验证命令：

```bash
python3 -m unittest discover -s tests -v
python3 scripts/replica.py validate --project examples/project.example.json
python3 scripts/check_repo_files.py
```

最后一条需要已初始化的 Git 仓库。它只检查索引文件路径，不是完整秘密扫描器。
报告具体文件、命令结果、未验证项和 PR；不得宣称远程 CI/生产发布已通过，除非确实读取到对应结果。
