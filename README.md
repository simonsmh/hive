# Hive

Hive 是一个共享的市场数据服务：由 Supabase 上的 **Edge Function + pg_cron** 每 30 秒轮询交易所公开行情，统一写入 Supabase Postgres，再由 Vercel 上的只读 API 供各个交易/新闻 AI Agent 调用。Agent 不再各自轮询交易所。

> **采集已迁移到 Supabase 免费额度内的 Edge Function**（`supabase/functions/okx-collector`），不再需要付费的 Railway 常驻 Worker。`apps/worker` 保留为**可选 / 遗留**实现，默认不再部署。两者不要同时运行，见下文。

当前为 **阶段 1**：数据采集、schema、健康检查和读取 API。阶段 2（告警投递、新闻、成交回报）的表结构已经建好，但投递逻辑尚未实现。

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
- **健康检查**：由 pg_cron 每 5 分钟执行 `hive_run_health_check()`，找出超过 `max_staleness_minutes` 未成功的数据源，写入 `alerts` 并在 `deliveries` 中登记待投递记录，同时发送到 pgmq 队列 `hive_deliveries`。阶段 2 的消费者读取队列并投递 webhook。
- **保留（hive_run_retention）**：每天 UTC 03:17 清理历史数据，使数据库保持在 500MB 以内，见下文「数据约定」。
- **API（apps/web）**：Next.js Route Handlers，部署到 Vercel。没有配置任何 Vercel Cron（Hobby 计划仅支持每日一次），所有分钟级调度都在 pg_cron 中。

## 目录

```
apps/
  web/        Vercel 上的读取 API 与仪表盘（Next.js App Router）
  worker/     可选 / 遗留：Railway 上的 OKX 轮询 Worker（Dockerfile、railway.json）
packages/
  core/       共享逻辑：OKX 客户端、采集循环 (collector.ts)、K 线解析、ATR、鉴权、告警规则校验与评估
supabase/
  config.toml 最小化的 Supabase CLI 配置（声明 okx-collector 不校验 JWT）
  functions/okx-collector/  Edge Function（Deno）：index.ts 入口、handler.ts 处理逻辑、store.ts PostgREST 写入
    core/     由 scripts/sync-edge-core.mjs 从 packages/core 生成的副本，请勿手改
  migrations/ 按文件名顺序执行的 SQL 迁移
  tests/      verify.sql：迁移后的 schema 与采集路径冒烟测试（事务内执行并回滚）
scripts/
  apply-migrations.sh  依次应用迁移
  sync-edge-core.mjs   生成 Edge Function 的 core/ 副本；--check 用于 CI 校验是否过期
.github/workflows/ci.yml
```

## 环境变量

复制 `.env.example` 为 `.env.local`（本地）或在 Vercel 控制台中配置。**不要把真实密钥提交到仓库。**

| 变量 | used by | 说明 |
| --- | --- | --- |
| `SUPABASE_URL` | web | Supabase 项目地址，形如 `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | web | service role key，仅服务端使用 |
| `HIVE_API_TOKEN` | web | Agent 使用的 Bearer 令牌。未配置时 API 返回 500（fail closed）。生成：`openssl rand -hex 32` |
| `COLLECTOR_SECRET` | okx-collector（Edge secret） | pg_net 调用函数时使用的 Bearer 密钥。**必须与 Vault 中的 `okx_collector_secret` 相同**。通过 `supabase secrets set` 设置，见下文 |
| `OKX_BASE_URL` | okx-collector（Edge secret，可选） | 默认 `https://www.okx.com` |
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

cd supabase/functions/okx-collector
deno lint
deno check index.ts handler.test.ts store.test.ts
deno test
```

`pnpm sync:edge-core --check`（即 `node scripts/sync-edge-core.mjs --check`）会在副本过期时失败，CI 中也会执行此检查。

## 部署

### Supabase（采集与存储）

1. 在 Tokyo（ap-northeast-1）创建项目，Postgres 17。记录 `<project-ref>`。
2. 按上一节应用迁移（`scripts/apply-migrations.sh`）。迁移会启用 pg_cron、pg_net、pgmq、Vault，并在 `public` 中创建表与采集函数，同时注册 `hive-okx-collector`（30 秒）和 `hive-retention`（每天 03:17 UTC）。
3. 部署 Edge Function。在仓库根目录执行：

   ```bash
   supabase link --project-ref <project-ref>
   supabase functions deploy okx-collector --no-verify-jwt
   ```

   `--no-verify-jwt` 与 `supabase/config.toml` 中的 `verify_jwt = false` 保持一致。pg_net 不携带 Supabase JWT，函数改为用自己的 `COLLECTOR_SECRET` 校验 Bearer 密钥，未通过校验的请求返回 401。

4. 生成密钥并设置为 Edge secret。**密钥只存在于 Supabase 与 Vault 中，不要提交到仓库**：

   ```bash
   export COLLECTOR_SECRET="$(openssl rand -hex 32)"
   supabase secrets set COLLECTOR_SECRET="$COLLECTOR_SECRET"
   ```

5. 写入 Vault（只需执行一次）。使用同一个 `COLLECTOR_SECRET` 值，通过 `psql` 或 SQL Editor 执行：

   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/okx-collector', 'okx_collector_url', 'okx-collector Edge Function URL');
   select vault.create_secret('<与 COLLECTOR_SECRET 相同的值>', 'okx_collector_secret', 'okx-collector bearer secret');
   ```

   轮换密钥时，先执行 `supabase secrets set COLLECTOR_SECRET=...` 更新函数端，再用 `select vault.update_secret(id, '<新值>') from vault.secrets where name = 'okx_collector_secret';` 更新 Vault。两边不一致时，pg_net 请求会返回 401，`source_health` 不会更新，直到两边一致为止。

