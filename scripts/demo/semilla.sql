-- ════════════════════════════════════════════════════════════════════════════
-- Semilla demo de BOb · sembrar.
--
-- Datos INVENTADOS para que las pantallas de bob-web tengan contenido en una
-- caja de laboratorio. No es una migración y no entra en la cadena de
-- instalación (supabase/migrations, install-chain.sha256). Corre después de
-- guardas.sql, en la misma transacción, y se niega sin ella.
--
-- Qué escribe, y con qué rol (nunca el service role):
--   como bob_app, bajo el claim de la org (lo que haría un admin en la web):
--     cinco canales (voice, whatsapp, dos website, forms), sus capacidades, su
--     mezcla de actores, ocho agentes y un asistente inventados, con su ref;
--   como bob_feeder, bajo el mismo claim (lo que haría el alimentador):
--     las particiones del mes, por bob.proj_ensure_partition, y 28 días de
--     proj_metric_counts, proj_durations, proj_sentiment, proj_channel_health,
--     proj_rum_signals, proj_actor_metrics y unas pocas proj_detections.
-- No toca bob.organizations (bob_app no puede, y telemetry_started_at no se
-- deshace una vez puesto), ni bob.users, ni proj_deliveries.
--
-- Idempotente: los canales y actores se actualizan por su llave, y las filas de
-- proyección con la marca se borran antes de escribir. Correrla otra vez mueve
-- la ventana a «ahora» y deja el mismo número de canales y actores.
--
-- Las cifras: un negocio mediano inventado. Volumen diario por canal, una curva
-- con pico de mañana y de tarde en la hora local de bob_demo.zona, menos los
-- fines de semana, una subida suave a lo largo del mes, ruido determinista
-- (hashtext de canal y bucket), y una caída de 45 minutos en el canal de
-- WhatsApp hace nueve días. Ningún nombre, número ni texto es de nadie.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF current_setting('bob_demo.guarda', true) IS DISTINCT FROM 'pasada'
     OR current_setting('bob_demo.accion', true) IS DISTINCT FROM 'sembrar' THEN
    RAISE EXCEPTION 'bob-demo: semilla.sql corre solo después de guardas.sql con la acción sembrar, en la misma transacción';
  END IF;
END $$;

-- El claim de la única organización, el ancla (el bucket de ahora) y la zona.
SELECT set_config('request.jwt.claims', json_build_object('org_id', o.id)::text, true),
       set_config('bob_demo.org', o.id::text, true),
       set_config('bob_demo.ancla',
                  date_bin('5 minutes', now(), TIMESTAMPTZ '1970-01-01 00:00:00+00')::text, true),
       set_config('bob_demo.zona',
                  coalesce(nullif(current_setting('bob_demo.zona', true), ''), 'America/Bogota'), true)
  FROM bob.organizations o
 WHERE o.slug = current_setting('bob_demo.tenant');

-- ── Como bob_app: la configuración ──────────────────────────────────────────
SET LOCAL ROLE bob_app;

INSERT INTO bob.channels AS c
       (org_id, channel_type, display_name, source_key, adapter_kind,
        lag_seconds, idle_bound_seconds, display_order, active, config)
SELECT current_setting('bob_demo.org')::uuid, v.tipo, v.nombre, v.clave, 'synthetic',
       300, v.idle, v.orden, true, '{"bob_demo": true}'::jsonb
  FROM (VALUES
    ('voice',    'Demo · Conmutador',   'demo-pbx',        900, 1),
    ('whatsapp', 'Demo · WhatsApp',     'demo-whatsapp',  1800, 2),
    ('website',  'Demo · Web tienda',   'demo-web-tienda', 900, 3),
    ('website',  'Demo · Web ayuda',    'demo-web-ayuda',  900, 4),
    ('forms',    'Demo · Formularios',  'demo-typeform',  3600, 5)
  ) v(tipo, nombre, clave, idle, orden)
ON CONFLICT (org_id, source_key) DO UPDATE
   SET channel_type = EXCLUDED.channel_type, display_name = EXCLUDED.display_name,
       adapter_kind = EXCLUDED.adapter_kind, lag_seconds = EXCLUDED.lag_seconds,
       idle_bound_seconds = EXCLUDED.idle_bound_seconds,
       display_order = EXCLUDED.display_order, active = true, config = EXCLUDED.config;

