# XAUUSD 现货 3720 一次性跌破提醒

国际现货黄金（美元/金衡盎司）首次新鲜报价跌至 3720 或以下时，通过已有的 `grokbot-market` 订阅推送一次，然后停用该 watch。不是日收盘确认，也不是逐笔成交；不是交易或清仓指令。

## 数据源

- 官方文档：https://gold-api.com/docs 与 https://gold-api.com/llms.txt，FAQ https://gold-api.com/faqs
- 端点：`GET https://api.gold-api.com/price/XAU`（默认 USD，免费、无需 API key）
- 文档写明：这是现货价（spot），单位为金衡盎司；`updatedAt` 是服务端上次从数据源拉取的 UTC 时间；实时价约每 30 秒更新，要求缓存至少 30 秒；商业使用允许。不调用需 API key 的 `/history`、`/ohlc`，也不编造 1m K 线。
- Hive 中使用独立 `source=gold-api`、`symbol=XAUUSD`，与 OKX 永续 `XAU` / `XAU-USDT-SWAP` 以及 COMEX `GC=F` 分开。

## 规则字段

- kind: `snapshot_cross`
- source: `gold-api`
- symbol: `XAUUSD`
- params: `{ "level": 3720, "direction": "below", "once": true, "maxQuoteAgeSeconds": 480 }`
- 采集：`gold-api-collector` 每 2 分钟一次（`hive-gold-api-collector`）
- 评估与分发：现有 `alert-evaluator`、`webhook-dispatcher` 仍为每 2 分钟
- 延迟：通常约 2–6 分钟（采集间隔 + 评估 + 分发），外加源 `updatedAt` 本身最多约 30 秒，不是逐笔实时
- 新鲜度：报价 `updatedAt` 超过 480 秒则跳过
- 一次性：第一次从高于 3720 的已武装报价穿越到 `<= 3720` 并成功写入 alert 后，将该规则 `enabled=false`。30 天冷却不等于一次性，本规则不靠长冷却。
- 若启用时第一条快照已在 3720 下方，只武装、不把「已经低于」谎称为新下穿。

## 接收过滤（父层例程）

`event_types=alert`，`kind=snapshot_cross`，`source=gold-api`，`symbol=XAUUSD`。payload 含 `last_price`、`previous_price`、`level`、`quote_ts`、`quote_type=spot_snapshot`、`unit=USD_per_troy_oz`、`once=true`。测试投递的 `dedup_key` 以 `test:` 开头，payload 带 `test: true`，不是自然行情。
