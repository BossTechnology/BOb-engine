# BOb v1 · When a migration fails in a window — procedure

**Status: written for D62 (P5), before the signature.** It is the second of
the two things Federico asked for before the first window (P5 inputs §6.2),
and the procedure that objection 2 settled (P5 inputs §8): fix forward first;
if that is not enough, restore `bob` alone and rebuild the projections.
`auth` is never touched because of BOb.

**What it rests on.** The rehearsal script `scripts/ensayo-migracion-lab.sh`,
run end to end on 2026-11-20 against a local copy of lab-02's identity stack
(the same `supabase/postgres:17.6.1.136` and `gotrue:v2.189.0` digests as
Bzzz `compose/l6-supabase.yml`, with CLI 2.120.0). Every statement marked
**measured** comes from that run. **Run on lab-02 on 2026-11-21** (P5 §8,
objection 5), from BOb-engine `5e5b9be` (33 migrations, before Slice 3):
41 checks, all as expected. It contradicted no measured line here. Its
redacted evidence is in Bzzz `evidence/ENSAYO/`.

**Who.** Henry, or someone he authorizes, in a window announced to the
company. Never an agent and never a running service (P5 §6.2).

---

## 1 · What a failed `supabase db push` leaves — measured

- The push stops at the failing file and exits non-zero. The error is in the
  CLI's output (`DbPushApplyError`, with the SQL state and the statement).
- Every file before it is applied and recorded in
  `supabase_migrations.schema_migrations`. The failing file is **not**
  recorded, and nothing after it runs.
- **The failing file leaves nothing behind, wrapped or not.** CLI 2.120.0
  runs each file as one transaction. A rigged file without `BEGIN … COMMIT`,
  placed among the nine old unwrapped ones, created a table and then raised:
  the table was gone afterwards. A rigged file wrapped in `BEGIN … COMMIT`,
  inside Slice 2, did the same. So P5 §6.2's worry about the nine unwrapped
  files does not arise at failure time. It would arise again with another
  CLI version, which is why the rehearsal checks it every time it runs.
- `auth.users` and the shape of `auth` were identical before and after every
  push.

**So no failed file needs undoing by hand.** The box is at "every file before
the failing one", exactly as `schema_migrations` says.

---

## 2 · Decide which way, before touching anything

| The situation | The way |
|---|---|
| A file failed. `schema_migrations` stops just before it | **A · fix forward** |
| Every file applied, but one did damage: lost or wrong rows in BOb's configuration or live state | **B · restore `bob` alone**, then fix forward |
| Every file applied, and only the projections are wrong | **Neither.** Rebuild the projections with the feeder (§4.6) |
| Anything in `auth` looks wrong | **Stop. It is not BOb's.** Bzzz `docs/OPERACION_restaurar_identidad.md`, decided apart |

What is never done because of BOb:
- `scripts/restore.sh --restaurar` (it restores ClickHouse only) or a restore
  of `supabase_identidad.sql.gz`. Either would take the portal's accounts
  back to the night before.
- Editing or deleting rows of `schema_migrations` to make a failure look
  applied.
- Running the test suite against the box: it loads and deletes a fixture.
- `GRANT <role> TO current_user` on the box's image. It terminates the whole
  Postgres server, the portal's logins with it (F-35). Name the role.

---

## 3 · A · Fix forward

1. **Stop the window there.** Nothing else is applied to that box, and the
   next box in the order (lab-02, then model-01, then Febor) waits.
2. **Read the state.** Save the CLI's output. Read `schema_migrations`
   against the files of the pinned commit: it holds every version before the
   failing one, and none after it.
3. **Write the fix in BOb-engine, as a pull request with four green checks.**
   - **The file failed on lab-02, the first box.** It was recorded nowhere
     shared, so the fix corrects that file. CI applies it from an empty
     database; lab-02 applies it from where it stopped.
   - **The file failed on model-01 or Febor after lab-02 applied it.** It ran
     on lab-02, so it is not edited (append-only). The cause is a difference
     between the boxes. A new migration removes that difference. Its version
     goes between the last version the failing box applied and the failing
     file, so that it runs first there. On lab-02 it is older than what is
     applied, so it goes with `--include-all` and must do nothing on a box
     that is already right. *Not rehearsed.*
4. **Apply with the same step**: `scripts/instalar-bob.sh resto` (O-3, P5
   §6.2), which applies every unrecorded file as `bob_migrador` whatever its
   date, from the alta's credential in `/opt/bob/secrets/migrador.env`. The
   CLI's `supabase db push` cannot run as `bob_migrador`.
5. **Check after**: `schema_migrations` holds exactly the pinned commit's
   versions (F-15), and the read-only role guards of P5 §6.3 that need no
   fixture.
6. **Record it** in `Documentation/contract-amendments.md`, with the CLI
   output, redacted.

---

## 4 · B · Restore `bob` alone, then rebuild

Only when a migration that applied did damage that a new migration cannot
undo, because the rows it lost exist only in the dump.

### 4.1 · What the dump is — measured

Bzzz `scripts/backup.sh` writes `bob.sql.gz` beside the identity dump:

```bash
docker exec bzzz-supabase-db pg_dump -U supabase_admin -d postgres -n bob --exclude-table-data='bob.proj_*'
```

- Schema `bob`, every object in it, their owners and grants, and every row
  except those of the eight projections and their partitions.
- Verified by effect each night: each table's rows in the dump are counted
  against the live table. The manifest says `postgres:bob tablas=N filas=M
  publicaciones=K archivo=bob.sql.gz`, or `postgres:bob no-aplica` on a box
  without BOb.
