# Hive

Hive 是一个共享的市场数据服务：由 Supabase 上的 **Edge Function + pg_cron** 每 30 秒轮询交易所公开行情，统一写入 Supabase Postgres，再由 Vercel 上的只读 API 供各个交易/新闻 AI Agent 调用。Agent 不再各自轮询交易所。

> **采集已迁移到 Supabase 免费额度内的 Edge Function**（`supabase/functions/okx-collector`），不再需要付费的 Railway 常驻 Worker。`apps/worker` 保留为**可选 / 遗留**实现，默认不再部署。两者不要同时运行，见下文。

当前为 **阶段 2**：OKX 行情采集、Jin10 快讯轮询、OKX Orbit 重要快讯轮询、数据源过期告警（含恢复）、webhook 推送（HMAC 签名、退避重试、投递记录）、仪表盘与管理 API。X（Twitter）不接入，见「范围说明」。

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
- **OKX 快讯（supabase/functions/okx-news-poller）**：pg_cron 每 60 秒调用一次。函数请求 OKX Orbit 快讯搜索接口 `GET /api/v5/orbit/news-search?importance=high`，需要只读 OKX API Key 签名（见下文「范围说明」），经 `hive_news_ingest` 按 `source + external_id`（`okx-news:<id>`）去重写入 `news_items`，`source` 为 `okx-news`，并更新 `source_health.okx-news`。与 Jin10 相同，本轮询若插入了新快讯，同样会唤醒分发函数（见「延迟」）。查询窗口的起点是已入库的最新 `published_at` 向前回溯 10 分钟，窗口最早不早于 2 小时前；每页 50 条，最多 10 页，按 `end = 最早 cTime - 1` 向前翻页。任一页失败时本轮整体不写入，下一轮从同一位置重试。数据源超过 5 分钟未成功即产生 `source_stale` 告警。
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
- **免费额度**：Supabase 免费版每月 50 万次 Edge Function 调用。采集、轮询、分发兜底各每天 2,880 次，分发唤醒最多每天 2,880 次，合计最多约 34.5 万次/月。

生产环境观测最近一天的快讯送达延迟（`published_at` 为 Jin10 快讯时间，`delivered_at` 为首次成功投递时间）：

```sql
select count(*) as delivered,
       round(avg(extract(epoch from delivered_at - (payload->>'published_at')::timestamptz))::numeric, 1) as avg_seconds,
       round(max(extract(epoch from delivered_at - (payload->>'published_at')::timestamptz))::numeric, 1) as max_seconds
  from public.webhook_deliveries
 where event_type = 'news' and status = 'delivered' and delivered_at > now() - interval '1 day';
```

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
    core/     由 scripts/sync-edge-core.mjs 从 packages/core 生成的副本，请勿手改（每个函数各一份）
  migrations/ 按文件名顺序执行的 SQL 迁移（01–10 为阶段 1，11–20 为阶段 2）
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
| `EDGE_CRON_SECRET` | jin10-poller、okx-news-poller、webhook-dispatcher（Edge secret） | pg_net 调用这些函数时使用的 Bearer 密钥。**必须与 Vault 中的 `edge_cron_secret` 相同**。未配置时这些函数都拒绝请求 |
| `JIN10_FLASH_URL`、`JIN10_APP_ID`、`JIN10_VERSION`、`JIN10_REFERER`、`JIN10_QUERY` | jin10-poller（Edge secret，可选） | 覆盖 Jin10 快讯接口的地址、请求头与查询参数。默认值见 `supabase/functions/jin10-poller/handler.ts` 中的 `DEFAULT_JIN10_CONFIG`。上游改版时可直接覆盖，无需重新发版 |
| `OKX_BASE_URL` | okx-collector、okx-news-poller（Edge secret，可选） | 默认 `https://www.okx.com` |
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

`hive_invoke_edge_function(name)` 被 `hive-jin10-poller`、`hive-webhook-dispatch` 等 pg_cron 任务共用。它从 Vault 读取以下两个密钥，cron 任务本身不保存任何密钥。

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

## 数据约定

- **日线使用 `1Dutc`**：OKX 的 `1D` 以 UTC+8 的 00:00 为一根 K 线的开盘（即 UTC 16:00）。采集请求的是 `1Dutc`（UTC 00:00），存储时 `interval = '1D'`。这样日期与星期判断都以 UTC 为准。
- **XAU 的 ATR 只使用工作日**：计算前剔除 UTC 星期六和星期日的日线。其他符号不做剔除。
- **ATR 只使用已确认的日线**（`confirmed = true`），正在形成的当日 K 线不参与计算。
- **Wilder ATR**：前 `period` 个真实波幅的简单平均作为初值，之后按 `(ATR·(n−1)+TR)/n` 平滑。
- `candles.confirmed` 对应 OKX 的 `confirm` 字段，`1` 表示已收盘。
- `quotes_latest` 每个 `(symbol, source)` 只保留最新一条。写入时只接受时间戳不早于已有记录的报价。
- `v_spread` 视图：`yahoo` 与 `okx` 同一符号的报价差与百分比。阶段 1 只写入 `okx`，因此视图暂时为空，阶段 2 接入 `yahoo` 后生效。
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

