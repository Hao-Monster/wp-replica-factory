# Owned fixture site

This directory contains self-authored, local-only pages for repeatable browser tests. It is not a store, does not connect to WordPress, and contains no external assets.

- `data/products.json`: fixed IDs, SKUs, categories and prices.
- `assets/*.svg`: self-authored product and lazy background art.
- `assets/FixtureSans-*.ttf`: Inter, downloaded from Google Fonts, licensed under SIL Open Font License 1.1; canonical hashes are pinned in the versioned `RESOURCE_MANIFEST.json`.
- Pages: `/grid.html`, `/lazy.html`, `/filters.html`.

Run lifecycle commands from the repository root:

```powershell
py -3 -X utf8 scripts/fixture_site.py seed
py -3 -X utf8 scripts/fixture_site.py serve --port 8765
py -3 -X utf8 scripts/fixture_site.py health --url http://127.0.0.1:8765
py -3 -X utf8 scripts/fixture_site.py reset
py -3 -X utf8 scripts/fixture_site.py test
```

`serve` binds only to `127.0.0.1`; use Ctrl+C to stop it. `test` starts and cleans its own temporary server and two fresh browser contexts. Runtime state is under ignored `.replica/owned-site`; source fixture files are never rewritten by seed/reset.
