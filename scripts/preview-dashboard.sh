#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
preview=$(mktemp -d /tmp/hive-workspace-preview.XXXXXX)
mkdir -p "$preview/app/[[...route]]" "$preview/src/components/dashboard" "$preview/src/modules"
ln -s "$repo/apps/web/node_modules" "$preview/node_modules"
cp "$repo/apps/web/app/globals.css" "$preview/app/globals.css"
cp "$repo/apps/web/src/components/dashboard/"{DashboardNav,PanelFrame,EtfVolumeBoard}.tsx "$preview/src/components/dashboard/"
cp "$repo/apps/web/src/modules/registry.ts" "$preview/src/modules/"
mkdir -p "$preview/src/modules/etf-volume"
cp "$repo/apps/web/src/modules/etf-volume/model.ts" "$preview/src/modules/etf-volume/"
cat > "$preview/package.json" <<'JSON'
{"private":true,"dependencies":{"next":"15.5.27","react":"19.0.0","react-dom":"19.0.0"}}
JSON
cat > "$preview/tsconfig.json" <<'JSON'
{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./*"]},"jsx":"preserve","esModuleInterop":true,"moduleResolution":"bundler","resolveJsonModule":true,"plugins":[{"name":"next"}]},"include":["**/*.tsx","**/*.ts"]}
JSON
cat > "$preview/app/layout.tsx" <<'PAGE'
import './globals.css';
import {DashboardNav,DashboardContext} from '@/src/components/dashboard/DashboardNav';
import {getNavItems} from '@/src/modules/registry';
export default function Layout({children}:any){const items=getNavItems();return <html lang="zh-CN"><body><div className="app-shell"><header className="topbar"><a className="brand" href="/">Hive · TEST</a><span className="muted">隔离预览</span></header><DashboardNav items={items} variant="tabbar"/><aside className="sidebar"><a className="brand" href="/">Hive · TEST</a><span className="muted">合成布局样例 / 无生产连接</span><DashboardNav items={items} variant="sidebar"/></aside><div className="content"><div className="error">TEST FIXTURE · 无生产凭据、无行情请求、无交易操作。页面状态仅用于界面验收。</div><DashboardContext/><main>{children}</main></div></div></body></html>}
PAGE
cat > "$preview/app/[[...route]]/page.tsx" <<'PAGE'
import {ModuleLink as Link} from '@/src/components/dashboard/DashboardNav';
import {PANELS,groupNavItems} from '@/src/modules/registry';
import {PanelFrame,EmptyState,ErrorState} from '@/src/components/dashboard/PanelFrame';
import {EtfVolumeBoard} from '@/src/components/dashboard/EtfVolumeBoard';
import {buildBoard} from '@/src/modules/etf-volume/model';
export const dynamic='force-dynamic';
export default async function Page({params,searchParams}:any){
 const {route=[]}=await params;const q=await searchParams;const id=route[0];const panel=PANELS.find(p=>p.id===id);
 // Deliberate synthetic wait, never claimed to measure production performance.
 if(id==='news') await new Promise(r=>setTimeout(r,1500));
 if(!id)return <PanelFrame title="功能目录" subtitle="TEST：仅展示真实模块目录，不连接生产数据。">{groupNavItems().map(g=><section key={g.id}><h2>{g.title}</h2><ul className="catalog">{g.items.map(p=><li key={p.id}><Link href={p.href} className="catalog-card"><strong>{p.title}</strong><span>{p.summary}</span></Link></li>)}</ul></section>)}</PanelFrame>;
 if(q.state==='error')return <PanelFrame title={panel?.title??'未知模块'}><ErrorState message="TEST：模拟读取失败，未确认更新"/></PanelFrame>;
 if(id==='etf-volume') {const ts=Date.parse('2026-11-19T02:00:00Z');const catalog=['沪深300','科创50','中证500','创业板'].flatMap((group,g)=>[0,1,2].map(i=>({name:`${group} ETF（合成样例）`,thscode:`TEST${g}${i}`,group,sampled:true,mapping:'fixture'})));const items=catalog.map((e,i)=>({thscode:e.thscode,ts,turnover:(i+1)*1e8,pct:(i%3-1)*.8,price:1}));const prior=items.map((q,i)=>({...q,ts:ts-86400000,turnover:q.turnover/(i<3?1.5:i<6?.7:1)}));return <EtfVolumeBoard initial={buildBoard(catalog,[{date:'2026-11-19',slot:'10:00',payload:{items,fetchedAt:ts,previousDate:'2026-11-18'}},{date:'2026-11-18',slot:'10:00',payload:{items:prior,fetchedAt:ts-86400000,previousDate:null}}],ts)}/>;}
 return <PanelFrame title={panel?.title??'未知模块'} subtitle={panel?.summary}><EmptyState title="TEST：隔离样例未连接该模块数据" hint="保留生产原有模块组件与操作；此预览仅验收共享导航、标题和空态，不验证生产业务。"/><p className="muted">查询参数：{JSON.stringify(q)}</p><Link href={`/${id}?state=error`}>查看错误态</Link>{id==='news'&&<p className="muted">TEST：本路由人为等待1500ms，用于检查切换期间上一页保留与加载反馈。</p>}</PanelFrame>;
}
PAGE
cd "$preview"
# An environment allowlist, not an incomplete secret denylist.
exec env -i PATH="$PATH" HOME="$preview" NEXT_TELEMETRY_DISABLED=1 "$repo/apps/web/node_modules/.bin/next" dev --hostname 0.0.0.0 -p "${PORT:-3108}"
