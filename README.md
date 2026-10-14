# Hive

Hive 是一个共享的市场数据服务：由 Supabase 上的 **Edge Function + pg_cron** 每 30 秒轮询交易所公开行情，统一写入 Supabase Postgres，再由 Vercel 上的只读 API 供各个交易/新闻 AI Agent 调用。Agent 不再各自轮询交易所。

> **采集已迁移到 Supabase 免费额度内的 Edge Function**（`supabase/functions/okx-collector`），不再需要付费的 Railway 常驻 Worker。`apps/worker` 保留为**可选 / 遗留**实现，默认不再部署。两者不要同时运行，见下文。

当前为 **阶段 2**：OKX 行情采集、Yahoo Finance 行情采集（部署后启用，见「部署 > Yahoo 行情」）、Jin10 快讯轮询、OKX Orbit 重要快讯轮询、数据源过期告警（含恢复）、webhook 推送（HMAC 签名、退避重试、投递记录）、仪表盘与管理 API。X（Twitter）不接入，见「范围说明」。

## 架构

```
            OKX public REST (无密钥)
                    ▲  每 30 秒 · 11 个符号 × 5 个请求 · 最多 4 个并发
                    │
 ┌─────────────────────────────────────┐  PostgREST (service role)  ┌────────────────────────────────┐
 │ Supabase Edge Function              │───────────────────────────▶│ Supabase (Tokyo, PG 17)        │
 │ supabase/functions/okx-collector    │                            │  candles / quotes_latest       │
 │ - 租约 collector_state 防止重叠     │                            │  source_health / symbol_map    │
 │ - 与 packages/core 共享的采集循环   │                            │  alerts / deliveries (pgmq)    │
 └─────────────────────────────────────┘                            │  collector_state               │
                    ▲                                               │  vault: 采集 URL / 密钥 / webhook│
                    │ pg_net POST (Bearer, 密钥来自 Vault)           │  pg_cron: 采集 / 健康检查 / 保留│
                    └───────────── pg_cron '30 seconds' ────────────│                                │
                                                                    └───────────────┬────────────────┘
 ┌──────────────────────────────┐                                                   │ service role
 │ Vercel (Hobby)               │───────────────────────────────────────────────────┘
 │ apps/web  Next.js routes     │
 │ /api/quote /api/candles      │◀──── Bearer HIVE_API_TOKEN ──── AI Agents
 │ /api/atr   /api/health       │
 └──────────────────────────────┘
```

要点：

- **采集（supabase/functions/okx-collector）**：pg_cron 每 30 秒调用 `hive_okx_collector_tick()`，该函数从 Vault 读取函数地址与密钥，通过 pg_net 发送 POST。Edge Function 校验 Bearer 密钥后：
  - 先获取 `collector_state` 中的租约；若上一次运行仍持有租约，或处于限流退避期，则本次跳过，避免重叠。
  - 从 `symbol_map` 读取所有启用的符号（缺少 OKX 合约 ID 的会自动解析并写回）。
  - 以最多 4 个并发轮询每个符号的报价与 1m/5m/15m/1Dutc K 线。60 秒预算用尽后不再发起新请求，整次运行远低于 150 秒的墙钟上限。
  - 遇到 OKX 限流（403/429）时，本次运行记为 `rate_limited` 并退避 5 分钟。
  - 无论成功或失败，都会在 `finally` 中释放租约。
- **健康语义**（与 Worker 一致，实现位于 `packages/core/src/collector.ts`）：每个 OKX 请求与每次数据库写入单独处理，单点失败只计数、记日志，本周期继续。每个周期结束时更新一次 `source_health.okx`：至少一行写入成功则记为成功；没有写入成功且出现过错误，则记为失败并记录最后一个错误。
- **Worker（apps/worker，可选 / 遗留）**：部署在 Railway，使用 `pg_try_advisory_lock` 竞争领导权。它与 Edge Function 共享同一套采集逻辑和表，但使用的是另一套锁，**不要同时运行**。
- **数据库（supabase/）**：所有表开启 RLS，匿名与 `authenticated` 角色没有任何直接表权限，读取只能通过 Vercel API（service role）。写入采集数据的 `hive_collector_*` 函数同样只允许 service role 执行。
- **健康检查与告警**：pg_cron 每分钟执行 `hive_run_health_check()`。已启用且超过 `max_staleness_minutes` 未成功的数据源写入一条未恢复的 `source_stale` 告警，同一数据源同时只保留一条未恢复告警。数据源恢复后，该告警写入 `resolved_at` 并新增一条 `source_recovered` 事件。
- **新闻采集（supabase/functions/jin10-poller）**：pg_cron 每 30 秒调用一次。函数请求 Jin10 快讯接口，经 `hive_news_ingest` 按 `source + external_id` 去重写入 `news_items` 与 `news_events`，并更新 `source_health.jin10`。本轮询若插入了新快讯，`hive_news_ingest` 会在事务提交后通过 pg_net 唤醒一次分发函数（见下文「延迟」）。该接口是非官方接口，格式变化或被拦截时记录错误，数据源会因超过 5 分钟未成功而进入过期告警。
- **webhook 推送（supabase/functions/webhook-dispatcher）**：`news_items` 与 `alerts` 插入时，触发器按每个订阅的 `filters` 预先过滤，只为命中的订阅写入 `webhook_deliveries`，未命中的订阅不会被唤醒。分发函数由 pg_cron 每 30 秒调用一次作为兜底，并在新快讯入库后被唤醒。每次运行按 `next_attempt_at` 取出到期投递，只要剩余预算足够就持续领取整批，使用 HMAC-SHA256 签名后 POST 给订阅方。失败按 30 秒起的指数退避重试（上限 1 小时），最多 6 次，之后标记为 `dead`。
- **OKX 快讯（supabase/functions/okx-news-poller）**：pg_cron 每分钟调用一次。函数请求 OKX Orbit 快讯搜索接口 `GET /api/v5/orbit/news-search?importance=high`，需要只读 OKX API Key 签名（见下文「范围说明」），经 `hive_news_ingest` 按 `source + external_id`（`okx-news:<id>`）去重写入 `news_items`，`source` 为 `okx-news`，并更新 `source_health.okx-news`。与 Jin10 相同，本轮询若插入了新快讯，同样会唤醒分发函数（见「延迟」）。查询窗口的起点是已入库的最新 `published_at` 向前回溯 10 分钟，窗口最早不早于 2 小时前；每页 50 条，最多 10 页，按 `end = 最早 cTime - 1` 向前翻页。任一页失败时本轮整体不写入，下一轮从同一位置重试。数据源超过 5 分钟未成功即产生 `source_stale` 告警。
- **告警规则评估（supabase/functions/alert-evaluator）**：pg_cron 每分钟调用一次。函数读取启用中的 `alert_rules`，从 `candles` 取各符号已确认的 K 线，用 `packages/core/src/alerts.ts` 评估规则（价格穿越、K 线收盘突破、放量、长影线、回调、区间涨跌幅 `pct_move`），匹配的结果写入 `alerts`。它不直接调用 webhook：`alerts` 插入后由既有触发器 `alerts_fanout` 写入 `webhook_deliveries`，再由 webhook-dispatcher 投递。冷却时间由 `cooldown_seconds` 控制；同一根 K 线对同一规则只写入一次（`dedup_key = rule:<id>:<bar_ts>`）。规则见下文「告警规则」。
- **Yahoo 行情（supabase/functions/yahoo-collector）**：pg_cron 每 2 分钟调用一次（`hive-yahoo-collector`，每天 720 次）。函数读取 `symbol_map` 中 `enabled = true` 且 `yahoo_symbol` 非空的符号，请求 Yahoo 公开图表接口 `/v8/finance/chart/{yahoo_symbol}`，无需密钥。每个符号每次运行发起一次 `interval=1m&range=1d&includePrePost=true` 请求，同时得到最新报价（最新 1m 收盘价）与最近 60 根 1m K 线；日线（`interval=1d&range=3mo`）每个符号每小时至多请求一次。数据经 `hive_collector_*` 写入，`source = 'yahoo'`。租约使用 `collector_state` 中的 `yahoo` 行，与 OKX 互不影响。遇到 429 或 403 时本次运行不再发起新请求，并退避 10 分钟。`source_health.yahoo` 默认禁用，见「部署 > Yahoo 行情」。
- **同花顺行情（supabase/functions/ths-collector，可选）**：pg_cron 每 2 分钟调用一次，只在北京时间工作日 09:15–15:15 请求上游。指数与个股报价写入 `quotes_latest`（`source = 'ths'`），涨跌停池、热门股、龙虎榜、竞价、涨跌家数等写入 `daily_snapshot`。默认关闭，部署步骤与调用预算见下文「部署 > ths 行情」。
- **保留（hive_run_retention）**：每天 UTC 03:17 清理历史数据，使数据库保持在 500MB 以内，见下文「数据约定」。
- **API（apps/web）**：Next.js Route Handlers，部署到 Vercel。没有配置任何 Vercel Cron（Hobby 计划仅支持每日一次），所有分钟级调度都在 pg_cron 中。

