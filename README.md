# Hive

Hive 是一个共享的市场数据服务：由一个常驻 Worker 负责轮询交易所公开行情，统一写入 Supabase Postgres，再由 Vercel 上的只读 API 供各个交易/新闻 AI Agent 调用。Agent 不再各自轮询交易所。

当前为 **阶段 1**：数据采集、schema、健康检查和读取 API。阶段 2（告警投递、新闻、成交回报）的表结构已经建好，但投递逻辑尚未实现。

## 架构

```
            OKX public REST (无密钥)
                     │  every ~10-20s
                     ▼
 ┌──────────────────────────────┐        ┌────────────────────────────┐
 │ Railway (Singapore)          │ SQL    │ Supabase (Tokyo, PG 17)    │
 │ apps/worker                  │───────▶│  candles / quotes_latest   │
 │ - pg advisory lock (单实例)  │        │  source_health / symbol_map│
 │ - tickers + 1m/5m/15m/1Dutc  │        │  alerts / deliveries(pgmq) │
 └──────────────────────────────┘        │  pg_cron: 每 5 分钟健康检查│
                                         │  vault: webhook 密钥       │
 ┌──────────────────────────────┐ PostgREST└────────────────────────────┘
 │ Vercel (Hobby)               │ (service role, server-only)  ▲
 │ apps/web  Next.js routes     │──────────────────────────────┘
 │ /api/quote /api/candles      │
 │ /api/atr   /api/health       │◀──── Bearer HIVE_API_TOKEN ──── AI Agents
 └──────────────────────────────┘
```

要点：

- **Worker（apps/worker）**：部署在 Railway，新加坡区域。Vercel 无法做分钟级轮询，因此采集全部放在 Worker。Worker 启动时用 `pg_try_advisory_lock` 竞争领导权，只有持锁实例轮询，其余实例待命。遇到 403/429 时按 `Retry-After` 或指数退避重试，并在周期级别继续拉长间隔。
- **数据库（supabase/）**：所有表开启 RLS，匿名与 `authenticated` 角色没有任何直接表权限，读取只能通过 Vercel API（service role）。
- **健康检查**：由 pg_cron 每 5 分钟执行 `hive_run_health_check()`，找出超过 `max_staleness_minutes` 未成功的数据源，写入 `alerts` 并在 `deliveries` 中登记待投递记录，同时发送到 pgmq 队列 `hive_deliveries`。阶段 2 的消费者读取队列并投递 webhook。
- **API（apps/web）**：Next.js Route Handlers，部署到 Vercel。没有配置任何 Vercel Cron（Hobby 计划仅支持每日一次），所有分钟级调度都在 pg_cron 或 Worker 中。

## 目录

```
apps/
  web/        Vercel 上的读取 API（Next.js App Router）
  worker/     Railway 上的 OKX 轮询 Worker（Dockerfile、railway.json）
packages/
  core/       共享逻辑：OKX 客户端、K 线解析、ATR、鉴权、告警规则校验与评估
supabase/
  migrations/ 按文件名顺序执行的 SQL 迁移
  tests/      verify.sql：迁移后的 schema 冒烟测试（事务内执行并回滚）
scripts/
  apply-migrations.sh  依次应用迁移
.github/workflows/ci.yml
```

## 环境变量

复制 `.env.example` 为 `.env.local`（本地）或在 Vercel / Railway 控制台中配置。**不要把真实密钥提交到仓库。**

| 变量 | used by | 说明 |
| --- | --- | --- |
| `SUPABASE_URL` | web | Supabase 项目地址，形如 `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | web | service role key，仅服务端使用 |
| `HIVE_API_TOKEN` | web | Agent 使用的 Bearer 令牌。未配置时 API 返回 500（fail closed）。生成：`openssl rand -hex 32` |
| `SUPABASE_DB_URL` | worker | 直连 Postgres 的连接串。**必须使用 Session pooler（5432）或直连**，不能用 Transaction pooler（6543），因为 Worker 依赖会话级 advisory lock |
| `SUPABASE_DB_CA_CERT` | worker | 可选。数据库端点的 PEM 证书，配置后启用证书校验；未配置时接受未校验的 TLS 连接 |
| `HIVE_SYMBOLS` | worker | 可选。逗号分隔的基础符号，默认 `BZ,SNDK,MU,META,NVDA,QQQ,MRNA,TSM,XAU,BTC,ETH` |
| `HIVE_POLL_INTERVAL_SECONDS` | worker | 可选。轮询间隔，5–300 秒，默认 15 |
| `OKX_BASE_URL` | worker | 可选。默认 `https://www.okx.com` |
| `DATABASE_URL` | 迁移脚本 | 用于 `scripts/apply-migrations.sh` 和 `verify.sql` 的数据库连接串 |

