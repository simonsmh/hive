import 'server-only';
import {getDb} from '@/lib/supabase';
import {buildBoard,type Capture,type Etf} from './model';
import catalog from '../../../../../supabase/functions/etf-volume-collector/catalog.json';
export async function loadEtfVolume(){
 const {data,error}=await getDb().from('etf_volume_snapshots').select('date,slot,payload').order('date',{ascending:false}).order('slot',{ascending:false}).limit(100);
 if(error)throw new Error(error.message);
 return buildBoard(catalog.items as Etf[],(data??[]) as Capture[]);
}
