-- Sabotage, reverted next: dated inside the install chain, touches public.
ALTER FUNCTION public.cap_alert_log() SET search_path = public;