符号解析：Worker 启动时调用 OKX 公开接口 `/api/v5/public/instruments?instType=SWAP`，为每个符号选取处于 `live` 状态的 `<SYMBOL>-USDT-SWAP`（找不到时回退 `-USD-SWAP`），并写入 `symbol_map`。例如 `BTC-USDT-SWAP`、`XAU-USDT-SWAP`。修改 `HIVE_SYMBOLS` 后需要重启 Worker。

## 数据约定

- **日线使用 `1Dutc`**：OKX 的 `1D` 以 UTC+8 的 00:00 为一根 K 线的开盘（即 UTC 16:00）。Worker 请求的是 `1Dutc`（UTC 00:00），存储时 `interval = '1D'`。这样日期与星期判断都以 UTC 为准。
- **XAU 的 ATR 只使用工作日**：计算前剔除 UTC 星期六和星期日的日线。其他符号不做剔除。
- **ATR 只使用已确认的日线**（`confirmed = true`），正在形成的当日 K 线不参与计算。
- **Wilder ATR**：前 `period` 个真实波幅的简单平均作为初值，之后按 `(ATR·(n−1)+TR)/n` 平滑。
- `candles.confirmed` 对应 OKX 的 `confirm` 字段，`1` 表示已收盘。
- `quotes_latest` 每个 `(symbol, source)` 只保留最新一条。写入时只接受时间戳不早于已有记录的报价。
- `v_spread` 视图：`yahoo` 与 `okx` 同一符号的报价差与百分比。阶段 1 只写入 `okx`，因此视图暂时为空，阶段 2 接入 `yahoo` 后生效。

## 应用迁移

迁移需要 Supabase 兼容的 Postgres（包含 `pg_cron`、`pg_net`、`pgmq`、`supabase_vault`）。普通 Postgres 不满足要求。

迁移会依次启用以下扩展，并在空的 `public` schema 上创建全部表：

- `pg_cron`、`pg_net`、`pgmq`、`supabase_vault`

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

`verify.sql` 在事务内检查：所有表都开启了 RLS；匿名角色没有表权限；pgmq 队列与 pg_cron 任务已存在；webhook 密钥写入 Vault 且可解密；健康检查同一 15 分钟窗口内幂等；`candles` 与 `alerts` 的唯一约束生效；`v_spread` 可以计算价差。脚本最后回滚，不会留下数据。

## 本地开发

需要 Node 22（见 `.nvmrc`）和 pnpm 10。

```bash
pnpm install --frozen-lockfile
pnpm build         # core -> web (next build) -> worker；apps 依赖 core 的 dist，必须先构建
pnpm lint          # eslint
pnpm typecheck     # tsc（core / web / worker）
pnpm test          # vitest（core / worker / web）
```

运行 Worker（需要可用的数据库）：

```bash
SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:54322/postgres \
HIVE_POLL_INTERVAL_SECONDS=15 pnpm --filter @hive/worker start
```

启动后会看到 `leadership acquired`，随后每个周期输出 `cycle ok=55 failed=0 dbErrors=0`（11 个符号 × 5 个请求）。`dbErrors` 为本周期写库失败的次数，单次写库失败不会中断周期；只有本周期没有任何一次写入成功时，`source_health` 才记为失败。

运行 API（需要 Supabase REST 端点，本地可使用 PostgREST）：

```bash
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
HIVE_API_TOKEN=local-dev-token \
pnpm --filter @hive/web dev
```

## 部署

### Supabase

1. 在 Tokyo（ap-northeast-1）创建项目，Postgres 17。
2. 按上一节应用迁移。迁移会启用 pg_cron、pg_net、pgmq、Vault，并在 `public` 中创建表。
3. 在 Supabase 控制台的 Connect 页面复制 **Session pooler** 连接串，用于 Worker 的 `SUPABASE_DB_URL`。
4. 可在 Supabase 中为 Hive 的 webhook 添加密钥：通过 `select public.hive_upsert_webhook('name', 'https://...', 'secret')` 写入（密钥进入 Vault，表中只保存引用）。

### Vercel（apps/web）

