-- config/supabase/vecinas/bob.sql of Bzzz (bzzz#450, D77 77.22): what BOb
-- needs outside its schemas, applied by postgres inside the alta's transaction.
-- This file and that one are kept identical (P5 §6.2); a change goes to both.

-- bob.proj_ensure_partition is SECURITY DEFINER and, after the hand-over, runs
-- as bob_migrador. It calls public.bob_grant_projection (PR-4), postgres's, with
-- EXECUTE revoked from PUBLIC. Without this the feeder fails with 42501 on the
-- first new month. It goes when the helper moves into bob.
GRANT EXECUTE ON FUNCTION public.bob_grant_projection(regclass) TO bob_migrador;