采集相关的检查同样在事务内完成：`hive_collector_*` 函数只允许 service role 执行；租约互斥且在退避期内拒绝运行；报价只接受不更旧的时间戳；K 线按主键幂等写入；保留任务删除 30 天前的分钟线但保留日线；`hive-okx-collector`（30 秒）与 `hive-retention` 任务已注册；未配置 Vault 时采集 tick 为空操作，配置后会排入一条 pg_net 请求。验证中使用的测试符号为 `VERIFY`，脚本最后回滚，不会留下数据。

## 本地开发

需要 Node 22（见 `.nvmrc`）和 pnpm 10。Edge Function 的测试需要 [Deno](https://deno.com) 2.x。

```bash
pnpm install --frozen-lockfile
pnpm build         # core -> web (next build) -> worker；apps 依赖 core 的 dist，必须先构建
pnpm lint          # eslint
pnpm typecheck     # tsc（core / web / worker）
pnpm test          # vitest（core / worker / web）
pnpm sync:edge-core  # 修改 packages/core 中的采集相关模块后必须运行，生成 Edge Function 的 core/ 副本

for f in okx-collector jin10-poller okx-news-poller webhook-dispatcher; do
  (cd supabase/functions/$f && deno lint && deno check index.ts handler.ts store.ts *.test.ts && deno test)
done
```

`pnpm sync:edge-core --check`（即 `node scripts/sync-edge-core.mjs --check`）会在副本过期时失败，CI 中也会执行此检查。

## 部署

### Supabase（采集、新闻与推送）

1. 在 Tokyo（ap-northeast-1）创建项目，Postgres 17，使用免费计划。记录 `<project-ref>`。
2. 应用迁移（`scripts/apply-migrations.sh`，按文件名顺序）。全新项目执行 `20261013000001` 至 `20261013000020`；已部署阶段 1 的项目只需执行新增的 `20261013000011` 至 `20261013000020`：
>   - `…000011_news_source_enum.sql`：为 `market_source` 增加 `jin10`
   - `…000012_news_ingest.sql`：`news_items.author`、`source_health.jin10` 种子、`hive_news_ingest` 写入函数
   - `…000013_webhook_subscriptions.sql`：`alerts.severity` / `resolved_at`，`webhook_subscriptions`、`webhook_deliveries`，预过滤触发器与分发/管理函数
   - `…000014_health_alerts.sql`：健康检查的开启/恢复语义，改为每分钟执行
   - `…000015_edge_news_cron.sql`：`hive_invoke_edge_function`，`hive-jin10-poller`（30 秒）、`hive-webhook-dispatch`（原为每分钟）、`hive-news-prune`（每天 03:27 UTC）
   - `…000017_news_dispatch_kick.sql`：新快讯入库后唤醒分发函数；`hive-webhook-dispatch` 改为每 30 秒（见下文「延迟」）。仅替换函数与调度，不修改数据
   - `…000016_webhook_auth_token.sql`：订阅可选的 Bearer 令牌（`auth_token_secret_id`，存于 Vault）；`sources` 过滤只作用于新闻，告警不再受其限制。增量迁移，不修改已有数据。
   - `…000019_okx_news_source_enum.sql`：为 `market_source` 增加 `okx-news`（须单独迁移，新枚举值不能在添加它的事务中使用）
   - `…000020_okx_news_ingest.sql`：`source_health.okx-news` 种子（5 分钟过期）、`hive_news_latest_published` 水位函数、允许 `okx-news` 的 `hive_news_ingest`，以及 `hive-okx-news-poller`（每 60 秒）
3. 部署 Edge Functions。在仓库根目录执行：

   ```bash
   supabase link --project-ref <project-ref>
   supabase functions deploy okx-collector --no-verify-jwt
   supabase functions deploy jin10-poller --no-verify-jwt
   supabase functions deploy okx-news-poller --no-verify-jwt
   supabase functions deploy webhook-dispatcher --no-verify-jwt
   ```

   `--no-verify-jwt` 与 `supabase/config.toml` 中的 `verify_jwt = false` 保持一致。pg_net 不携带 Supabase JWT，因此每个函数都改用自己的共享密钥校验 Bearer，未通过校验的请求返回 401。

4. 生成密钥并设置为 Edge secret。**密钥只存在于 Supabase 与 Vault 中，不要提交到仓库**：

   ```bash
   export COLLECTOR_SECRET="$(openssl rand -hex 32)"
   export EDGE_CRON_SECRET="$(openssl rand -hex 32)"
   supabase secrets set COLLECTOR_SECRET="$COLLECTOR_SECRET" EDGE_CRON_SECRET="$EDGE_CRON_SECRET"
   ```

   `COLLECTOR_SECRET` 供 okx-collector 使用，`EDGE_CRON_SECRET` 供 jin10-poller、okx-news-poller 与 webhook-dispatcher 使用。可以设为相同值，但建议分开。

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

- 本项目只使用 OKX **公开**行情接口，不需要也不会读取任何 API Key，不做交易。
- service role key、`HIVE_API_TOKEN`、`HIVE_DASHBOARD_PASSWORD`、`HIVE_SESSION_SECRET`、`COLLECTOR_SECRET`、`EDGE_CRON_SECRET` 与 Vault 中的密钥只能放在服务端环境变量或 Supabase 的密钥存储中。仪表盘的密码与会话密钥不会出现在任何客户端代码或 `NEXT_PUBLIC_*` 变量中。API 对令牌比较使用常量时间比较，且令牌未配置时拒绝所有请求。Edge Function 同样使用常量时间比较，且未配置 `COLLECTOR_SECRET` 时拒绝所有请求。
- 所有表开启 RLS；匿名与 `authenticated` 角色没有直接表权限。采集写入函数与 Vault 相关函数只授予 service role 执行。webhook 签名密钥存放在 Supabase Vault 中。
- `.env*` 已加入 `.gitignore`，只提交 `.env.example`。

## CI

`.github/workflows/ci.yml` 在每次 push 与 PR 上运行三个作业：

1. **node**：`pnpm install --frozen-lockfile`、`pnpm build`（core → web → worker）、`pnpm lint`、`pnpm typecheck`、`pnpm test`。
2. **edge-functions**：`node scripts/sync-edge-core.mjs --check`，然后对 `okx-collector`、`jin10-poller`、`okx-news-poller`、`webhook-dispatcher` 四个函数分别执行 `deno lint`、`deno check` 与 `deno test`。
3. **migrations**：启动 `supabase/postgres:17.6.1.066` 服务容器，依次应用全部迁移，然后执行 `supabase/tests/verify.sql`。

## 范围说明

- **X（Twitter）不接入**：不使用 X API，没有 X 轮询函数，也没有 X 专用的 ingest 端点、健康阈值或告警。
- **OKX 快讯使用 Orbit 接口**：`GET /api/v5/orbit/news-search` 无需密钥，只拉取 `importance=high` 的快讯，`source` 为 `okx-news`（与 `okx` 行情源区分）。该接口不在 OKX 公开公告接口的类型（`new-listings`、`delistings`、`trading-updates-us-aus`、`api`）之中，返回字段（如 `duplicateAuthors`）可能变化，格式不符时数据源降级并告警。
- **快讯关键词不在入库时过滤**：Hive 入库全部高重要性快讯。Agent 需要的关键词可以写在订阅的 `filters.keywords` 中，推送前由 Hive 过滤；未设置 `keywords` 的订阅会收到全部 `okx-news` 快讯，需要按关键词筛选的 Agent 请设置该字段或在客户端再次过滤。
- **Jin10 快讯为非官方接口**：请求头与查询参数来自 Jin10 网页端，并未在生产环境验证。若接口返回非 200、非 JSON 或格式不符，函数记录错误并返回 `degraded`，`source_health.jin10` 随之过期并触发告警。请在上线后检查 `source_health` 与 `net._http_response`，必要时用 `JIN10_*` 变量覆盖。
- **关键词之外的评分未实现**：推送前仅做规则过滤，没有 LLM 评分。`hive_subscription_matches` 是后续接入评分的位置。
- **遗留对象**：阶段 1 的 `webhooks`、`deliveries` 表与 `hive_deliveries` pgmq 队列、`hive_enqueue_alert` 函数仍然存在，但已不再被写入。删除需要单独的迁移，待确认没有外部依赖后再处理。
- **写入顺序的延迟**：告警由 `hive_run_health_check()` 每分钟写入，之后由分发函数的 30 秒兜底 cron 送出（最多约 30 秒）。新闻的唤醒路径见下文「延迟」。

## 后续计划

- 接入其他数据源（如 `yahoo`），使 `v_spread` 生效。
- 在 Edge Function 中评估 `alert_rules`（价格穿越、K 线收盘突破、放量、长影线、回调），使用 `cooldown_seconds` 与 `alertDedupKey` 防止重复告警。规则解析与评估函数已在 `packages/core` 中实现并有单元测试。
- 成交回报的采集写入。
