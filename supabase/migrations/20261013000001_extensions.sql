-- Extensions required by Hive. Targets Supabase Postgres 17 (Supabase project, or the
-- supabase/postgres image used by CI). pgmq, Vault and pg_net are Supabase-provided.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;
create extension if not exists pgmq;
create extension if not exists supabase_vault;