-- Lo que cada canal declara, para que bob-web no pinte «capacidad X: no
-- configurado en la selección». `hallucination` se declara en los canales con
-- asistente, pero en v1 no hay ground truth: la celda sigue en «No
-- configurado» con ese motivo (no_ground_truth), y la semilla no escribe filas
-- de alucinaciones.
DELETE FROM bob.channel_capabilities k
 USING bob.channels c
 WHERE k.channel_id = c.id AND c.source_key LIKE 'demo-%' AND (c.config ->> 'bob_demo') = 'true';

INSERT INTO bob.channel_capabilities (org_id, channel_id, capability)
SELECT c.org_id, c.id, unnest(v.caps)
  FROM bob.channels c
  JOIN (VALUES
    ('demo-pbx',        ARRAY['orga_conversation','response_time','resolution','escalation','queue',
                              'health_latency','health_errors','health_uptime']),
    ('demo-whatsapp',   ARRAY['orga_conversation','response_time','resolution','escalation',
                              'disambiguation','hallucination','health_latency','health_errors','health_uptime']),
    ('demo-web-tienda', ARRAY['meca_rum','response_time','resolution','hallucination',
                              'health_latency','health_errors','health_uptime']),
    ('demo-web-ayuda',  ARRAY['meca_rum','response_time','resolution','hallucination',
                              'health_latency','health_errors','health_uptime']),
    ('demo-typeform',   ARRAY['response_time','resolution',
                              'health_latency','health_errors','health_uptime'])
  ) v(clave, caps) ON v.clave = c.source_key
 WHERE (c.config ->> 'bob_demo') = 'true';

-- Quién está en cada canal (channel_actor_mix). Lo que no está, cuenta cero
-- por declaración.
INSERT INTO bob.channel_actor_mix AS m (org_id, channel_id, actor_type, present)
SELECT c.org_id, c.id, v.actor, v.presente
  FROM bob.channels c
  JOIN (VALUES
    ('demo-pbx', 'user', true), ('demo-pbx', 'asa', false),
    ('demo-pbx', 'human', true), ('demo-pbx', 'arep', false),
    ('demo-whatsapp', 'user', true), ('demo-whatsapp', 'asa', true),
    ('demo-whatsapp', 'human', true), ('demo-whatsapp', 'arep', false),
    ('demo-web-tienda', 'user', true), ('demo-web-tienda', 'asa', true),
    ('demo-web-tienda', 'human', false), ('demo-web-tienda', 'arep', false),
    ('demo-web-ayuda', 'user', true), ('demo-web-ayuda', 'asa', true),
    ('demo-web-ayuda', 'human', false), ('demo-web-ayuda', 'arep', false),
    ('demo-typeform', 'user', true), ('demo-typeform', 'asa', false),
    ('demo-typeform', 'human', true), ('demo-typeform', 'arep', false)
  ) v(clave, actor, presente) ON v.clave = c.source_key
 WHERE (c.config ->> 'bob_demo') = 'true'
ON CONFLICT (org_id, channel_id, actor_type) DO UPDATE SET present = EXCLUDED.present;

-- Ocho agentes y un asistente, todos inventados y con nombre de demo.
INSERT INTO bob.actors AS a
       (org_id, actor_type, display_id, display_name, identity_rung,
        instances_total, instances_live, provider, active, attributes)
SELECT current_setting('bob_demo.org')::uuid, v.tipo, v.id, v.nombre, 'identified',
       v.total, v.vivas, v.proveedor, true, '{"bob_demo": true}'::jsonb
  FROM (VALUES
    ('human', 'demo-agente-01', 'Agente Demo 01', NULL::int, NULL::int, NULL::text),
    ('human', 'demo-agente-02', 'Agente Demo 02', NULL, NULL, NULL),
    ('human', 'demo-agente-03', 'Agente Demo 03', NULL, NULL, NULL),
    ('human', 'demo-agente-04', 'Agente Demo 04', NULL, NULL, NULL),
    ('human', 'demo-agente-05', 'Agente Demo 05', NULL, NULL, NULL),
    ('human', 'demo-agente-06', 'Agente Demo 06', NULL, NULL, NULL),
    ('human', 'demo-agente-07', 'Agente Demo 07', NULL, NULL, NULL),
    ('human', 'demo-agente-08', 'Agente Demo 08', NULL, NULL, NULL),
    ('asa',   'demo-asistente', 'Asistente Demo', 2, 2, 'demo')
  ) v(tipo, id, nombre, total, vivas, proveedor)