## 延迟（Jin10 快讯 → webhook）

以下为设计估算，尚未在生产环境测量。上线后用文末的查询确认。

| 环节 | 机制 | 典型 | 最坏 |
| --- | --- | --- | --- |
| 轮询等待 | pg_cron 每 30 秒调用 `jin10-poller` | 约 15 秒 | 30 秒 |
| 入库与过滤 | `hive_news_ingest` 单事务写入快讯，触发器同时写入 `webhook_deliveries` | 小于 1 秒 | - |
| 分发唤醒 | 事务提交后由 pg_net 排队调用 `webhook-dispatcher`。本轮询无新快讯时不唤醒 | 约 1–2 秒 | - |
| 兜底 cron | `hive-webhook-dispatch` 每 30 秒，覆盖唤醒失败与重试退避 | - | 30 秒 |
| 签名与投递 | HMAC 签名后 POST，单次请求超时 8 秒 | 取决于接收方 | 8 秒 |

- **无积压时**：快讯到 webhook 送达典型约 15–20 秒，最坏约 35 秒加接收方响应时间。以上不含 Jin10 自身发布到接口可见的延迟。
- **改造前**：轮询 0–30 秒加分发 cron 0–60 秒，最坏约 90 秒，平均约 45 秒。分发每分钟只领取 20 条，突发时积压需要数分钟才能排空，这可能是观察到的 2–4 分钟尾部延迟。请用下方查询在生产确认。
- **积压**：每次运行循环领取整批（每批 20 条，4 并发）。只有剩余预算（90 秒）能覆盖最坏一批（约 40 秒）时才继续领取，因此不会留下未处理且被租约锁住的投递。
- **重试**：失败后按 30 秒起的指数退避，兜底 cron 的 30 秒粒度不会额外拉长重试。
- **不调整的部分**：轮询仍为 30 秒，避免把非官方 Jin10 接口的请求频率翻倍。
- **免费额度**：Supabase 免费版每月 50 万次 Edge Function 调用。按计划调度的调用合计每天 12,240 次（OKX 采集 2,880、Jin10 轮询 2,880、分发兜底 2,880、OKX 快讯 1,440、告警评估 1,440、Yahoo 行情 720），约 36.7 万次/月。分发唤醒最多每天再加 2,880 次（约 8.6 万次/月），上限约 45.4 万次/月，仍低于 50 万次。新增 Edge Function 或提高调度频率前请重新计算。

生产环境观测最近一天的快讯送达延迟（`published_at` 为 Jin10 快讯时间，`delivered_at` 为首次成功投递时间）：

```sql
select count(*) as delivered,
       round(avg(extract(epoch from delivered_at - (payload->>'published_at')::timestamptz))::numeric, 1) as avg_seconds,
       round(max(extract(epoch from delivered_at - (payload->>'published_at')::timestamptz))::numeric, 1) as max_seconds
  from public.webhook_deliveries
 where event_type = 'news' and status = 'delivered' and delivered_at > now() - interval '1 day';
```

## 推送优先级与陈旧标记（webhook 卫生）

`webhook_deliveries` 按事件分为两档，见 `supabase/migrations/20261014000001_webhook_priority.sql`（`hive_delivery_policy` 为唯一来源）：

- **critical**：全部快讯，以及 `fill`、`near_sl`、`position`、`order_state`、`premium_pulse`、`candle_close_break`（突破）、`price_cross` 告警。领取时优先，永不丢弃。
- **bulk**：其余告警（如 `volume_spike`、`pct_move` 与 5m 扫描类）。在预算紧张时延后到下一轮。超过 `expires_at`（入库后 15 分钟）仍未送达的，标记为 `expired` 且不再发送。

每条投递的 `data` 中都带有以下字段，由分发函数在发送时计算（`packages/core/src/webhook.ts` 的 `deliveryFlags`），生产者无法覆盖：

| 字段 | 含义 |
| --- | --- |
| `priority` | `critical` 或 `bulk` |
| `event_ts` | 事件时间（告警为 `event_ts` 或入库时间，快讯为 `published_at`），可知时才有 |
| `stale` | 事件时间距发送超过阈值：`fill` 60 秒，其他关键告警 120 秒，快讯与 bulk 300 秒 |
| `replay` | 从入库到发送超过 30 秒（积压重放、cron 兜底或重试后的投递） |

**接收方约定**：`stale` 或 `replay` 为 `true` 时，不得下单或改单，只可记账。同一 `delivery_id` 可能因重试而重复收到，请按 `delivery_id` 去重。

关键告警（`alerts` 插入且命中 critical 订阅）在同一事务内只触发一次分发函数（`hive_invoke_edge_function`），不必等待 30 秒的 cron。cron 仍是兜底。分发函数超过预算时，尚未发送的投递通过 `hive_webhook_release` 退回待发送状态，并返还本次领取计入的尝试次数。

部署顺序：先执行迁移，再部署 `webhook-dispatcher`（新分发函数依赖 `hive_webhook_release` 与新的领取返回列）。无需新增订阅行，除非要把关键事件单独发往一个 URL：此时新建订阅并用 `alert_kinds` 过滤即可。

## 目录

```
apps/
  web/        Vercel 上的读取 API 与仪表盘（Next.js App Router）
  worker/     可选 / 遗留：Railway 上的 OKX 轮询 Worker（Dockerfile、railway.json）
packages/
  core/       共享逻辑：OKX 客户端、采集循环 (collector.ts)、K 线解析、ATR、鉴权、告警规则校验与评估
supabase/
  config.toml 最小化的 Supabase CLI 配置（声明各 Edge Function 不校验 JWT）
  functions/okx-collector/     Edge Function（Deno）：OKX 行情采集
  functions/jin10-poller/      Edge Function（Deno）：Jin10 快讯轮询与入库
  functions/okx-news-poller/   Edge Function（Deno）：OKX Orbit 重要快讯轮询与入库
  functions/webhook-dispatcher/ Edge Function（Deno）：webhook 签名、投递与退避
  functions/alert-evaluator/   Edge Function（Deno）：告警规则评估，写入 alerts
  functions/yahoo-collector/   Edge Function（Deno）：Yahoo Finance 行情采集（source = yahoo）
  functions/ths-collector/     Edge Function（Deno）：同花顺（HiThink）行情、盘口池与交易日历
    core/     由 scripts/sync-edge-core.mjs 从 packages/core 生成的副本，请勿手改（每个函数各一份）
  migrations/ 按文件名顺序执行的 SQL 迁移（01–10 为阶段 1，11–23 为阶段 2）
  tests/      verify.sql：迁移后的 schema 与采集路径冒烟测试（事务内执行并回滚）
scripts/
  apply-migrations.sh  依次应用迁移
  sync-edge-core.mjs   生成 Edge Function 的 core/ 副本；--check 用于 CI 校验是否过期
.github/workflows/ci.yml
```

## 环境变量

本地运行时，把变量写入 `apps/web/.env.local`（Next.js 只读取应用目录内的 `.env*` 文件，`.env.example` 列出了全部变量）；部署时在 Vercel 控制台中配置。**不要把真实密钥提交到仓库。**