- **It does not carry the publication membership** (F-36). `backup.sh`
  writes it to `bob_publicaciones.txt` beside the dump.
- It does not carry `supabase_migrations` either: the record of what was
  applied stays where it is.

**Take one at the start of every window**, by running `backup.sh` and
reading its `postgres:bob` line. The nightly one may be a day old.

### 4.2 · Before the restore

- Stop what writes to `bob`: the BOb container and the feeder.
- **Do not stop GoTrue.** Logins keep working, and since 20261121130000 no
  trigger on `auth.users` writes `bob` (GoTrue invites no longer touch it).
  But `scripts/provision-user.mjs`, the one writer of `bob.users`, fails while
  `bob` is gone. **No provisioning during the restore.**
- Note what is in `auth.users` now: its count only.

### 4.3 · Drop and restore — measured

```bash
mkdir -p <ventana>/dependientes
scripts/bob-dependientes.sh --contenedor bzzz-supabase-db --guardar <ventana>/dependientes
docker exec -i bzzz-supabase-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -c 'SET client_min_messages = notice' -c 'DROP SCHEMA bob CASCADE' </dev/null
gunzip -c <respaldo>/bob.sql.gz \
  | docker exec -i bzzz-supabase-db psql -X -q -1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1
scripts/bob-dependientes.sh --contenedor bzzz-supabase-db --reponer <ventana>/dependientes
while read -r pub tabla; do
  docker exec bzzz-supabase-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER PUBLICATION $pub ADD TABLE $tabla" </dev/null
done < <respaldo>/bob_publicaciones.txt
```

- **Save what lives outside `bob` and depends on it, first (F-47).** The
  CASCADE also drops any object outside `bob` that depends on a `bob` object,
  and `bob.sql.gz` does not carry it back. Today these are functions in
  `public`: `bob_outbox_drain` returns a `bob` type, and functions written
  with `BEGIN ATOMIC` over `bob` tables depend on them too. The script finds
  them in `pg_depend`, transitively, and writes into the window's directory
  their definitions as the box has them now: `pg_dump --schema-only` of their
  schema, filtered with `pg_restore -L` to their CREATE, owner, grants and
  comments. Recreated as the superuser, an object would also pick up the
  default privileges of `public`, so the file resets each one's ACL before
  the dumped grants. Read `dependientes.sql` before the drop. If the script names an
  object it cannot bring back (`otro|…`), it stops: decide that one by hand.
- **Read the CASCADE's list.** Every line outside `bob` must be one the
  script saved, no more and no fewer. Measured on `main` with Slice 6: 49
  objects, one of them outside `bob`, `public.bob_outbox_drain(integer)`,
  the one the script had saved.
- **After `bob.sql.gz`, put them back**, in one transaction, before the
  publications. Measured: the fingerprint of `public`, their ACLs included,
  identical to before the damage.
- **The restore runs as `supabase_admin`, in one transaction, stopping at the
  first error.** As the role that took the dump, the way the identity is
  restored. If it fails, nothing of `bob` is left half-made: run it again
  after reading the error.
- **Measured afterwards, identical to before the damage**: owners, grants,
  default privileges, the definer views (`v_feeder_channel_map`,
  `v_feeder_actor_map`, `security_invoker=false`), the `SECURITY DEFINER`
  functions (`bob.proj_ensure_partition`),
  policies, triggers, constraints, indexes, sequences and comments; every
  row outside `proj_*`. As `bob_feeder`, the channel map answers for both
  tenants and `bob.channels` refuses.
- The projections come back as empty tables, with their partitions.

### 4.4 · `schema_migrations` after a restore — not rehearsed

The rehearsal restored `bob` at the version it was dumped at. In a real case
the dump predates the window, and `schema_migrations` still lists what the
window applied. Then:

- the rows for the versions the dump does not have are removed, and only
  those, by hand, recorded in the evidence;
- the fix-forward of §3 applies them again, corrected.

The lab-02 rehearsal does not cover this. It is the one step of this file
written from reading alone.

### 4.5 · Accounts made after the dump

`bob.users` is written only by `scripts/provision-user.mjs`. An account
provisioned between the dump and the restore exists in `auth` and not in
`bob.users`. List them by id (`auth.users` minus `bob.users`), read-only on
`auth`, and run `provision-user.mjs` again for each, once `bob` is back.
*Not rehearsed.*

### 4.6 · Rebuild the projections — measured

The projections are derived from ClickHouse, and the feeder rewrites any
window it is given (contract §8.5). Today that is the reference feeder over
its in-memory truth store, as the rehearsal does it. Once 3.7 holds
`bob_feeder`, it is 3.7 over the thirteen months of retention.

Measured: the rebuilt projections were identical, row for row, to the ones
before the damage (`computed_at` aside).

### 4.7 · After

- Count against the manifest's `postgres:bob` line.
- Start the BOb container and the feeder.
- `auth.users`: the same count as in §4.2.
- Record it, as in §3.6.

---

## 5 · The rehearsal, and how to run it again

`scripts/ensayo-migracion-lab.sh` measures everything this file marks
measured. Henry runs it on lab-02, `--dry-run` first. Its evidence is
redacted (no password, no address, no e-mail, no row) and ready for Bzzz
`evidence/ENSAYO/`. `scripts/ensayo-migracion-lab/probar-local.sh` runs it
on a disposable local copy and sees each of its checks fail on purpose.
