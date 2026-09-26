# Visual Repair Handoff

G3 core 只产生候选与可信 evaluator 结果，不实现自动视觉修复 AI，也不实现 G4 runner。

数据链：

`Downloader/approved baseline → WordPress staging adapter → Candidate Capture → Visual Evaluator → Site Operator/Antigravity`

Candidate Capture 只接受 `authorization=owned-staging` 的自有 staging/fixture，路由必须同源。
第一版固定支持 default、menu-open、cart-nonempty 三类受控状态，交互只使用
`[data-replica-*]` hook。manifest 的 screenshot 条目包含 page、route、viewport、state、
path、SHA256、width、height、timestamp，并在根对象记录 capture policy SHA256。

`handoff` 输出 machine-readable 的：
`candidate_path`、`candidate_manifest_sha`、`visual_report_path`、
`visual_status`、`core_report_sha256`。Visual Evaluator 的 fail report 已包含 page、
viewport、state、failed regions、different ratio、MAE 与 diff path，供站点操作方定位修改。

本 PR 不新增 baseline 自动批准。Baseline 只能来自已批准的 owned capture，或用户/operator
提供且已授权的 screenshots + manifest；普通 site Agent 仍不能修改 approved baseline。
`baseline-import/baseline-validate` 延后到后续小 PR，避免扩大 G3 core 的可信边界。
