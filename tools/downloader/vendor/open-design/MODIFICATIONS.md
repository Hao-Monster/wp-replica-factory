# Pinned OpenDesign subset

Source: `nexu-io/open-design@1b47e60bd46641469fcd8b69c496c4e3a548bc28`.
The directory-specific `skills/web-clone/LICENSE` is MIT, copyright 2026 Jane
(@xiaoerzhan / 小耳). Its original license and the repository root Apache-2.0
license are retained. No NOTICE was present in the inspected scope. Original
reviewed file SHA-256 values are in `UPSTREAM.json`.

This is selective source reuse, not the OpenDesign desktop application:

| Source | Executed reuse | Adaptation |
| --- | --- | --- |
| route-crawl.mjs | collectPage: runtime anchors, headings, metadata | Extracted importable function. Framework owns BFS/frontier budgets, does not sort query parameters or remove trailing slash. |
| recon-site.mjs | collectSignals: layout, computed styles, fonts, CSS rules, image and framework signals | Extracted importable function. Framework adds src/currentSrc separation, decode and font statuses, dynamic CSS and viewport/state provenance. |
| asset-harvest.mjs | classify: resource kind classification | No unrestricted supplementary GET, recon-only download, separate asset engine or regex-only CSS rewriting. |
| mirror-site.mjs | browser scroll/request-observation sequence | Exported bounded scroll function; dynamic height and deadline. Removed second GET pass, query-dropping paths, launcher and standalone CLI. |
| network-capture.mjs | response listener and actual response.body() acquisition | All allowed GET asset types; exact JSON allowlist enforced outside listener. No persisted request headers/cookies/postData. Pending bodies drained before closing context. |

The inspected `lib/playwright-loader.mjs` and `lib/system-browser.mjs` are NOT
integrated. They select system browsers/daemon CDP fallbacks; this adapter uses
only locked Playwright 1.55.0 with project-managed Chromium build 1187, in fresh
contexts. No daily profile, Electron, Puppeteer or second mirror engine.

`references/static-mirror.md` informed the raw HTML + original client bundle
delivery decision. It is not an executable module. Its permissive external
hotlink examples and machine-specific commands are not used.

HAR is genuine Playwright `recordHar` (`full`, `embed`), not the upstream custom
network JSON renamed. Framework modules separately implement path ownership,
content hashes, exact-origin owned-fixture proxy, parsing-based localization,
virtual original-path serving, strict verification, and offline browser checks.

Raw captured bytes remain immutable. Localized CSS uses PostCSS with
postcss-safe-parser recovery when browser-tolerated malformed CSS exists; each
recovery is reported. No fixture source is rewritten to accommodate the adapter.
