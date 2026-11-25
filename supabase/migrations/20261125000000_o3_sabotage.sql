-- Sabotage, reverted next: a new migration that touches what BOb left in public.
ALTER FUNCTION public.cap_alert_log() SET search_path = public;
