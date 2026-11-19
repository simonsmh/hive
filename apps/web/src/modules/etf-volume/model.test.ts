import {describe,it,expect} from 'vitest';
import {buildBoard,volumeLabel,type Etf,type Capture} from './model';
const cat:Etf[]=['a','b'].map(thscode=>({thscode,name:thscode,group:'test',sampled:true,mapping:'fixture'}));
const ts=Date.parse('2026-11-19T02:00:00Z');
function captures():Capture[]{return [{date:'2026-11-19',slot:'10:00',payload:{previousDate:'2026-11-18',fetchedAt:ts,items:[{thscode:'a',ts,turnover:200,pct:1,price:1},{thscode:'b',ts,turnover:300,pct:-1,price:1}]}},{date:'2026-11-18',slot:'10:00',payload:{previousDate:null,fetchedAt:ts-86400000,items:[{thscode:'a',ts:ts-86400000,turnover:100,pct:0,price:1},{thscode:'b',ts:ts-86400000,turnover:300,pct:0,price:1}]}}];}
describe('same-time cumulative turnover',()=>{
 it('ratio of sums, not arithmetic mean of ratios',()=>{const b=buildBoard(cat,captures(),ts);expect(b.total.ratio).toBe(1.25);expect(b.total.up).toBe(1);expect(b.total.down).toBe(1);});
 it('missing baseline is null not 0/1',()=>{expect(buildBoard(cat,captures().slice(0,1),ts).total.ratio).toBeNull();});
 it('does not divide half-day by full-day',()=>{const c=captures();c[1]!.payload.items.forEach(x=>x.ts+=5*3600000);expect(buildBoard(cat,c,ts).total.comparable).toBe(0);});
 it('absent matched baseline amounts stay null',()=>{const b=buildBoard(cat,captures().slice(0,1),ts);expect(b.total.current).toBeNull();expect(b.total.baseline).toBeNull();});
 it('zero turnover cannot create division by zero',()=>{const c=captures();c[1]!.payload.items.forEach(x=>x.turnover=0);expect(buildBoard(cat,c,ts).total.ratio).toBeNull();});
 it('uses source timestamps, stale quotes excluded',()=>{expect(buildBoard(cat,captures(),ts+20*60000).total.comparable).toBe(0);});
 it('explicit transparent volume thresholds',()=>{expect(volumeLabel(1.1)).toBe('放量');expect(volumeLabel(.9)).toBe('缩量');expect(volumeLabel(1)).toBe('持平');});
 it('same comparable component set only',()=>{const c=captures();c[1]!.payload.items.pop();const b=buildBoard(cat,c,ts);expect(b.total.ratio).toBe(2);expect(b.total.comparable).toBe(1);});
 it('previous trading day explicitly supplied across weekend',()=>{const c=captures();c[0]!.payload.previousDate='2026-11-13';expect(buildBoard(cat,c,ts).total.ratio).toBeNull();});
});
