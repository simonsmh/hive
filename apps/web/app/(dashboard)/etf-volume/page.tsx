import {loadEtfVolume} from '@/src/modules/etf-volume/query';
import {EtfVolumeBoard} from '@/src/components/dashboard/EtfVolumeBoard';
export const dynamic='force-dynamic';
export const metadata={title:'宽基 ETF 成交观察'};
export default async function Page(){return <EtfVolumeBoard initial={await loadEtfVolume()}/>;}
