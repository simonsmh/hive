# Workspace UI refresh (review before production)

Baseline: 66fad10. Real registry has **11** modules, not six. Six was the user's visible-tab description, not a reason to remove hidden/existing routes.

Navigation groups (no route renames):
- 行情: 行情 `/quotes`, 市场 `/market`
- 观察: 瞬时趋势 `/ma-deviation`, ETF成交观察 `/etf-volume`, 新闻 `/news`
- 告警: `/alerts`
- 管理: 数据源健康 `/health`, 标的管理 `/symbols`, 条件单 `/orders`, 趋势策略 `/trend`, 设置 `/settings`
- 功能总览 remains `/`, now grouped consistently.

Desktop >=1024px: existing side rail now grouped and independently scrollable. Mobile: sticky module switch, two-column menu, active route label, expanded state, Escape closes; no eleven-item horizontal bottom strip. Shared neutral dark tokens, card/header/empty/error spacing and workspace breadcrumb. No business component or data query changed. Auth checks/middleware and all existing paths/searchParams are untouched. Ctrl/Cmd/Shift/Alt-click retain native links.

## Navigation delay: verified vs unverified

Verified from source before change: dynamic server pages await data before returning; there was no route pending feedback or route error boundary. Quotes has dependent symbols -> quotes -> selected candles reads, news events -> dependent items reads. This is **not** proof that either query is the production bottleneck. No whole-module eager client import was found in navigation (registry is metadata only).

Change: navigation and catalog entry links now use React transitions, keeping the previous module mounted during an unresolved transition, with an immediate explicit pending banner. No route loading boundary replaces the previous data. A failed route has a recoverable error boundary and navigation remains usable. Banner expressly says prior page / not updated. No cache, polling, prefetch-all, database scan or trading semantics changed. This removes silent waiting, not the unmeasured server/database time.

No authenticated production timing was taken: credentials were not entered and production metrics cannot be inferred from a synthetic preview. Browser acceptance must confirm click-to-banner and previous-page retention. Dev first compile is not a navigation-speed metric.

## Isolated preview

`PORT=3108 scripts/preview-dashboard.sh`

Copies only navigation/registry/PanelFrame/CSS and the pure ETF board/model into a temporary Next app; environment uses an allowlist (`env -i`), no dotenv/auth/database/trading modules. Every page displays TEST FIXTURE. `http://127.0.0.1:3108` (listen 0.0.0.0 for tool access).

Acceptance paths:
1. `/` desktop 1440x900: four groups, all 11 links, current-page highlight, independently scrollable rail at short heights.
2. 390x844 and 768px: module menu opens/closes, Escape closes, no horizontal tab scroll, all entries reachable, current module visible after selection.
3. `/etf-volume`: actual board with explicit synthetic data; expanded rows and methodology; responsive no-overlap checks.
4. `/quotes?symbol=TEST`: query shown by the **preview fixture**, click other modules and back; real production query parsing is unchanged.
5. `/health?state=error`: shared ErrorState; `/orders`: shared EmptyState. Sensitive business controls deliberately absent from the fixture.
6. From ETF, click 新闻: intentional 1500ms server delay, verify pending appears promptly and previous ETF remains visible until completion; warning disappears afterward. Warm curl news observed ~1.568s (synthetic delay), ETF ~0.100s; these are smoke checks, NOT before/after production speed claims. Parent should measure actual click-to-pending in browser; no fabricated timing.

Not covered by this preview: authenticated data arrival speed, live SSE, native notification permission, production business forms and sensitive order/strategy actions. Existing unit tests/build cover compilation but do not replace that integration coverage.

No push/deploy before parent browser approval. Rollback: revert UI commit, no migration or persistent state rollback needed.
