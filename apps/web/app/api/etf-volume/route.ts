import {authorize,handle,jsonResponse} from '../../../lib/api';
import {loadEtfVolume} from '@/src/modules/etf-volume/query';
export const dynamic='force-dynamic';
export async function GET(request:Request){return handle(async()=>{const denied=await authorize(request);if(denied)return denied;return jsonResponse({board:await loadEtfVolume()});});}