| 变量 | used by | 说明 |
| --- | --- | --- |
| `SUPABASE_URL` | web | Supabase 项目地址，形如 `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | web | service role key，仅服务端使用 |
| `HIVE_API_TOKEN` | web | Agent 使用的 Bearer 令牌。未配置时 API 返回 500（fail closed）。生成：`openssl rand -hex 32` |
| `HIVE_DASHBOARD_PASSWORD` | web | 仪表盘登录密码，仅服务端读取。未配置时无法登录（fail closed）。见「仪表盘与访问密码」 |
| `HIVE_SESSION_SECRET` | web | 仪表盘会话 Cookie 的 HMAC 密钥，至少 32 个字符。未配置或过短时无法登录。生成：`openssl rand -hex 32` |
| `COLLECTOR_SECRET` | okx-collector（Edge secret） | pg_net 调用函数时使用的 Bearer 密钥。**必须与 Vault 中的 `okx_collector_secret` 相同**。通过 `supabase secrets set` 设置，见下文 |
| `EDGE_CRON_SECRET` | jin10-poller、okx-news-poller、webhook-dispatcher、alert-evaluator、yahoo-collector、ths-collector（Edge secret） | pg_net 调用这些函数时使用的 Bearer 密钥。**必须与 Vault 中的 `edge_cron_secret` 相同**。未配置时这些函数都拒绝请求 |
| `JIN10_FLASH_URL`、`JIN10_APP_ID`、`JIN10_VERSION`、`JIN10_REFERER`、`JIN10_QUERY` | jin10-poller（Edge secret，可选） | 覆盖 Jin10 快讯接口的地址、请求头与查询参数。默认值见 `supabase/functions/jin10-poller/handler.ts` 中的 `DEFAULT_JIN10_CONFIG`。上游改版时可直接覆盖，无需重新发版 |
| `OKX_BASE_URL` | okx-collector、okx-news-poller（Edge secret，可选） | 默认 `https://www.okx.com` |
| `YAHOO_BASE_URL` | yahoo-collector（Edge secret，可选） | 默认 `https://query1.finance.yahoo.com`。仅在需要切换上游地址时设置 |
| `OKX_API_KEY`、`OKX_API_SECRET`、`OKX_API_PASSPHRASE` | okx-news-poller（Edge secret） | 只读 OKX API Key 的三项凭据，用于签名快讯请求。**必须三者同时设置**，否则不签名。只会在 okx-news-poller 中读取，不要提交到仓库 |
| `HITHINK_FINANCE_API_KEY` | ths-collector（Edge secret） | 同花顺（HiThink）REST 的 API Key，以请求头 `X-api-key` 发送。未配置时函数返回 500。只在 Edge secret 中设置，不要提交到仓库 |
| `THS_BASE_URL` | ths-collector（Edge secret，可选） | 默认 `https://fuyao.aicubes.cn` |
| `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` | okx-collector | Supabase 自动注入到 Edge Function，无需手动设置 |
| `SUPABASE_DB_URL` | worker（可选 / 遗留） | 直连 Postgres 的连接串。**必须使用 Session pooler（5432）或直连**，不能用 Transaction pooler（6543），因为 Worker 依赖会话级 advisory lock |
| `SUPABASE_DB_CA_CERT` | worker（可选 / 遗留） | 可选。数据库端点的 PEM 证书，配置后启用证书校验；未配置时接受未校验的 TLS 连接 |
| `HIVE_SYMBOLS` | worker（可选 / 遗留） | 可选。逗号分隔的基础符号，默认 `BZ,SNDK,MU,META,NVDA,QQQ,MRNA,TSM,XAU,BTC,ETH`。Edge Function 不读取此变量，符号以 `symbol_map` 为准 |
| `HIVE_POLL_INTERVAL_SECONDS` | worker（可选 / 遗留） | 可选。轮询间隔，5–300 秒，默认 15 |
| `DATABASE_URL` | 迁移脚本 | 用于 `scripts/apply-migrations.sh` 和 `verify.sql` 的数据库连接串 |

### Vault 密钥（采集调度）

pg_cron 的任务本身不保存任何密钥。每次触发时，`hive_okx_collector_tick()` 从 Supabase Vault 读取以下两个密钥：

| Vault 名称 | 内容 |
| --- | --- |
| `okx_collector_url` | Edge Function 地址，`https://<project-ref>.supabase.co/functions/v1/okx-collector` |
| `okx_collector_secret` | Bearer 密钥，与 Edge secret `COLLECTOR_SECRET` 完全相同 |

两者缺一时，每次 tick 只会在数据库日志中打印一条警告，并不发送请求。

### Vault 密钥（新闻与推送调度）

`hive_invoke_edge_function(name)` 被 `hive-jin10-poller`、`hive-webhook-dispatch`、`hive-alert-evaluator`、`hive-yahoo-collector` 等 pg_cron 任务共用。它从 Vault 读取以下两个密钥，cron 任务本身不保存任何密钥。

| Vault 名称 | 内容 |
| --- | --- |
| `edge_base_url` | Edge Functions 根地址，`https://<project-ref>.supabase.co/functions/v1`（不带函数名） |
| `edge_cron_secret` | Bearer 密钥，与 Edge secret `EDGE_CRON_SECRET` 完全相同 |

缺少任一项时只打印警告，不发送请求。webhook 的签名密钥同样存放在 Vault 中（名称形如 `webhook_sub:<id>:<uuid>`），`webhook_subscriptions` 表只保存引用，API 也不会返回密钥本身。

### 符号解析

- 启用的符号来自 `symbol_map`（`enabled = true`）。`ETH`、`BTC` 等默认符号已由迁移写入。
- 要新增符号，直接插入即可，下一次运行就会采集：`insert into public.symbol_map (symbol, enabled) values ('XYZ', true);`
- 若 `okx_inst_id` 为空，函数会拉取 OKX 公开接口 `/api/v5/public/instruments?instType=SWAP`，选取处于 `live` 状态的 `<SYMBOL>-USDT-SWAP`（找不到时回退 `-USD-SWAP`），并写回 `symbol_map`。实例列表在内存中缓存 15 分钟。
- 例如 `BTC-USDT-SWAP`、`XAU-USDT-SWAP`、`ETH-USDT-SWAP`。

### Yahoo 代码映射（yahoo_symbol）

- `symbol_map.yahoo_symbol` 决定 yahoo-collector 请求哪个 Yahoo 代码。为空的符号不采集 Yahoo 行情，只走 OKX。
- 现有映射：`BZ` → `BZ=F`（布伦特原油期货）、`XAU` → `XAUUSD=X`、`BTC` → `BTC-USD`、`ETH` → `ETH-USD`；股票与 ETF 使用同名代码，如 `NVDA`、`MU`、`QQQ`。
- **`SKHY` 保持为空**，仅 OKX。没有经过核实的 Yahoo 代码时不要填写，猜测的代码会采集到错误的标的。
- 只接受 `[A-Za-z0-9.^=-]` 且不超过 24 个字符的代码，不合规的代码会被跳过并记录日志，其他符号照常采集。
- 新增 Yahoo 行情（符号已在 `symbol_map` 中且启用）：`update public.symbol_map set yahoo_symbol = 'XYZ' where symbol = 'XYZ';`，下一次运行即生效。

## 数据约定

- **日线使用 `1Dutc`**：OKX 的 `1D` 以 UTC+8 的 00:00 为一根 K 线的开盘（即 UTC 16:00）。采集请求的是 `1Dutc`（UTC 00:00），存储时 `interval = '1D'`。这样日期与星期判断都以 UTC 为准。
- **XAU 的 ATR 只使用工作日**：计算前剔除 UTC 星期六和星期日的日线。其他符号不做剔除。
- **ATR 只使用已确认的日线**（`confirmed = true`），正在形成的当日 K 线不参与计算。
- **Wilder ATR**：前 `period` 个真实波幅的简单平均作为初值，之后按 `(ATR·(n−1)+TR)/n` 平滑。
- `candles.confirmed` 对应 OKX 的 `confirm` 字段，`1` 表示已收盘。
- `quotes_latest` 每个 `(symbol, source)` 只保留最新一条。写入时只接受时间戳不早于已有记录的报价。
- `v_spread` 视图：`yahoo`（现货/标的参考价）与 `okx`（永续）同一符号的报价差与百分比。只有两个来源在 `quotes_latest` 中都有该符号的报价时才会出现一行，因此启用 yahoo-collector 后生效（见「部署 > Yahoo 行情」）。
- **保留策略（`hive_run_retention`，每天 UTC 03:17）**：
  - 删除 30 天前的 `1m`、`5m`、`15m`、`1H` K 线。**`1D` 日线永久保留**。
  - 删除 30 天前的 `alerts`（级联删除其 `deliveries`），并删除 30 天前已投递或已死信的 `deliveries`。
  - 清理 pgmq `hive_deliveries` 中 30 天前的消息与归档。
  - pg_cron 运行历史与 pg_net 响应只保留 7 天，否则每 30 秒一次的任务会持续膨胀。
  - 容量估算：11 个符号 × 1m 每天 1440 根 × 30 天约 47 万行，加上 5m、15m 与日线后远低于 500MB。实际占用可用 `select pg_size_pretty(pg_database_size(current_database()));` 查看。

## 应用迁移

迁移需要 Supabase 兼容的 Postgres（包含 `pg_cron`、`pg_net`、`pgmq`、`supabase_vault`）。普通 Postgres 不满足要求。

迁移会依次启用以下扩展，并在空的 `public` schema 上创建全部表与函数：

- `pg_cron`、`pg_net`、`pgmq`、`supabase_vault`

