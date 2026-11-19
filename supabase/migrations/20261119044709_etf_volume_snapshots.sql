create table if not exists public.etf_volume_snapshots (
 date date not null,
 slot text not null check(slot ~ '^\d{2}:\d{2}$'),
 payload jsonb not null,
 primary key(date,slot)
);
alter table public.etf_volume_snapshots enable row level security;
revoke all on public.etf_volume_snapshots from anon,authenticated;
grant select,insert,update,delete on public.etf_volume_snapshots to service_role;
do $m$
begin
 if exists(select 1 from cron.job where jobname='hive-etf-volume-collector') then
  perform cron.alter_job((select jobid from cron.job where jobname='hive-etf-volume-collector'),schedule:='*/10 1-7 * * 1-5');
 else
  perform cron.schedule('hive-etf-volume-collector','*/10 1-7 * * 1-5',$job$select public.hive_invoke_edge_function('etf-volume-collector')$job$);
 end if;
end $m$;
-- Rollback operationally: cron.alter_job(jobid,active:=false) for this job only.
-- Keep accumulated baselines; do not delete history to roll back the page.
