export interface Etf { thscode:string; name:string; group:string; sampled:boolean; mapping:string }
export interface Quote { thscode:string; ts:number; turnover:number|null; pct:number|null; price:number|null }
export interface Capture { date:string; slot:string; payload:{items:Quote[]; previousDate:string|null; errors?:number; fetchedAt:number} }
export const clock=(ts:number)=>new Date(ts+28800000).toISOString().slice(11,19);
export const day=(ts:number)=>new Date(ts+28800000).toISOString().slice(0,10);
export function volumeLabel(r:number|null){ return r===null?'待积累 / 不可比':r>=1.1?'放量':r<=0.9?'缩量':'持平'; }
export function comparisonStatus(comparable:number,sampled:number,missingBaseline:number){
 if(sampled===0)return '尚无采集样本';
 if(comparable===sampled)return '采集样本全部同刻可比';
 if(comparable>0)return `部分可比：${comparable} 只可比，${sampled-comparable} 只暂不可比；量比仅统计可比集合`;
 return missingBaseline>0?`暂无同刻可比：${missingBaseline} 只缺上个交易日同刻历史基线`:'暂无同刻可比：请查看快照、源时效与成交额覆盖';
}
export function buildBoard(catalog:Etf[], captures:Capture[], now=Date.now()){
 const latest=[...captures].sort((a,b)=>b.date.localeCompare(a.date)||b.slot.localeCompare(a.slot))[0];
 const current=latest?.payload.items??[]; const previousDate=latest?.payload.previousDate??null;
 const baselines=captures.filter(c=>c.date===previousDate).flatMap(c=>c.payload.items);
 const rows=catalog.map(e=>{
  const q=current.find(q=>q.thscode===e.thscode);
  const prior=q?baselines.filter(b=>b.thscode===e.thscode && Math.abs((b.ts+28800000)%86400000-(q.ts+28800000)%86400000)<=60000).sort((a,b)=>Math.abs((a.ts%86400000)-(q.ts%86400000))-Math.abs((b.ts%86400000)-(q.ts%86400000)))[0]:undefined;
  const fresh=!!q && day(q.ts)===latest?.date && (day(now)!==latest?.date || now-q.ts<900000 || (clock(now)>='11:30:00'&&clock(now)<'13:00:00'&&clock(q.ts)>='11:29:00') || (clock(now)>='15:00:00'&&clock(q.ts)>='14:59:00'));
  const comparable=e.sampled && fresh && q?.turnover!=null && q.turnover>0 && prior?.turnover!=null && prior.turnover>0;
  const ratio=comparable?q!.turnover!/prior!.turnover!:null;
  const reason=!e.sampled?'not_sampled':!q?'no_snapshot':!fresh?'stale_snapshot':q.turnover==null||q.turnover<=0?'invalid_current_turnover':!previousDate?'unknown_baseline_date':!prior?'missing_baseline':prior.turnover==null||prior.turnover<=0?'invalid_baseline_turnover':'comparable';
  return {...e, reason, quote:q??null, baseline:prior??null, ratio, fresh, label:volumeLabel(ratio)};
 });
 function aggregate(items:typeof rows){
  const paired=items.filter(x=>x.ratio!==null); const a=paired.reduce((n,x)=>n+x.quote!.turnover!,0), b=paired.reduce((n,x)=>n+x.baseline!.turnover!,0);
  const ratio=b>0?a/b:null; const quoted=items.filter(x=>x.sampled&&x.quote&&x.fresh);
  const priced=quoted.filter(x=>x.quote!.pct!==null&&(x.quote!.turnover??0)>0); const priceWeight=priced.reduce((n,x)=>n+x.quote!.turnover!,0);
  const sampled=items.filter(x=>x.sampled).length;
  const reasons={unknownBaselineDate:items.filter(x=>x.reason==='unknown_baseline_date').length,noSnapshot:items.filter(x=>x.reason==='no_snapshot').length,staleSnapshot:items.filter(x=>x.reason==='stale_snapshot').length,invalidCurrentTurnover:items.filter(x=>x.reason==='invalid_current_turnover').length,missingBaseline:items.filter(x=>x.reason==='missing_baseline').length,invalidBaselineTurnover:items.filter(x=>x.reason==='invalid_baseline_turnover').length};
  return {sampled,reasons,uncomparable:sampled-paired.length,comparisonStatus:comparisonStatus(paired.length,sampled,reasons.missingBaseline),pricePct:priceWeight>0?priced.reduce((n,x)=>n+x.quote!.turnover!*x.quote!.pct!,0)/priceWeight:null,ratio,label:volumeLabel(ratio),comparable:paired.length,current:paired.length?a:null,baseline:paired.length?b:null,coverage:quoted.length,count:items.length,up:quoted.filter(x=>x.quote!.pct!==null&&x.quote!.pct!>0).length,down:quoted.filter(x=>x.quote!.pct!==null&&x.quote!.pct!<0).length,flat:quoted.filter(x=>x.quote!.pct===0).length,turnover:quoted.length?quoted.reduce((n,x)=>n+(x.quote!.turnover??0),0):null};
 }
 return {date:latest?.date??null,previousDate,slot:latest?.slot??null,fetchedAt:latest?.payload.fetchedAt??null,errors:latest?.payload.errors??0,archived:!!latest&&latest.date!==day(now),total:aggregate(rows),rows,groups:[...new Set(catalog.map(e=>e.group))].map(name=>({name,...aggregate(rows.filter(e=>e.group===name)),rows:rows.filter(e=>e.group===name)}))};
}
export type EtfBoard=ReturnType<typeof buildBoard>;