迁移不会写入任何密钥。Vault 密钥需要在部署后手动创建，见下文。

### 方式一：Supabase 项目

使用 `psql` 连接 Session pooler 后执行：

```bash
export DATABASE_URL='postgresql://postgres.<project-ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'
bash scripts/apply-migrations.sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/verify.sql
```

### 方式二：本地 Docker（与 CI 相同的镜像）

```bash
docker run -d --name hive-pg -e POSTGRES_PASSWORD=postgres -p 54322:5432 supabase/postgres:17.6.1.066
export DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
bash scripts/apply-migrations.sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/verify.sql
```

`verify.sql` 在事务内检查：所有表都开启了 RLS；匿名角色没有表权限；pgmq 队列与 pg_cron 任务已存在；webhook 密钥写入 Vault 且可解密；健康检查同一 15 分钟窗口内幂等；`candles` 与 `alerts` 的唯一约束生效；`v_spread` 可以计算价差。

采集相关的检查同样在事务内完成：`hive_collector_*` 函数只允许 service role 执行；租约互斥且在退避期内拒绝运行；报价只接受不更旧的时间戳；K 线按主键幂等写入；保留任务删除 30 天前的分钟线但保留日线；`hive-okx-collector`（30 秒）与 `hive-retention` 任务已注册；未配置 Vault 时采集 tick 为空操作，配置后会排入一条 pg_net 请求。验证中使用的测试符号为 `VERIFY`，脚本最后回滚，不会留下数据。Yahoo 相关检查包括：`hive-yahoo-collector`（每 2 分钟）已注册；租约按来源独立；`source = 'yahoo'` 的报价与日线写入；`yahoo_symbol` 映射正确，SKHY 保持为空。
ths 行情的检查同样在事务内完成：`symbol_map` 的 ths 种子与约束、`source_health` 的会话门控标记、交易时段判断、`daily_snapshot` 的写入与 `ths_` 前缀限制、清理函数、租约，以及 `hive-ths-collector` 与 `hive-ths-prune` 两个调度。

## 本地开发

需要 Node 22（见 `.nvmrc`）和 pnpm 10。Edge Function 的测试需要 [Deno](https://deno.com) 2.x。

```bash
pnpm install --frozen-lockfile
pnpm build         # core -> web (next build) -> worker；apps 依赖 core 的 dist，必须先构建
pnpm lint          # eslint
pnpm typecheck     # tsc（core / web / worker）
pnpm test          # vitest（core / worker / web）
pnpm sync:edge-core  # 修改 packages/core 中的采集相关模块后必须运行，生成 Edge Function 的 core/ 副本

for f in okx-collector jin10-poller okx-news-poller webhook-dispatcher alert-evaluator yahoo-collector ths-collector; do
  (cd supabase/functions/$f && deno lint && deno check index.ts handler.ts store.ts *.test.ts && deno test)
done
```

`pnpm sync:edge-core --check`（即 `node scripts/sync-edge-core.mjs --check`）会在副本过期时失败，CI 中也会执行此检查。

## 部署

### Supabase（采集、新闻与推送）

1. 在 Tokyo（ap-northeast-1）创建项目，Postgres 17，使用免费计划。记录 `<project-ref>`。
2. 应用迁移（`scripts/apply-migrations.sh`，按文件名顺序）。全新项目执行全部迁移；已部署阶段 1 的项目需执行 `20261013000011` 之后的迁移；已部署到 `…000021` 的项目只需执行 `…000022_yahoo_collector.sql`。各迁移的内容如下：
   - `…000011_news_source_enum.sql`：为 `market_source` 增加 `jin10`
   - `…000012_news_ingest.sql`：`news_items.author`、`source_health.jin10` 种子、`hive_news_ingest` 写入函数
   - `…000013_webhook_subscriptions.sql`：`alerts.severity` / `resolved_at`，`webhook_subscriptions`、`webhook_deliveries`，预过滤触发器与分发/管理函数
   - `…000014_health_alerts.sql`：健康检查的开启/恢复语义，改为每分钟执行
   - `…000015_edge_news_cron.sql`：`hive_invoke_edge_function`，`hive-jin10-poller`（30 秒）、`hive-webhook-dispatch`（原为每分钟）、`hive-news-prune`（每天 03:27 UTC）
   - `…000017_news_dispatch_kick.sql`：新快讯入库后唤醒分发函数；`hive-webhook-dispatch` 改为每 30 秒（见下文「延迟」）。仅替换函数与调度，不修改数据
   - `…000016_webhook_auth_token.sql`：订阅可选的 Bearer 令牌（`auth_token_secret_id`，存于 Vault）；`sources` 过滤只作用于新闻，告警不再受其限制。增量迁移，不修改已有数据。
   - `…000019_okx_news_source_enum.sql`：为 `market_source` 增加 `okx-news`（须单独迁移，新枚举值不能在添加它的事务中使用）
   - `…000020_okx_news_ingest.sql`：`source_health.okx-news` 种子（5 分钟过期）、`hive_news_latest_published` 水位函数、允许 `okx-news` 的 `hive_news_ingest`，以及 `hive-okx-news-poller`（每分钟）
   - `…000021_alert_evaluator.sql`：`alert_rules.kind` 允许 `pct_move`；`SKHY` 写入 `symbol_map`（启用，幂等）；SNDK、MU、SKHY 的 `pct_move` 规则种子；`hive_alert_evaluator_record` 写入函数；`hive-alert-evaluator`（每分钟）
   - `…000022_yahoo_collector.sql`：`collector_state` 与 `source_health` 的 `yahoo` 行（健康告警默认禁用）；`hive-yahoo-collector`（每 2 分钟）
   - `…000023_ths_collector.sql`：`symbol_map` 增加 `ths_code`、`ths_kind`、`ths_auction`（默认关闭）；`source_health.session_only`（ths 的过期告警只在交易时段判断）；`hive_run_health_check` 按该标记跳过窗口外的检查；`hive_collector_upsert_daily_snapshot` 与 `hive_prune_ths_snapshots`；`hive-ths-collector`（每 2 分钟）与 `hive-ths-prune`。全部幂等，`ths` 数据源保持关闭，直到按下文「ths 行情」启用。若 Yahoo 的 `…000022_yahoo_collector.sql` 尚未应用，先按顺序执行它。
3. 部署 Edge Functions。在仓库根目录执行：

   ```bash
   supabase link --project-ref <project-ref>
   supabase functions deploy okx-collector --no-verify-jwt
   supabase functions deploy jin10-poller --no-verify-jwt
   supabase functions deploy okx-news-poller --no-verify-jwt
   supabase functions deploy webhook-dispatcher --no-verify-jwt
   supabase functions deploy alert-evaluator --no-verify-jwt
   supabase functions deploy yahoo-collector --no-verify-jwt
   supabase functions deploy ths-collector --no-verify-jwt
   ```

   `--no-verify-jwt` 与 `supabase/config.toml` 中的 `verify_jwt = false` 保持一致。pg_net 不携带 Supabase JWT，因此每个函数都改用自己的共享密钥校验 Bearer，未通过校验的请求返回 401。

4. 生成密钥并设置为 Edge secret。**密钥只存在于 Supabase 与 Vault 中，不要提交到仓库**：

   ```bash
   export COLLECTOR_SECRET="$(openssl rand -hex 32)"
   export EDGE_CRON_SECRET="$(openssl rand -hex 32)"
   supabase secrets set COLLECTOR_SECRET="$COLLECTOR_SECRET" EDGE_CRON_SECRET="$EDGE_CRON_SECRET"
   ```

   `COLLECTOR_SECRET` 供 okx-collector 使用，`EDGE_CRON_SECRET` 供 jin10-poller、okx-news-poller、webhook-dispatcher、alert-evaluator 与 yahoo-collector 使用。可以设为相同值，但建议分开。okx-news-poller 还需要只读 OKX Key：`supabase secrets set OKX_API_KEY=… OKX_API_SECRET=… OKX_API_PASSPHRASE=…`（三者需同时设置）。

5. 写入 Vault（只需执行一次，SQL Editor 或 `psql`）。阶段 1 的两个密钥照旧；阶段 2 新增两个：

   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/okx-collector', 'okx_collector_url', 'okx-collector Edge Function URL');
   select vault.create_secret('<与 COLLECTOR_SECRET 相同的值>', 'okx_collector_secret', 'okx-collector bearer secret');
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'edge_base_url', 'Edge Functions base URL');
   select vault.create_secret('<与 EDGE_CRON_SECRET 相同的值>', 'edge_cron_secret', 'Edge cron bearer secret');
   ```

   轮换密钥时，先执行 `supabase secrets set` 更新函数端，再用 `select vault.update_secret(id, '<新值>') from vault.secrets where name = '<名称>';` 更新 Vault。两边不一致时请求返回 401，对应数据源不会更新，直到两边一致为止。

6. 验证（约 1 分钟后）：

   ```sql
   select jobname, schedule, active from cron.job order by jobname;
   select source, lease_holder is not null as leased, last_outcome, last_finished_at from collector_state;
   select source, enabled, consecutive_failures, last_error, last_success_at from source_health order by source;
   select kind, severity, payload, triggered_at, resolved_at from alerts order by triggered_at desc limit 10;
   select status_code, error_msg, created from net._http_response order by id desc limit 5;
   ```

   `source_health` 中 `okx`、`jin10` 与 `okx-news` 的 `last_success_at` 应持续更新。`last_outcome` 为 `ok` 表示正常；`degraded` 表示部分请求或写入失败；`rate_limited` 表示 OKX 限流中。若未配置 Vault，`jin10` 与 `okx-news` 会在 5 分钟后各产生一条 `source_stale` 告警，这是预期行为。

7. webhook 订阅通过管理 API 创建（见下文「Webhook 管理 API」），不要直接写表。

### Yahoo 行情（yahoo-collector）

yahoo-collector 写入 `source = 'yahoo'` 的报价与 K 线，不需要任何 API Key。迁移与函数部署完成后，它会自动运行，但健康告警默认关闭，需要确认数据正常后再手动启用。

1. 应用迁移 `…000022_yahoo_collector.sql`，并部署 `yahoo-collector`（见上文第 2、3 步）。`EDGE_CRON_SECRET` 与 Vault 中的 `edge_cron_secret`、`edge_base_url` 沿用阶段 2 的配置，无需新增密钥。
2. 等待约 4 分钟（两个调度周期），确认数据写入：

   ```sql
   select source, lease_holder is not null as leased, last_outcome, last_finished_at from public.collector_state where source = 'yahoo';
   select source, enabled, consecutive_failures, last_error, last_success_at from public.source_health where source = 'yahoo';
   select symbol, price, ts, updated_at from public.quotes_latest where source = 'yahoo' order by symbol;
   select status_code, error_msg, created from net._http_response order by id desc limit 5;
   ```

   `last_outcome` 为 `ok` 表示正常。`rate_limited` 表示 Yahoo 限流，会退避 10 分钟后自动恢复。`quotes_latest` 中应出现各个 `yahoo_symbol` 对应的符号（如 `NVDA`、`BZ`、`XAU`、`BTC`、`ETH`）。
3. 确认 `v_spread` 中有对应行（需要 `okx` 与 `yahoo` 的报价同时存在）。`SKHY` 没有 Yahoo 映射，不会出现在视图中，这是预期的：

   ```sql
   select symbol, okx_inst_id, yahoo_symbol, spot_price, perp_price, spread, spread_pct from public.v_spread order by symbol;
   ```

4. 第 2、3 步确认无误后启用健康告警：

   ```sql
   update public.source_health set enabled = true where source = 'yahoo';
   ```

   启用后，`hive_run_health_check()` 会在超过 30 分钟没有成功写入时产生 `source_stale` 告警。若要回退，把 `enabled` 改回 `false` 即可。

**免费额度**：每天 720 次 Edge Function 调用（每 2 分钟一次），约 2.2 万次/月，远低于 50 万次的上限。

**Yahoo 侧的请求量与限流**：每个符号每 2 分钟一次 1m 请求，11 个符号约 7,900 次/天，另加每小时一次的日线请求。Yahoo 没有公开的配额，限流按出口 IP 计算。开发环境探测时曾在首个成功请求后持续收到 429。Supabase Edge 出口 IP 上的表现尚未验证，因此第 2 步必须实际确认数据写入，不要直接启用告警。收到 429 或 403 时，本次运行停止请求并退避 10 分钟，`source_health.yahoo.last_error` 记录最后一个错误。

**已知限制**：

- 接口为非官方接口，字段或路径随时可能变化。格式不符时请求会记为失败，并在 `last_error` 中给出 Yahoo 返回的错误信息。
- 若接口返回空数据（既无报价也无 K 线），本次运行既不写入也不记录失败，`source_health.yahoo` 不会更新。日线请求通常仍有数据，因此正常情况下不会误报；若长时间没有任何写入，启用后可能产生 `source_stale` 告警，确认后可暂时禁用。
- `BZ=F`、`XAUUSD=X` 等代码含 `=`，请求时会做 URL 编码。Yahoo 是否接受编码后的代码，以第 2 步的实际写入结果为准。

### ths 行情（supabase/functions/ths-collector，可选）

用同花顺（HiThink）公开 REST 替代本地 hithink CLI 轮询，供 A 股推送巡检与盯盘使用。数据源默认关闭（`source_health.ths.enabled = false`，`symbol_map` 中的 ths 行也是 `enabled = false`），完成下列步骤后才开始采集。

**接口与映射**

- 与 `@hithink-tech/hithink-finance-cli` 使用同一套接口，基址 `https://fuyao.aicubes.cn`，请求头 `X-api-key`，只读。密钥只放在 Edge secret `HITHINK_FINANCE_API_KEY` 中。

