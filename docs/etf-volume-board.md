# ETF 成交观察

页面 `/etf-volume`、API `/api/etf-volume` 复用 dashboard/API 认证。

## 来源与范围
THS ETF目录1733只（2026-11-19 实测 code=0）。基金资料510300.SH实测code=0但无跟踪指数代码字段：分组仅按THS名称严格「指数名+ETF」前缀，不冒称官方跟踪代码。16组匹配169只，首批每组证券代码排序最多4只，共61只；不是流动性/规模排名。完整169只可展开看，未采集明确标记。增强、行业、策略、跨境、债券、商品等非精确前缀不混入。

基金快照 `/api/fund/market/snapshot` 使用turnover累计成交额、price_change_ratio_pct原始ETF涨跌字段。首轮真实61次请求成功60只，1次3002未补零。午休有效成交时刻归11:30、盘后归15:00，原始源时间rawSourceTs另存。THS交易日历决定上一交易日。未复权现金成交额比较，不拿价格乘成交量，也不拿半日除全天。

## 数学口径
同刻±60秒、同一可比集合成交额之和比，不是个体比值平均。无历史/停牌零成交/新上市/源过期均null。量比≥1.10放量，≤0.90缩量，其余持平。ETF价格涨跌与量能独立；不称指数涨跌。无资金方向字段，覆盖0/未知，成交量能不等于净申赎或机构买入。

首轮真实成交额164.703025389亿元、涨5跌54平1；首日可比0，必须显示待积累，不虚构放缩量。下一交易日同刻才可能有基线；今日从午休启动，明日上午仍可能无基线。

## 运维
独立Edge etf-volume-collector，10分钟节奏、并发2、8秒单请求超时，过滤非交易日和午休。只落新表etf_volume_snapshots，约26个紧凑JSON行/交易日，20自然日保留，不写candles。RLS开启，仅service_role有权限。原有生产Edge、黄金/A股告警与交易不动。
回滚：将hive-etf-volume-collector的cron.alter_job active设false（仅该任务），页面回滚git，保留数据。
迁移20261119044709；验证supabase/tests/etf-volume.sql事务回滚。
web全套279项测试及build通过，数学测试8项。生产视觉由父层验收。

## 无密钥隔离布局验收
仓库根 `PORT=3107 scripts/preview-etf-volume.sh`，访问http://127.0.0.1:3107。
独立临时Next目录，合成TEST FIXTURE，不复制dotenv，不连接数据库，不使用生产密钥。
