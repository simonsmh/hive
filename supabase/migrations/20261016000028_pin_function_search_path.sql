-- Security Advisor cleanup: pin search_path on the five plain helper functions the database linter flags
-- (function_search_path_mutable, observed 2026-10-15 via the Management API advisors endpoint).
-- All five are LANGUAGE sql helpers whose bodies only resolve objects in public, so pinning the
-- per-function search_path to 'public' keeps name resolution identical while making the setting
-- immutable for the function. No signatures, bodies, owners or grants change.

alter function public.hive_a_share_session_open(p_at timestamp with time zone) set search_path = public;

alter function public.hive_delivery_policy(p_event_type text, p_kind text) set search_path = public;

alter function public.hive_filter_allows(p_list jsonb, p_value text) set search_path = public;

alter function public.hive_keywords_allow(p_list jsonb, p_text text) set search_path = public;

alter function public.hive_subscription_matches(
  p_filters jsonb,
  p_source text,
  p_severity text,
  p_alert_kind text,
  p_symbol text,
  p_text text
) set search_path = public;