| 数据 | 接口 | 频率 | 写入 |
| --- | --- | --- | --- |
| 指数快照 | `/api/a-share-index/prices/snapshot?thscodes=` | 每轮 | `quotes_latest` |
| 个股快照（`symbol_map` 中 `ths_kind = stock` 的已启用行） | `/api/a-share/prices/snapshot?thscodes=` | 每轮 | `quotes_latest` |
| 涨停池 / 跌停池 / 炸板池 | `/api/a-share/special-data/limit-up-pool`、`limit-down-pool`、`limit-break-pool`（`page`、`size=200`，最多 5 页） | 每轮 | `daily_snapshot`：`ths_limit_up_pool` 等 |
| 连板梯队 | `/api/a-share/special-data/limit-up-ladder` | 每轮 | `ths_limit_up_ladder` |
| 热门股（小时） | `/api/a-share/special-data/hot-stock-list?period=hour` | 每轮 | `ths_hot_stock_hour` |
| 热门股（日）、大涨榜（日）、异动、龙虎榜 | `hot-stock-list?period=day`、`skyrocket-list?period=day`、`anomaly-analysis-list`、`dragon-tiger-list` | 每 10 分钟 | `ths_hot_stock_day`、`ths_skyrocket_day`、`ths_anomaly_list`、`ths_dragon_tiger` |
| 竞价基准 | `/api/a-share/auction/short-term-benchmark` | 每 10 分钟 | `ths_auction_benchmark` |
| 竞价快照 | `/api/a-share/auction/snapshot?thscodes=…&stage=live\|final`（仅 `ths_auction = true` 的股票，单次最多 100 个代码） | 每轮，09:25 前 `live`，09:25–09:40 `final` | `ths_auction_live`、`ths_auction_final` |
| 涨跌家数 | `/api/a-share/prices/snapshot?limit=100&offset=N`（分页，最多 100 页），按 `price_change_ratio_pct` 的符号统计 | 北京时间 15:00 之后每天一次 | `ths_breadth` |
| 交易日历 | `/api/a-share/calendar/trading-days` | 每个北京日期缓存一次 | 不落库，只用于判断交易日 |

**调度与门控**

- pg_cron `hive-ths-collector` 每 2 分钟调用一次，UTC 表达式 `*/2 1-7 * * 1-5`，即北京时间工作日 09:00–15:58。函数内再按北京时间 09:15（含）至 15:15（不含）判断，窗口外直接返回 `skipped`，不访问上游。
- 门控顺序：HTTP 方法 → `EDGE_CRON_SECRET` 是否配置 → Bearer → `HITHINK_FINANCE_API_KEY` 是否配置 → 交易时段 → `source_health.ths.enabled` → 交易日历 → 租约。
- **交易日历与节假日**：日历包含当天则为交易日。若日历不含当天，且列表已覆盖到前一个工作日，则视为非交易日：记录一次成功心跳（更新 `last_success_at`，不记失败），返回 `non_trading_day`，不发起行情请求。日历拉取失败，或列表过旧（未覆盖到前一个工作日）时，按工作日照常轮询，避免陈旧日历让交易日停止采集。
- **健康判断**：`source_health.ths.session_only = true`，`max_staleness_minutes = 10`。过期告警只在交易时段内判断（当前时刻与 10 分钟前都在窗口内），夜间、周末与节假日不会产生 `source_stale` 告警。
- **竞价**：`auction_live` 在 09:25 前运行，`auction_final` 在 09:25–09:40 运行。两者只在存在 `ths_auction = true` 的股票时发起请求，代码数超过 100 时只取前 100 个。

