#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
preview=$(mktemp -d /tmp/hive-etf-preview.XXXXXX)
mkdir -p "$preview/app"
ln -s "$repo/apps/web/node_modules" "$preview/node_modules"
cp "$repo/apps/web/src/components/dashboard/EtfVolumeBoard.tsx" "$preview/app/Board.tsx"
# Only a type import is removed; no application auth/database modules enter the preview.
python3 - "$preview" <<'PY'
import pathlib,sys,json
p=pathlib.Path(sys.argv[1]);f=p/'app/Board.tsx';s=f.read_text().replace("import type {EtfBoard} from '@/src/modules/etf-volume/model';",'type EtfBoard = any;');f.write_text(s)
(p/'package.json').write_text('{"private":true,"scripts":{"dev":"next dev"},"dependencies":{"next":"15.5.27","react":"19.0.0","react-dom":"19.0.0"}}')
(p/'app/layout.tsx').write_text('export default function Layout({children}:any){return <html><body style={{background:"#080f18",color:"#e2e8f0",fontFamily:"sans-serif",margin:"30px"}}>{children}</body></html>}')
# Explicit synthetic demonstration, not a production data source or trade signal.
model=pathlib.Path.cwd() if False else None
PY
cp "$repo/apps/web/src/modules/etf-volume/model.ts" "$preview/app/model.ts"
cat > "$preview/app/page.tsx" <<'PAGE'
import {EtfVolumeBoard} from './Board';
import {buildBoard} from './model';
export default function Page(){
 const ts=Date.parse('2026-11-19T02:00:00Z');
 const catalog=['沪深300','科创50','中证500','创业板'].flatMap((group,g)=>[0,1,2].map(i=>({name:`${group} ETF（合成样例）`,thscode:`TEST${g}${i}`,group,sampled:true,mapping:'fixture'})));
 const items=catalog.map((e,i)=>({thscode:e.thscode,ts,turnover:(i+1)*1e8,pct:(i%3-1)*.8,price:1}));
 const prior=items.map((q,i)=>({...q,ts:ts-86400000,turnover:q.turnover/(i<3?1.5:i<6?.7:1)}));
 const b=buildBoard(catalog,[{date:'2026-11-19',slot:'10:00',payload:{items,fetchedAt:ts,previousDate:'2026-11-18'}},{date:'2026-11-18',slot:'10:00',payload:{items:prior,fetchedAt:ts-86400000,previousDate:null}}],ts);
 return <><h2 style={{color:'orange'}}>TEST FIXTURE · 合成数据 · 仅布局验收 · 非生产行情</h2><EtfVolumeBoard initial={b}/></>;
}
PAGE
# No .env files are copied, no production tokens are used.
cd "$preview"
unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY HIVE_API_TOKEN HIVE_ORDER_TOKEN HIVE_SESSION_SECRET HIVE_DASHBOARD_PASSWORD HITHINK_FINANCE_API_KEY
exec "$repo/apps/web/node_modules/.bin/next" dev --hostname 127.0.0.1 -p "${PORT:-3107}"
