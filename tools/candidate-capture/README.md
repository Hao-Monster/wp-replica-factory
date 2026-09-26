# Candidate capture

Only explicitly authorized owned staging/fixture pages are supported. The
capture policy must contain `authorization: "owned-staging"`, routes must be
same-origin relative paths, and controlled interactions are limited to
`default`, `menu-open`, and `cart-nonempty` using framework-owned
`[data-replica-*]` hooks. Cross-origin requests and redirects are blocked.

State objects may declare an owned action, setup route, expected final path,
and required/forbidden visible selectors. Every case uses a fresh browser
context; its setup action and screenshot share that context. A successful
manifest records the final route, main-document status and redirect chain,
assertion results, viewport, DPR, Chromium version, capture policy SHA, and
available CI source/run identifiers. A failed route or state assertion is
written only under `diagnostics/` and never enters a successful candidate.

```bash
node tools/candidate-capture/cli.mjs capture --policy capture-policy.json --out .replica/candidate
node tools/candidate-capture/cli.mjs handoff --capture-policy capture-policy.json --candidate-out .replica/candidate --baseline approved-baseline --visual-policy visual-policy.json --visual-out .replica/visual
```

The handoff emits `candidate_path`, `candidate_manifest_sha`,
`visual_report_path`, `visual_status`, and `core_report_sha256`.
It never captures, mutates, or approves a reference baseline.