**上游预算与错误处理**

- 单轮预算 25 秒，预算用尽后不再启动新任务；单个 HTTP 请求超时 6 秒。
- 最多 4 个并发请求。每个 HTTP 调用对 429、5xx 与网络错误最多重试 3 次，指数退避，单次等待上限 4 秒。
- 单个端点失败只记录该端点，其余端点照常执行，整轮结果为 `degraded`。只有全部端点都失败时，`source_health.ths` 才记为失败。
- 限流（HTTP 429 或业务码 4001）：停止本轮新任务，`collector_state` 退避 300 秒，结果为 `rate_limited`。
- 鉴权失败（HTTP 401/403 或业务码 2001/2003）：停止本轮，结果为 `auth_error`，不设退避。修复密钥后下一轮即可恢复。
- 数据未就绪（业务码 3002，或快照缺少 `timestamp`）：记为 `not_ready`，不计入失败。
- 租约 90 秒。函数在 `finally` 中释放租约，异常退出也不会阻塞后续 tick。

**数据落地**

- 报价只写 `quotes_latest`（`source = 'ths'`，按时间戳保护，旧报价不会覆盖新报价）。**不写 `candles`**，因此 ths 没有 K 线。
- 池、梯队、热门、异动、龙虎榜、竞价与涨跌家数写入 `daily_snapshot`，主键 `(snapshot_date, kind)`，每天每种类型一行，每轮覆盖。`payload` 为 `{"fetched_at": …, "timestamp": …, "data": …}`，其中 `data` 为上游原始 JSON。数据库函数只接受 `ths_` 前缀的 kind，不会写入其他来源的行。
- `hive_prune_ths_snapshots()` 每天 03:40 UTC 删除 30 天前的 `ths_` 行。

**符号与竞价配置**

迁移写入以下种子（均为 `enabled = false`、`ths_auction = false`）。只使用 HiThink 文档中出现过的代码：

| symbol | ths_code | ths_kind |
| --- | --- | --- |
| `SH000001` | `000001.SH` | index |
| `SZ399001` | `399001.SZ` | index |
| `SH000300` | `000300.SH` | index |
| `MOUTAI` | `600519.SH` | stock |
| `WULIANGYE` | `000858.SZ` | stock |

创业板指 `399006.SZ` 不在文档中，因此未写入种子。验证后可手动添加：

```sql
insert into public.symbol_map (symbol, enabled, ths_code, ths_kind) values ('SZ399006', true, '399006.SZ', 'index');
```

竞价快照需要显式开启。仅对股票生效，代码由 `ths_auction` 决定：

```sql
update public.symbol_map set ths_auction = true where symbol = 'MOUTAI';
```

**部署步骤**

1. 应用迁移 `…000023_ths_collector.sql`（若 `…000022_yahoo_collector.sql` 尚未应用，先按顺序执行）。迁移幂等，执行后 ths 仍然关闭。
2. 设置密钥（只在 Supabase 中保存，不要提交到仓库）：

   ```bash
   supabase secrets set HITHINK_FINANCE_API_KEY='<HiThink API Key>'
   ```

   `THS_BASE_URL` 可选，默认即可。
3. 部署 Edge Function。与其他函数一样，pg_net 不携带 Supabase JWT，因此使用 `--no-verify-jwt`，并由函数自己校验 `EDGE_CRON_SECRET`：

   ```bash
   supabase functions deploy ths-collector --no-verify-jwt
   ```

4. 启用符号与数据源。先启用符号，再启用数据源：

   ```sql
   update public.symbol_map set enabled = true where ths_code is not null;
   update public.source_health set enabled = true where source = 'ths';
   ```

5. 在下一个交易时段内验证（约 2–4 分钟后）：

   ```sql
   select source, enabled, session_only, consecutive_failures, last_error, last_success_at from public.source_health where source = 'ths';
   select source, last_outcome, last_finished_at from public.collector_state where source = 'ths';
   select symbol, price, ts, updated_at from public.quotes_latest where source = 'ths' order by symbol;
   select kind, snapshot_date, created_at from public.daily_snapshot where left(kind, 4) = 'ths_' order by created_at desc limit 20;
   select jobname, schedule, active from cron.job where jobname like 'hive-ths%' order by jobname;
   select status_code, error_msg, created from net._http_response order by id desc limit 5;
   ```

   `last_outcome` 为 `ok` 或 `degraded` 表示正常。`degraded` 通常是个别端点（例如某张池）返回错误，可在 `daily_snapshot` 中确认其他类型是否已更新。

**首次上线前需要核对的内容**

- 本仓库没有 HiThink 密钥，以下接口的返回字段没有经过生产环境验证：涨停/跌停/炸板池、连板梯队、热门股、大涨榜、异动、龙虎榜、竞价基准与竞价快照、交易日历。这些数据按原始 JSON 写入 `payload.data`，采集器只解析信封的 `code`、`timestamp` 与 `item` 数组。
- 交易日历的解析接受字符串日期（`YYYY-MM-DD` 或 `YYYYMMDD`）、毫秒时间戳，或含 `date`、`trade_date`、`trading_day` 字段的对象。无法解析时该次日历视为失败，按工作日照常轮询。
- 报价字段 `thscode`、`last_price`、`price_change_ratio_pct` 与快照的 `timestamp`，以 hithink-finance CLI 的字段为准，已按此实现。上线后用 `daily_snapshot` 中的 `payload->'data'` 对照一次真实返回。
- 节假日：日历可用时非交易日会跳过；日历不可用时，非交易日仍会按工作日轮询，上游返回的空数据或 3002 记为 `not_ready`，不影响 `source_health`。

**调用预算（免费额度）**

- Edge 调用：每个工作日 210 次（每 2 分钟，北京时间 09:00–15:58），约 4,600 次/月，远低于免费版每月 50 万次的额度。窗口外的调用在门控处直接返回，不访问上游。
- 上游请求：交易时段内每轮约 7 次（指数、个股快照、三类池、梯队、热门小时）。每 10 分钟的整点轮次另加约 5 次（热门日、大涨、异动、龙虎榜、竞价基准）。竞价期间每轮另加 1 次。收盘后涨跌家数分页约 `ceil(总数 / 100)` 次，上限 100 次。
- 并发不超过 4，单轮失败不影响其他端点，与 Stock 原先约 10 并发的调用方式相比，对上游的瞬时压力更小。

**密钥与安全**

- `HITHINK_FINANCE_API_KEY` 只通过 Edge secret 注入。代码、日志与错误信息都不包含密钥，测试中有覆盖。

### Vercel（apps/web）

1. 导入本仓库，**Root Directory 设置为 `apps/web`**。
2. `apps/web/vercel.json` 已指定安装与构建命令（在仓库根目录执行 `pnpm install --frozen-lockfile`，构建 `@hive/web...` 及其依赖）。
3. 环境变量：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`HIVE_API_TOKEN`、`HIVE_DASHBOARD_PASSWORD`、`HIVE_SESSION_SECRET`。缺少后两者时仪表盘无法登录，设置方法见下文「仪表盘与访问密码」。
4. **不要添加 Vercel Cron**（Hobby 计划只支持每日一次）。分钟级任务请放在 pg_cron 或 Edge Function 中。

### 可选 / 遗留：Railway Worker（apps/worker）

Edge Function 已取代 Worker，**默认不需要部署**。仅在需要回退时使用，并且**同一时间只能运行一种采集方式**：Worker 的 advisory lock 与 Edge Function 的 `collector_state` 租约互不感知，同时运行会使 OKX 请求量翻倍，并可能触发限流。

若要使用 Worker：

1. 新建 Service，源选择本仓库。**Root Directory 设置为 `/`（仓库根目录）**，因为 Dockerfile 需要访问 `packages/core`。
2. Config-as-code 路径设置为 `apps/worker/railway.json`，其中指定了 Dockerfile 路径 `apps/worker/Dockerfile`。
3. **Region 选择 Southeast Asia（Singapore）**。
4. 环境变量：`SUPABASE_DB_URL`（Session pooler），以及可选的 `HIVE_SYMBOLS`、`HIVE_POLL_INTERVAL_SECONDS`、`SUPABASE_DB_CA_CERT`。
5. 确保只运行一个副本即可。即使多个副本启动，advisory lock 也只会让其中一个轮询，其余待命，因此可以安全地重启或滚动发布。
6. 使用 Worker 时，记得在 Supabase 中暂停 Edge Function 的调度：`select cron.unschedule('hive-okx-collector');`。

## 仪表盘与访问密码（apps/web）

