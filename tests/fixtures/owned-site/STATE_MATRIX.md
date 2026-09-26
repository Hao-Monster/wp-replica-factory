# Fixture site contract

| page_id | route | states |
|---|---|---|
| grid | `/grid.html` | four products in fixed order; desktop four columns; mobile two columns |
| lazy | `/lazy.html` | waiting, then loaded after scroll with background and SVG mark |
| filters | `/filters.html` | menu closed/open; all, home, no-match, clear |

Viewport settings are versioned in `scripts/fixture_site.py`: desktop 1440x1000 and mobile 390x844, DPR 1, `en-US`, UTC. Browser state summaries include product IDs/order, filter counts, lazy state and external request list. Runtime timestamps and paths are excluded from normalized summaries.