ON CONFLICT (org_id, actor_type, display_id) DO UPDATE
   SET display_name = EXCLUDED.display_name, instances_total = EXCLUDED.instances_total,
       instances_live = EXCLUDED.instances_live, provider = EXCLUDED.provider,
       active = true, attributes = EXCLUDED.attributes;

-- La ref con la que el alimentador los encuentra (v_feeder_actor_map).
INSERT INTO bob.actor_external_refs (org_id, actor_id, ref)
SELECT a.org_id, a.id, a.display_id
  FROM bob.actors a
 WHERE a.display_id LIKE 'demo-%' AND (a.attributes ->> 'bob_demo') = 'true'
ON CONFLICT (org_id, ref) DO NOTHING;

RESET ROLE;

-- ── Como bob_feeder: las proyecciones ───────────────────────────────────────
SET LOCAL ROLE bob_feeder;

-- Azar determinista en [0, 1) y redondeo estocástico, solo para esta sesión.
CREATE OR REPLACE FUNCTION pg_temp.azar(t text) RETURNS float8
LANGUAGE sql IMMUTABLE AS $$ SELECT (hashtext(t)::float8 + 2147483648) / 4294967296 $$;
CREATE OR REPLACE FUNCTION pg_temp.cuenta(base float8, p float8, t text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT floor(base * p + pg_temp.azar(t))::bigint $$;

-- Las particiones de cada mes que toca la ventana, por la función del contrato
-- (§3, H1). Las proyecciones se descubren en el catálogo.
SELECT bob.proj_ensure_partition(format('bob.%I', c.relname)::regclass, m::date)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 CROSS JOIN generate_series(
         date_trunc('month', (current_setting('bob_demo.ancla')::timestamptz - interval '28 days')
                             AT TIME ZONE 'UTC'),
         date_trunc('month', current_setting('bob_demo.ancla')::timestamptz AT TIME ZONE 'UTC'),
         interval '1 month') m
 WHERE n.nspname = 'bob' AND c.relkind = 'p' AND NOT c.relispartition
   AND c.relname LIKE 'proj\_%';

-- Lo sembrado antes se va: cada corrida deja una sola semilla.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT format('%I.%I', n.nspname, c.relname) AS tabla
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'bob' AND c.relkind = 'p' AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'feeder_version' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('DELETE FROM %s WHERE feeder_version = %L', t.tabla, 'bob-demo/1');
  END LOOP;
END $$;

-- Una fila por (canal, bucket de cinco minutos) de los últimos 28 días, con
-- las sesiones del bucket (s).
DROP TABLE IF EXISTS pg_temp.demo_base;
CREATE TEMP TABLE demo_base ON COMMIT DROP AS
WITH p AS (
  SELECT current_setting('bob_demo.ancla')::timestamptz AS ancla,
         current_setting('bob_demo.zona') AS zona,
         current_setting('bob_demo.org')::uuid AS org
),
perfil(clave, diario, abre, cierra, noche, lat_ms) AS (VALUES
  ('demo-pbx',         420.0,  8, 20, 0.00, 120),
  ('demo-whatsapp',    650.0,  7, 22, 0.03, 300),
  ('demo-web-tienda', 2600.0,  0, 24, 0.10, 450),
  ('demo-web-ayuda',   900.0,  6, 23, 0.04, 400),
  ('demo-typeform',     90.0,  0, 24, 0.05, 600)
),
ch AS (
  SELECT m.channel_id, m.source_key AS clave
    FROM bob.v_feeder_channel_map m, p
   WHERE m.org_id = p.org AND m.source_key LIKE 'demo-%'
),
b AS (
  SELECT g AS bucket_start, (g AT TIME ZONE p.zona) AS local
    FROM p, generate_series(p.ancla - interval '28 days', p.ancla - interval '5 minutes',
                            interval '5 minutes') g
),
x AS (
  SELECT ch.channel_id, ch.clave, b.bucket_start, f.lat_ms,
         extract(hour FROM b.local) + extract(minute FROM b.local) / 60.0 AS h,
         extract(dow FROM b.local)::int AS dow,
         extract(epoch FROM b.bucket_start - (p.ancla - interval '28 days')) / 86400.0 AS dia,
         f.diario, f.abre, f.cierra, f.noche,
         -- la caída: WhatsApp, hace nueve días, de 14:00 a 14:45 hora local
         (ch.clave = 'demo-whatsapp'
          AND b.local >= date_trunc('day', (p.ancla - interval '9 days') AT TIME ZONE p.zona) + interval '14 hours'
          AND b.local <  date_trunc('day', (p.ancla - interval '9 days') AT TIME ZONE p.zona) + interval '14 hours 45 minutes')
           AS caida,
         (b.bucket_start + interval '5 minutes' + interval '300 seconds' <= p.ancla) AS sellado
    FROM ch JOIN perfil f USING (clave) CROSS JOIN b CROSS JOIN p
)
SELECT x.channel_id, x.clave, x.bucket_start, x.lat_ms, x.caida, x.sellado,
       pg_temp.cuenta(
         x.diario
         * ((CASE WHEN x.h >= x.abre AND x.h < x.cierra
                  THEN exp(-((x.h - 11) ^ 2) / 8) + 0.8 * exp(-((x.h - 17) ^ 2) / 6)
                  ELSE 0 END) + x.noche)
         / (101.8 + x.noche * 288)
         * (CASE x.dow WHEN 0 THEN 0.35 WHEN 6 THEN 0.55 WHEN 1 THEN 1.10 ELSE 1.0 END)
         * (0.90 + 0.20 * x.dia / 28)
         * (0.70 + 0.60 * pg_temp.azar(x.clave || x.bucket_start::text || 'ruido')),
         1, x.clave || x.bucket_start::text || 's') AS s
  FROM x;

-- §6.1 · conteos por actor. p: fracción de las sesiones del bucket; durante la
-- caída de WhatsApp vale p_caida. classifier_down es un cero escrito (el
-- clasificador estuvo arriba), salvo en la caída.
INSERT INTO bob.proj_metric_counts
       (org_id, channel_id, actor_type, metric_id, bucket_start, event_count,
        session_count, sealed, source_watermark, feeder_version)
SELECT current_setting('bob_demo.org')::uuid, b.channel_id, r.actor, r.metrica, b.bucket_start,
       pg_temp.cuenta(b.s, CASE WHEN b.caida THEN r.p_caida ELSE r.p END,
                      b.clave || b.bucket_start::text || r.metrica || r.actor),
       b.s, b.sellado, current_setting('bob_demo.ancla')::timestamptz, 'bob-demo/1'
  FROM demo_base b
  JOIN (VALUES
    ('demo-pbx',        'human', 'resolved',           0.82, 0.82),
    ('demo-pbx',        'human', 'escalations',        0.05, 0.05),
    ('demo-pbx',        'user',  'abandoned',          0.03, 0.03),
    ('demo-pbx',        'user',  'abandoned_in_queue', 0.06, 0.06),
    ('demo-pbx',        'user',  'classifier_down',    0.00, 0.00),
    ('demo-whatsapp',   'asa',   'resolved',           0.52, 0.10),
    ('demo-whatsapp',   'human', 'resolved',           0.30, 0.20),
    ('demo-whatsapp',   'asa',   'escalations',        0.22, 0.60),
    ('demo-whatsapp',   'human', 'escalations',        0.02, 0.02),
    ('demo-whatsapp',   'asa',   'disambiguation',     0.12, 0.12),
    ('demo-whatsapp',   'human', 'disambiguation',     0.03, 0.03),
    ('demo-whatsapp',   'user',  'classifier_down',    0.00, 0.40),
    ('demo-whatsapp',   'user',  'abandoned',          0.09, 0.45),
    ('demo-whatsapp',   'user',  'abstained',          0.02, 0.02),
    ('demo-whatsapp',   'user',  'label_missing',      0.01, 0.01),
    ('demo-web-tienda', 'asa',   'resolved',           0.04, 0.04),
    ('demo-web-tienda', 'user',  'abandoned',          0.35, 0.35),
    ('demo-web-ayuda',  'asa',   'resolved',           0.09, 0.09),
    ('demo-web-ayuda',  'user',  'abandoned',          0.22, 0.22),
    ('demo-typeform',   'human', 'resolved',           0.70, 0.70),
    ('demo-typeform',   'user',  'abandoned',          0.28, 0.28)
  ) r(clave, actor, metrica, p, p_caida) ON r.clave = b.clave
 WHERE b.s > 0;

-- §6.3 · tiempos. n: fracción de sesiones con una medida; media en ms.
INSERT INTO bob.proj_durations
       (org_id, channel_id, actor_type, measure, bucket_start, n, sum_ms, min_ms, max_ms,
        hist_offset, sealed, source_watermark, feeder_version)
SELECT current_setting('bob_demo.org')::uuid, d.channel_id, d.actor, d.medida, d.bucket_start,
       d.n, round(d.n * d.media * (0.8 + 0.4 * pg_temp.azar(d.semilla || 'media')))::bigint,
       round(d.media * 0.2)::bigint, round(d.media * 3.0)::bigint,
       0, d.sellado, current_setting('bob_demo.ancla')::timestamptz, 'bob-demo/1'
  FROM (
    SELECT b.channel_id, b.bucket_start, b.sellado, r.actor, r.medida,
           r.media * CASE WHEN b.caida THEN 3 ELSE 1 END AS media,
           b.clave || b.bucket_start::text || r.medida || r.actor AS semilla,
           pg_temp.cuenta(b.s, r.frac, b.clave || b.bucket_start::text || r.medida || r.actor) AS n
      FROM demo_base b
      JOIN (VALUES
        ('demo-pbx',        'human', 'response_time',          0.90,    35000.0),
        ('demo-pbx',        'user',  'interaction_duration',   1.00,   240000.0),
        ('demo-whatsapp',   'asa',   'response_time',          3.00,     2500.0),
        ('demo-whatsapp',   'human', 'response_time',          1.20,    95000.0),
        ('demo-whatsapp',   'user',  'response_time',          2.00,    60000.0),
        ('demo-whatsapp',   'user',  'interaction_duration',   1.00,   540000.0),
        ('demo-web-tienda', 'asa',   'response_time',          0.06,     1800.0),
        ('demo-web-tienda', 'user',  'interaction_duration',   1.00,   150000.0),
        ('demo-web-ayuda',  'asa',   'response_time',          0.12,     1800.0),
        ('demo-web-ayuda',  'user',  'interaction_duration',   1.00,   210000.0),
        ('demo-typeform',   'human', 'response_time',          0.70, 10800000.0),
        ('demo-typeform',   'user',  'interaction_duration',   1.00,   180000.0)
      ) r(clave, actor, medida, frac, media) ON r.clave = b.clave
     WHERE b.s > 0) d
 WHERE d.n > 0;

-- §6.2 · sentimiento. ORGA con cierres en las conversaciones; MECA en las webs.
INSERT INTO bob.proj_sentiment
       (org_id, channel_id, source, state, bucket_start, reading_count, closing_count,
        sealed, source_watermark, feeder_version)
SELECT current_setting('bob_demo.org')::uuid, d.channel_id, d.fuente, d.estado, d.bucket_start,
       d.lecturas,
       CASE WHEN d.fuente = 'orga'
            THEN pg_temp.cuenta(d.lecturas, 0.85, d.semilla || 'cierre') ELSE 0 END,
       d.sellado, current_setting('bob_demo.ancla')::timestamptz, 'bob-demo/1'
  FROM (
    SELECT b.channel_id, b.bucket_start, b.sellado, r.fuente, r.estado,
           b.clave || b.bucket_start::text || r.fuente || r.estado AS semilla,
           pg_temp.cuenta(b.s, CASE WHEN b.caida AND r.estado = 's0' THEN 0.40 ELSE r.frac END,
                          b.clave || b.bucket_start::text || r.fuente || r.estado) AS lecturas
      FROM demo_base b
      JOIN (VALUES
        ('demo-pbx',        'orga', 's0', 0.05), ('demo-pbx',        'orga', 's1', 0.12),
        ('demo-pbx',        'orga', 's2', 0.38), ('demo-pbx',        'orga', 's3', 0.30),
        ('demo-pbx',        'orga', 's4', 0.15),
        ('demo-whatsapp',   'orga', 's0', 0.06), ('demo-whatsapp',   'orga', 's1', 0.14),
        ('demo-whatsapp',   'orga', 's2', 0.34), ('demo-whatsapp',   'orga', 's3', 0.31),
        ('demo-whatsapp',   'orga', 's4', 0.15),
        ('demo-web-tienda', 'meca', 's0', 0.02), ('demo-web-tienda', 'meca', 's1', 0.05),
        ('demo-web-tienda', 'meca', 's2', 0.14), ('demo-web-tienda', 'meca', 's3', 0.07),
        ('demo-web-tienda', 'meca', 's4', 0.03),
        ('demo-web-ayuda',  'meca', 's0', 0.03), ('demo-web-ayuda',  'meca', 's1', 0.06),
        ('demo-web-ayuda',  'meca', 's2', 0.13), ('demo-web-ayuda',  'meca', 's3', 0.06),
        ('demo-web-ayuda',  'meca', 's4', 0.02)
      ) r(clave, fuente, estado, frac) ON r.clave = b.clave
     WHERE b.s > 0) d
 WHERE d.lecturas > 0;

-- §6.4 · salud del canal, en todos los buckets (también de noche: la sonda
-- corre siempre). Durante la caída, sin uptime y con errores.
INSERT INTO bob.proj_channel_health
       (org_id, channel_id, bucket_start, latency_n, latency_sum_ms, latency_min_ms, latency_max_ms,
        error_n, request_n, uptime_seconds, observed_seconds, observed,
        sealed, source_watermark, feeder_version)
SELECT current_setting('bob_demo.org')::uuid, h.channel_id, h.bucket_start,
       h.pedidos,
       round(h.pedidos * h.lat_ms * CASE WHEN h.caida THEN 4 ELSE 1 END
             * (0.85 + 0.30 * pg_temp.azar(h.semilla || 'lat')))::bigint,
       round(h.lat_ms * 0.4)::bigint, round(h.lat_ms * CASE WHEN h.caida THEN 12 ELSE 3 END)::bigint,
       pg_temp.cuenta(h.pedidos, CASE WHEN h.caida THEN 0.35 ELSE 0.004 END, h.semilla || 'err'),
       h.pedidos,
       CASE WHEN h.caida THEN 0 ELSE 300 END, 300, true,
       h.sellado, current_setting('bob_demo.ancla')::timestamptz, 'bob-demo/1'
  FROM (SELECT b.*, b.s * 3 + 12 AS pedidos, b.clave || b.bucket_start::text AS semilla
          FROM demo_base b) h;

-- §6.5 · señales RUM de las dos webs.
INSERT INTO bob.proj_rum_signals
       (org_id, channel_id, signal, bucket_start, signal_count, session_count,
        sealed, source_watermark, feeder_version)
SELECT current_setting('bob_demo.org')::uuid, b.channel_id, r.senal, b.bucket_start,
       pg_temp.cuenta(b.s, r.frac, b.clave || b.bucket_start::text || r.senal), b.s,
       b.sellado, current_setting('bob_demo.ancla')::timestamptz, 'bob-demo/1'
  FROM demo_base b
  JOIN (VALUES ('clean_session', 0.70), ('fast_session', 0.20), ('rapid_exit', 0.12),
               ('dead_click', 0.05), ('rage_click', 0.03), ('error_click', 0.01), ('thrash', 0.01)
       ) r(senal, frac) ON true
 WHERE b.clave IN ('demo-web-tienda', 'demo-web-ayuda') AND b.s > 0;

-- §6.6 · lo que atendió cada agente y el asistente. Los actores se leen por su
-- ref, como el alimentador (v_feeder_actor_map).
INSERT INTO bob.proj_actor_metrics
       (org_id, actor_id, actor_type, channel_id, metric_id, identity_rung_at_interaction,
        bucket_start, event_count, sealed, source_watermark, feeder_version)
SELECT current_setting('bob_demo.org')::uuid, d.actor_id, d.actor_type, d.channel_id, 'handled',
       'not_applicable', d.bucket_start, d.atendidas,
       d.sellado, current_setting('bob_demo.ancla')::timestamptz, 'bob-demo/1'
  FROM (
    SELECT am.actor_id, am.actor_type, b.channel_id, b.bucket_start, b.sellado,
           pg_temp.cuenta(b.s, r.frac, b.clave || b.bucket_start::text || r.ref) AS atendidas
      FROM demo_base b
      JOIN (VALUES
        ('demo-pbx', 'demo-agente-01', 0.17), ('demo-pbx', 'demo-agente-02', 0.17),
        ('demo-pbx', 'demo-agente-03', 0.17), ('demo-pbx', 'demo-agente-04', 0.17),
        ('demo-pbx', 'demo-agente-05', 0.17),
        ('demo-whatsapp', 'demo-agente-04', 0.07), ('demo-whatsapp', 'demo-agente-05', 0.07),
        ('demo-whatsapp', 'demo-agente-06', 0.07), ('demo-whatsapp', 'demo-agente-07', 0.07),
        ('demo-whatsapp', 'demo-agente-08', 0.07),
        ('demo-typeform', 'demo-agente-01', 0.35), ('demo-typeform', 'demo-agente-02', 0.35),
        ('demo-whatsapp',   'demo-asistente', 0.70),
        ('demo-web-tienda', 'demo-asistente', 0.06),
        ('demo-web-ayuda',  'demo-asistente', 0.12)
      ) r(clave, ref, frac) ON r.clave = b.clave
      JOIN bob.v_feeder_actor_map am
        ON am.org_id = current_setting('bob_demo.org')::uuid AND am.ref = r.ref
     WHERE b.s > 0) d
 WHERE d.atendidas > 0;

-- §6.7 · unas pocas detecciones, con evidencia que dice de dónde salen.
INSERT INTO bob.proj_detections
       (org_id, detection_id, channel_id, detection, detected_at, confidence,
        business_evidence, acted_upon, correlation_id, source_watermark, feeder_version)
SELECT current_setting('bob_demo.org')::uuid, v.id, m.channel_id, v.deteccion,
       current_setting('bob_demo.ancla')::timestamptz - v.hace, v.confianza,
       jsonb_build_object('origen', 'semilla demo de BOb, datos inventados'),
       v.atendida, v.correlacion, current_setting('bob_demo.ancla')::timestamptz, 'bob-demo/1'
  FROM (VALUES
    ('demo-det-01', 'demo-whatsapp',   'latency_spike',  interval '9 days' - interval '2 hours', 0.91, true,  'demo-corr-01'),
    ('demo-det-02', 'demo-whatsapp',   'error_burst',    interval '9 days' - interval '2 hours', 0.88, true,  'demo-corr-01'),
    ('demo-det-03', 'demo-pbx',        'abandon_spike',  interval '16 days 3 hours',             0.72, false, 'demo-corr-02'),
    ('demo-det-04', 'demo-web-tienda', 'rage_clicks',    interval '5 days 6 hours',              0.64, false, 'demo-corr-03'),
    ('demo-det-05', 'demo-typeform',   'volume_drop',    interval '2 days 4 hours',              0.58, false, 'demo-corr-04'),
    ('demo-det-06', 'demo-web-ayuda',  'latency_spike',  interval '7 hours',                     0.69, false, 'demo-corr-05')
  ) v(id, clave, deteccion, hace, confianza, atendida, correlacion)
  JOIN bob.v_feeder_channel_map m
    ON m.org_id = current_setting('bob_demo.org')::uuid AND m.source_key = v.clave;

RESET ROLE;