`apps/web` 同时提供移动端优先的中文 PWA 仪表盘。根路径 `/` 会跳转到第一个面板。所有页面都需要登录，`/login`、`/offline` 与静态资源除外。

| 路径 | 面板 | 数据来源 |
| --- | --- | --- |
| `/health` | 数据源健康，附 webhook 推送的 24 小时投递摘要 | `source_health`、`webhook_deliveries` |
| `/alerts` | 最近 50 条告警（过期与恢复） | `alerts` |
| `/news` | 最近 20 个新闻事件，同一事件的多条来源聚合显示 | `news_events`、`news_items` |
| `/quotes` | OKX 永续合约最新价与日线走势 | `quotes_latest`、`candles`、`symbol_map` |

面板在 `apps/web/src/modules/registry.ts` 中注册。新增面板需要追加一条注册项，并创建 `app/(dashboard)/<id>/page.tsx`，导航与 PWA 快捷方式会自动生成。

### 设置访问密码

在 Vercel 项目的 **Settings → Environment Variables** 中添加以下两个变量，然后**重新部署**，新值才会生效：

| 变量 | 说明 |
| --- | --- |
| `HIVE_DASHBOARD_PASSWORD` | 登录密码。建议使用长随机串：`openssl rand -base64 24` |
| `HIVE_SESSION_SECRET` | 会话 Cookie 的签名密钥，至少 32 个字符：`openssl rand -hex 32` |

行为说明：

- 两个变量都必须存在，否则登录页返回「服务器未配置登录参数」，无法进入仪表盘（fail closed）。
- 密码只在服务端比较（SHA-256 摘要的常量时间比较），不会发送到浏览器，也不会出现在任何 `NEXT_PUBLIC_*` 变量中。
- 登录成功后下发 `hive_session` Cookie（HttpOnly、Secure、SameSite=Lax），有效期 7 天。
- 修改 `HIVE_DASHBOARD_PASSWORD` 只影响之后的登录，已登录的会话仍然有效直到过期。要立即让所有会话失效，请更换 `HIVE_SESSION_SECRET` 并重新部署。
- 登录失败会延迟约 500 毫秒，没有其他速率限制。请使用足够长的随机密码。
- `/api/*` 不经过登录页，仍使用 `HIVE_API_TOKEN` 的 Bearer 认证，供 Agent 调用。浏览器登录与 Agent 访问互不影响。

本地运行：

```bash
# apps/web/.env.local 中至少设置 HIVE_DASHBOARD_PASSWORD 与 HIVE_SESSION_SECRET；
# 未设置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY 时可以登录，但各面板会显示配置缺失的提示。
pnpm --filter @hive/web dev
```

然后打开 <http://localhost:3000>。

安装到手机主屏幕：iOS Safari 点击「分享 → 添加到主屏幕」，Android Chrome 点击菜单中的「安装应用」。Service Worker 只缓存静态外壳与离线页，页面数据与 `/api/*` 不会写入缓存。

## 告警规则（alert_rules）

规则保存在 `public.alert_rules`，`enabled = true` 的规则由 alert-evaluator 每分钟评估一次。`params` 为 JSON，解析与默认值见 `packages/core/src/alerts.ts` 的 `parseRuleParams`。

| `kind` | `params` | 触发条件 |
| --- | --- | --- |
| `price_cross` | `level`、`direction`（`above`/`below`） | 最近两根 1m 收盘价穿越 `level` |
| `candle_close_break` | `interval`、`level`、`direction` | 最新已确认 K 线收盘价越过 `level` |
| `volume_spike` | `interval`、`multiple`、`lookback`（默认 6） | 最新 K 线成交量 ≥ `multiple` × 之前 `lookback` 根的平均 |
| `long_wick` | `interval`、`minWickRatio`（默认 0.6）、`side`（`upper`/`lower`/`any`） | 最新 K 线影线占振幅的比例达到阈值 |
| `pullback` | `interval`、`lookback`（默认 20）、`minDropPct` | 最新收盘价较窗口最高价下跌 ≥ `minDropPct`% |
| `pct_move` | `interval`、`lookback`（1–500）、`minAbsPct`（> 0） | 见下文 |

**`pct_move`（区间涨跌幅）**：以同一 `interval` 下最新已确认 K 线的收盘价 `last`，与其之前第 `lookback` 根的收盘价 `earlier` 比较，`pct = (last − earlier) / earlier × 100`。当 `|pct| ≥ minAbsPct` 时触发。缺少足够的 K 线或 `earlier ≤ 0` 时不触发。只使用已确认 K 线，正在形成的 K 线不参与计算。

告警写入 `alerts`：`kind` 为规则的 `kind`，`symbol` 为规则的符号，`severity` 固定为 `warning`，`payload` 包含 `source`、`symbol`、`rule_id`、`rule_name`、`interval`、`bar_ts`，以及各类型的数值（例如 `pct` 与 `earlier_price`、`last_price`、`lookback`、`min_abs_pct`）。订阅方可用 `alert_kinds: ["pct_move"]` 过滤。

**评估语义**：
- 每分钟读取每个 `(符号, 周期)` 最近的已确认 K 线（同一序列只读一次），并对每条规则评估最新的一根。
- 冷却：规则在 `cooldown_seconds` 内最多写入一次（以 `last_triggered_at` 为准）。
- 去重：`dedup_key = rule:<rule_id>:<bar_ts>`，同一规则对同一根 K 线只写入一次，即使两次运行重叠。
- 新鲜度：最新已确认 K 线超过 3 个周期未更新（采集停滞）时不评估，避免基于陈旧数据告警。
- `price_cross` 没有 `interval` 参数，固定比较最近两根 1m 收盘价。
- 局限：`pct_move` 按 K 线根数计算，不检查时间间隔，采集中断导致的缺口不会被识别；评估只看最新一根已确认 K 线，若采集器在两次运行之间一次确认了多根 K 线，中间的几根不会被评估。采集（30 秒）加评估（每分钟）的延迟约为 1 分钟。

**Stock 盯盘用途（SNDK、MU、SKHY）**：迁移 `…000021` 写入三条规则，`params = {"interval":"1m","lookback":10,"minAbsPct":1}`，`cooldown_seconds = 600`。即最近 10 分钟涨跌幅 ≥ 1% 时告警，同一规则至多每 10 分钟一条，对应 Stock 原先的 10 分钟本地轮询。这些规则不设 `webhook_id`，告警由已订阅 `alert` 事件的 webhook 投递方接收。新增规则示例：

```sql
insert into public.alert_rules (name, symbol, kind, params, cooldown_seconds)
values ('BZ 10m move >=1%', 'BZ', 'pct_move', '{"interval":"1m","lookback":10,"minAbsPct":1}', 600);
```

## API（供 Agent 调用）

所有接口都需要请求头：`Authorization: Bearer <HIVE_API_TOKEN>`。未携带或令牌错误返回 `401`。

| 接口 | 参数 | 说明 |
| --- | --- | --- |
| `GET /api/quote` | `symbols`（必填，逗号分隔，最多 50 个）、`source`（默认 `okx`） | 最新报价。返回 `quotes` 与 `missing` |
| `GET /api/candles` | `symbol`、`interval`（`1m`/`5m`/`15m`/`1H`/`1D`，必填）、`source`、`from`、`to`（毫秒或 ISO-8601）、`limit`（默认 500，最大 2000） | 有 `from` 时按时间正序返回最早的 `limit` 根；没有 `from` 时返回最近的 `limit` 根，仍按时间正序。注意分钟线只保留 30 天 |
| `GET /api/atr` | `symbol`（必填）、`source`（默认 `okx`）、`period`（默认 14，1–100） | 基于已确认日线的 Wilder ATR。XAU 只使用工作日。数据不足返回 `422` |
| `GET /api/health` | 无 | 各数据源状态。存在已启用且过期的数据源时返回 `503`，`status` 为 `degraded` |
| `GET /api/webhooks` | 无 | 列出 webhook 订阅。不返回密钥，只返回 `secret_configured` |
| `POST /api/webhooks` | JSON，见下文 | 创建订阅，返回 `201`。未提供 `secret` 时自动生成 `signing_secret`，**只返回这一次** |
| `PATCH /api/webhooks/{id}` | JSON，部分更新；`rotate_secret: true` 轮换密钥 | 返回 `200`。轮换时返回新的 `signing_secret`，旧密钥立即失效 |
| `DELETE /api/webhooks/{id}` | 无 | 删除订阅，返回 `204`，其投递记录一并删除 |
| `GET /api/webhook-deliveries` | `status`（`pending`/`sending`/`delivered`/`dead`）、`agent`、`limit`（1–200，默认 50） | 投递记录，按创建时间倒序 |

