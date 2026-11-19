begin;
do $$ begin
 if not (select relrowsecurity from pg_class where oid='public.etf_volume_snapshots'::regclass) then raise exception 'RLS required';end if;
 if has_table_privilege('anon','public.etf_volume_snapshots','INSERT') then raise exception 'anon writes forbidden';end if;
 if has_table_privilege('authenticated','public.etf_volume_snapshots','SELECT') then raise exception 'dashboard reads must stay server-only';end if;
end $$;
insert into public.etf_volume_snapshots(date,slot,payload) values('2000-01-01','10:00','{"fixture":true}');
rollback;