6. 验证采集已运行（约 1 分钟后）：

   ```sql
   select source, lease_holder is not null as leased, last_outcome, last_finished_at, last_summary from collector_state;
   select source, consecutive_failures, last_error, last_success_at from source_health where source = 'okx';
   select status_code, error_msg, created from net._http_response order by id desc limit 5;
   ```

   `last_outcome` 为 `ok`、`consecutive_failures` 为 0，即表示正常。`degraded` 表示部分 OKX 请求或写入失败，`rate_limited` 表示正在退避。

7. 如果需要 webhook（阶段 2），可通过 `select public.hive_upsert_webhook('name', 'https://...', 'secret')` 写入（密钥进入 Vault，表中只保存引用）。

### Vercel（apps/web）

1. 导入本仓库，**Root Directory 设置为 `apps/web`**。
2. `apps/web/vercel.json` 已指定安装与构建命令（在仓库根目录执行 `pnpm install --frozen-lockfile`，构建 `@hive/web...` 及其依赖）。
3. 环境变量：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`HIVE_API_TOKEN`。
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

## API（供 Agent 调用）

所有接口都需要请求头：`Authorization: Bearer <HIVE_API_TOKEN>`。未携带或令牌错误返回 `401`。

| 接口 | 参数 | 说明 |
| --- | --- | --- |
| `GET /api/quote` | `symbols`（必填，逗号分隔，最多 50 个）、`source`（默认 `okx`） | 最新报价。返回 `quotes` 与 `missing` |
| `GET /api/candles` | `symbol`、`interval`（`1m`/`5m`/`15m`/`1H`/`1D`，必填）、`source`、`from`、`to`（毫秒或 ISO-8601）、`limit`（默认 500，最大 2000） | 有 `from` 时按时间正序返回最早的 `limit` 根；没有 `from` 时返回最近的 `limit` 根，仍按时间正序。注意分钟线只保留 30 天 |
| `GET /api/atr` | `symbol`（必填）、`source`（默认 `okx`）、`period`（默认 14，1–100） | 基于已确认日线的 Wilder ATR。XAU 只使用工作日。数据不足返回 `422` |
| `GET /api/health` | 无 | 各数据源状态。存在已启用且过期的数据源时返回 `503`，`status` 为 `degraded` |

示例：

```bash
curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/quote?symbols=NVDA,BTC,ETH&source=okx"

curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/candles?symbol=BTC&source=okx&interval=5m&limit=100"

curl -H "Authorization: Bearer $HIVE_API_TOKEN" \
  "https://<your-app>.vercel.app/api/atr?symbol=XAU&period=14"
```

Agent 集成建议：

- 每次请求都带上 Bearer 令牌，令牌只放在 Agent 的密钥存储中。
- 价格类判断使用 `quote`，技术指标与形态判断使用 `candles`。ATR 结果附带 `as_of`，请据此判断数据是否新鲜。
- 调用前先看 `/api/health`。若返回 503，说明数据源已过期，此时不要基于报价做决策。
- 遵守速率限制：采集端已经控制了上游请求，Agent 无需高频轮询 API，可以按需拉取。

## 安全

- 本项目只使用 OKX **公开**行情接口，不需要也不会读取任何 API Key，不做交易。
- service role key、`HIVE_API_TOKEN`、`COLLECTOR_SECRET` 与 Vault 中的 `okx_collector_secret` 只能放在服务端环境变量或 Supabase 的密钥存储中。API 对令牌比较使用常量时间比较，且令牌未配置时拒绝所有请求。Edge Function 同样使用常量时间比较，且未配置 `COLLECTOR_SECRET` 时拒绝所有请求。
- 所有表开启 RLS；匿名与 `authenticated` 角色没有直接表权限。采集写入函数与 Vault 相关函数只授予 service role 执行。webhook 签名密钥存放在 Supabase Vault 中。
- `.env*` 已加入 `.gitignore`，只提交 `.env.example`。

## CI

`.github/workflows/ci.yml` 在每次 push 与 PR 上运行三个作业：

1. **node**：`pnpm install --frozen-lockfile`、`pnpm build`（core → web → worker）、`pnpm lint`、`pnpm typecheck`、`pnpm test`。
2. **edge-function**：`node scripts/sync-edge-core.mjs --check`，然后在 `supabase/functions/okx-collector` 中执行 `deno lint`、`deno check` 与 `deno test`。
3. **migrations**：启动 `supabase/postgres:17.6.1.066` 服务容器，依次应用全部迁移，然后执行 `supabase/tests/verify.sql`。

## 阶段 2 计划

- 实现 `hive_deliveries` 队列消费者（Edge Function 或 Worker），按 `next_attempt_at` 重试，并使用 Vault 中的密钥对 webhook 请求签名。
- 接入 `yahoo` 等其他数据源的采集，使 `v_spread` 生效。
- 在 Edge Function 中按 `alert_rules` 评估价格穿越、K 线收盘突破、放量、长影线与回调规则，并使用 `cooldown_seconds` 与 `alertDedupKey` 防止重复告警。规则解析与评估函数已在 `packages/core` 中实现并有单元测试。
- 新闻与成交回报的采集写入。