示例：

```bash
curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/quote?symbols=NVDA,BTC,ETH&source=okx"

curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/candles?symbol=BTC&source=okx&interval=5m&limit=100"

curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/atr?symbol=XAU&period=14"
```

### Webhook 管理 API

创建订阅（同样需要 `Authorization: Bearer <HIVE_API_TOKEN>`）：

```bash
curl -X POST -H "Authorization: Bearer $HIVE_API_TOKEN" -H "content-type: application/json" \
  "https://<your-app>.vercel.app/api/webhooks" \
  -d '{"agent_name":"gold-bot","url":"https://agent.example.com/hive","event_types":["news","alert"],
       "filters":{"keywords":["黄金","美联储"],"sources":["jin10"],"severities":["warning","critical"]}}'
```

- `agent_name`：`[a-z0-9_-]{1,64}`，唯一。
- `url`：必须是 `https://`，最长 2048 字符。
- `event_types`：`news`、`alert` 的非空子集，默认两者都要。
- `auth_token`：可选，16–512 个可见 ASCII 字符（不含空格）。设置后每次投递都带 `Authorization: Bearer <auth_token>`，同时保留 HMAC 签名头。它与签名密钥一样存放在 Vault 中，**只写不读**：创建、更新时可以提交，任何响应都不会返回。PATCH 时省略表示保留原值，传 `null` 表示清除。
- `filters`：每个键都可省略，省略或为空数组表示不限制。`sources` 只过滤新闻来源（如 `jin10`、`okx-news`），告警不受它限制；`keywords` 为大小写不敏感的子串匹配，作用于新闻标题与正文或告警文本；`severities` 为 `info`/`warning`/`critical`；`alert_kinds` 为告警类型（如 `source_stale`）；`symbols` 为符号（如 `BTC`）。未知的键会被拒绝（`400`，并列出问题）。
- `secret`：可选，32–256 个字符。省略时由服务端生成并在响应的 `signing_secret` 中返回一次。
- `enabled`：默认 `true`。

投递格式：

```http
POST <your url>
content-type: application/json
x-hive-event: news            # news | alert
x-hive-delivery-id: 1234
x-hive-timestamp: 1760356800  # unix 秒
x-hive-signature: sha256=<hex>
authorization: Bearer <auth_token>   # 仅当订阅设置了 auth_token

{"delivery_id":1234,"event":"news","created_at":"2026-10-13T12:00:00.000Z","data":{...}}
```

验签方式：`hex(HMAC_SHA256(secret, "<x-hive-timestamp>." + <原始请求体>))` 必须与 `x-hive-signature` 的 `sha256=` 之后部分一致，并校验时间戳与当前时间相差不超过 300 秒。请使用原始请求体（未经 JSON 重新序列化）计算。仓库 `packages/core/src/webhook.ts` 中的 `verifyWebhookSignature` 即为参考实现。

应答要求：订阅方返回任意 `2xx` 即视为送达。其他状态码或超时（8 秒）视为失败并重试，重试间隔为 30 秒、60 秒、120 秒……上限 1 小时，最多 6 次。投递记录可通过 `GET /api/webhook-deliveries?status=dead` 查看。

Agent 集成建议：

- 每次请求都带上 Bearer 令牌，令牌只放在 Agent 的密钥存储中。
- 价格类判断使用 `quote`，技术指标与形态判断使用 `candles`。ATR 结果附带 `as_of`，请据此判断数据是否新鲜。
- 调用前先看 `/api/health`。若返回 503，说明数据源已过期，此时不要基于报价做决策。
- 遵守速率限制：采集端已经控制了上游请求，Agent 无需高频轮询 API，可以按需拉取。

## 安全

- 行情采集（okx-collector、apps/worker）只使用 OKX **公开**行情接口，不读取任何 API Key。快讯轮询（okx-news-poller）需要一组**只读** OKX API Key（`OKX_API_KEY` 等），仅用于签名快讯请求。本项目不做交易，不使用可交易权限的 Key。
- service role key、`HIVE_API_TOKEN`、`HIVE_DASHBOARD_PASSWORD`、`HIVE_SESSION_SECRET`、`COLLECTOR_SECRET`、`EDGE_CRON_SECRET` 与 Vault 中的密钥只能放在服务端环境变量或 Supabase 的密钥存储中。仪表盘的密码与会话密钥不会出现在任何客户端代码或 `NEXT_PUBLIC_*` 变量中。API 对令牌比较使用常量时间比较，且令牌未配置时拒绝所有请求。Edge Function 同样使用常量时间比较，且未配置 `COLLECTOR_SECRET` 时拒绝所有请求。
- 所有表开启 RLS；匿名与 `authenticated` 角色没有直接表权限。采集写入函数与 Vault 相关函数只授予 service role 执行。webhook 签名密钥存放在 Supabase Vault 中。
- `.env*` 已加入 `.gitignore`，只提交 `.env.example`。

## CI

`.github/workflows/ci.yml` 在每次 push 与 PR 上运行三个作业：

1. **node**：`pnpm install --frozen-lockfile`、`pnpm build`（core → web → worker）、`pnpm lint`、`pnpm typecheck`、`pnpm test`。
2. **edge-functions**：`node scripts/sync-edge-core.mjs --check`，然后对 `okx-collector`、`jin10-poller`、`okx-news-poller`、`webhook-dispatcher`、`alert-evaluator`、`yahoo-collector`、`ths-collector` 七个函数分别执行 `deno lint`、`deno check` 与 `deno test`。
3. **migrations**：启动 `supabase/postgres:17.6.1.066` 服务容器，依次应用全部迁移，然后执行 `supabase/tests/verify.sql`。

## 范围说明

- **同花顺（ths）范围**：只接入指数与个股快照、涨跌停/炸板池、连板梯队、热门股、大涨榜、异动、龙虎榜、竞价、涨跌家数和交易日历。不包含东财/新浪资金流、简报合成与漏发标记。
- **X（Twitter）不接入**：不使用 X API，没有 X 轮询函数，也没有 X 专用的 ingest 端点、健康阈值或告警。
- **OKX 快讯使用 Orbit 接口**：`GET /api/v5/orbit/news-search` 只拉取 `importance=high` 的快讯，`source` 为 `okx-news`（与 `okx` 行情源区分）。**实测不带 `OK-ACCESS-KEY` 的请求返回 401**（`code 50103`），携带无效 Key 返回 `50111`，因此必须配置 `OKX_API_KEY`、`OKX_API_SECRET`、`OKX_API_PASSPHRASE`（只读 Key 即可），函数按 OKX v5 规则签名。三者缺一时请求不签名，`source_health.okx-news.last_error` 会记录 OKX 返回的消息。该接口不在 OKX 公开公告接口的类型（`new-listings`、`delistings`、`trading-updates-us-aus`、`api`）之中，返回字段（如 `duplicateAuthors`）可能变化，格式不符时数据源降级并告警。
- **快讯关键词不在入库时过滤**：Hive 入库全部高重要性快讯。Agent 需要的关键词可以写在订阅的 `filters.keywords` 中，推送前由 Hive 过滤；未设置 `keywords` 的订阅会收到全部 `okx-news` 快讯，需要按关键词筛选的 Agent 请设置该字段或在客户端再次过滤。
- **Jin10 快讯为非官方接口**：请求头与查询参数来自 Jin10 网页端，并未在生产环境验证。若接口返回非 200、非 JSON 或格式不符，函数记录错误并返回 `degraded`，`source_health.jin10` 随之过期并触发告警。请在上线后检查 `source_health` 与 `net._http_response`，必要时用 `JIN10_*` 变量覆盖。
- **关键词之外的评分未实现**：推送前仅做规则过滤，没有 LLM 评分。`hive_subscription_matches` 是后续接入评分的位置。
- **遗留对象**：阶段 1 的 `webhooks`、`deliveries` 表与 `hive_deliveries` pgmq 队列、`hive_enqueue_alert` 函数仍然存在，但已不再被写入。删除需要单独的迁移，待确认没有外部依赖后再处理。
- **写入顺序的延迟**：告警由 `hive_run_health_check()` 每分钟写入，之后由分发函数的 30 秒兜底 cron 送出（最多约 30 秒）。新闻的唤醒路径见下文「延迟」。

## 后续计划

- Yahoo 行情的部署与启用步骤见「部署 > Yahoo 行情（yahoo-collector）」。
- Stock 的美股简报（US brief）与推送标记切换，待 Yahoo 数据稳定后另行实现；A 股行情（同花顺、sina）不在本阶段范围内。
- 成交回报的采集写入。