1. 导入本仓库，**Root Directory 设置为 `apps/web`**。
2. `apps/web/vercel.json` 已指定安装与构建命令（在仓库根目录执行 `pnpm install --frozen-lockfile`，构建 `@hive/web...` 及其依赖）。
3. 环境变量：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`HIVE_API_TOKEN`。
4. **不要添加 Vercel Cron**（Hobby 计划只支持每日一次）。分钟级任务请放在 pg_cron 或 Worker。

### Railway（apps/worker）

1. 新建 Service，源选择本仓库。**Root Directory 设置为 `/`（仓库根目录）**，因为 Dockerfile 需要访问 `packages/core`。
2. Config-as-code 路径设置为 `apps/worker/railway.json`，其中指定了 Dockerfile 路径 `apps/worker/Dockerfile`。
3. **Region 选择 Southeast Asia（Singapore）**。
4. 环境变量：`SUPABASE_DB_URL`（Session pooler），以及可选的 `HIVE_SYMBOLS`、`HIVE_POLL_INTERVAL_SECONDS`、`SUPABASE_DB_CA_CERT`。
5. 确保只运行一个副本即可。即使多个副本启动，advisory lock 也只会让其中一个轮询，其余待命，因此可以安全地重启或滚动发布。

## API（供 Agent 调用）

所有接口都需要请求头：`Authorization: Bearer <HIVE_API_TOKEN>`。未携带或令牌错误返回 `401`。

| 接口 | 参数 | 说明 |
| --- | --- | --- |
| `GET /api/quote` | `symbols`（必填，逗号分隔，最多 50 个）、`source`（默认 `okx`） | 最新报价。返回 `quotes` 与 `missing` |
| `GET /api/candles` | `symbol`、`interval`（`1m`/`5m`/`15m`/`1H`/`1D`，必填）、`source`、`from`、`to`（毫秒或 ISO-8601）、`limit`（默认 500，最大 2000） | 有 `from` 时按时间正序返回最早的 `limit` 根；没有 `from` 时返回最近的 `limit` 根，仍按时间正序 |
| `GET /api/atr` | `symbol`（必填）、`source`（默认 `okx`）、`period`（默认 14，1–100） | 基于已确认日线的 Wilder ATR。XAU 只使用工作日。数据不足返回 `422` |
| `GET /api/health` | 无 | 各数据源状态。存在已启用且过期的数据源时返回 `503`，`status` 为 `degraded` |

示例：

```bash
curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/quote?symbols=NVDA,BTC&source=okx"

curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/candles?symbol=BTC&source=okx&interval=5m&limit=100"

curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/atr?symbol=XAU&period=14"
```

Agent 集成建议：

- 每次请求都带上 Bearer 令牌，令牌只放在 Agent 的密钥存储中。
- 价格类判断使用 `quote`，技术指标与形态判断使用 `candles`。ATR 结果附带 `as_of`，请据此判断数据是否新鲜。
- 调用前先看 `/api/health`。若返回 503，说明数据源已过期，此时不要基于报价做决策。
- 遵守速率限制：Worker 已经控制了上游请求，Agent 无需高频轮询 API，可以按需拉取。

## 安全

- 本项目只使用 OKX **公开**行情接口，不需要也不会读取任何 API Key，不做交易。
- service role key 与 `HIVE_API_TOKEN` 只能放在服务端环境变量中。API 对令牌比较使用常量时间比较，且令牌未配置时拒绝所有请求。
- 所有表开启 RLS；匿名与 `authenticated` 角色没有直接表权限。webhook 签名密钥存放在 Supabase Vault 中。
- `.env*` 已加入 `.gitignore`，只提交 `.env.example`。

## CI

`.github/workflows/ci.yml` 在每次 push 与 PR 上运行两个作业：

1. **node**：`pnpm install --frozen-lockfile`、`pnpm build`（core → web → worker）、`pnpm lint`、`pnpm typecheck`、`pnpm test`。
2. **migrations**：启动 `supabase/postgres:17.6.1.066` 服务容器，依次应用全部迁移，然后执行 `supabase/tests/verify.sql`。

## 阶段 2 计划

- 实现 `hive_deliveries` 队列消费者（Edge Function 或 Worker），按 `next_attempt_at` 重试，并使用 Vault 中的密钥对 webhook 请求签名。
- 接入 `yahoo` 等其他数据源的采集，使 `v_spread` 生效。
- 在 Worker 中按 `alert_rules` 评估价格穿越、K 线收盘突破、放量、长影线与回调规则，并使用 `cooldown_seconds` 与 `alertDedupKey` 防止重复告警。规则解析与评估函数已在 `packages/core` 中实现并有单元测试。
- 新闻与成交回报的采集写入。
