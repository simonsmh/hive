import {isAuthorized} from './core/auth.ts';
import catalog from './catalog.json' with {type:'json'};
const API='https://fuyao.aicubes.cn';
const shift=(ts:number)=>new Date(ts+28800000).toISOString();
async function ths(path:string){
 const r=await fetch(API+path,{headers:{'X-api-key':Deno.env.get('HITHINK_FINANCE_API_KEY')??''},signal:AbortSignal.timeout(8000)});
 const d=await r.json();if(!r.ok||d.code!==0)throw Error(`THS ${d.code??r.status}: ${d.message??'error'}`);return d.data;
}
async function db(path:string,method='GET',body?:unknown){
 const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
 const r=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/'+path,{method,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error(`DB ${r.status}: ${(await r.text()).slice(0,160)}`);return method==='GET'?await r.json():null;
}
Deno.serve(async(req)=>{
 if(req.method!=='POST')return new Response('POST required',{status:405});
 if(!isAuthorized(req.headers.get('authorization'),Deno.env.get('EDGE_CRON_SECRET')))return new Response('unauthorized',{status:401});
 try{
  const now=Date.now(), local=shift(now), date=local.slice(0,10), hm=local.slice(11,16);
  // A single post-close tick captures the actual close. No overnight/auction polling.
  if(hm<'09:30'||hm>'15:10'||(hm>'11:40'&&hm<'13:00'))return Response.json({status:'outside_session'});
  const cal=await ths('/api/a-share/calendar/trading-days');
  const days=cal.item.map((x:{date:string})=>x.date.includes('-')?x.date:x.date.slice(0,4)+'-'+x.date.slice(4,6)+'-'+x.date.slice(6)).sort();
  if(!days.includes(date))return Response.json({status:'non_trading_day'});
  const previousDate=days.filter((d:string)=>d<date).at(-1)??null;
  const slot=hm>'15:00'?'15:00':hm>'11:30'&&hm<'13:00'?'11:30':hm;
  const items:unknown[]=[];let errors=0;
  const targets=catalog.items.filter(e=>e.sampled);let next=0;
  const run=async()=>{while(next<targets.length){const e=targets[next++];try{
   const data=await ths('/api/fund/market/snapshot?thscode='+encodeURIComponent(e.thscode));
   const q=data.item?.[0];const ts=data.timestamp;
   if(!q||typeof ts!=='number'||shift(ts).slice(0,10)!==date)throw Error('missing or prior-day quote');
   const h=shift(ts).slice(11,16); const effective=h>'15:00'?Date.parse(date+'T15:00:00+08:00'):h>'11:30'&&h<'13:00'?Date.parse(date+'T11:30:00+08:00'):ts;
   items.push({thscode:e.thscode,ts:effective,rawSourceTs:ts,turnover:typeof q.turnover==='number'?q.turnover:null,pct:typeof q.price_change_ratio_pct==='number'?q.price_change_ratio_pct:null,price:typeof q.last_price==='number'?q.last_price:null});
  }catch(e){errors++;console.warn(String(e).slice(0,180));}}};
  await Promise.all([run(),run()]);
  if(items.length===0)throw Error('No valid ETF snapshots');
  await db('etf_volume_snapshots','POST',{date,slot,payload:{items,previousDate,fetchedAt:Date.now(),errors}});
  // Bounded 20-calendar-day retention, a few hundred compact rows, never candles.
  const cutoff=shift(now-20*86400000).slice(0,10);
  await db('etf_volume_snapshots?date=lt.'+cutoff,'DELETE');
  return Response.json({status:'ok',date,slot,count:items.length,errors,previousDate,durationMs:Date.now()-now});
 }catch(e){console.error(String(e));return Response.json({error:String(e).slice(0,250)},{status:500});}
});
