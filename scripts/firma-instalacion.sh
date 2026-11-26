#!/bin/bash -p
# Henry's signature over what installs BOb on a box (O-3, P5 §6.2). One
# self-contained file, so that the copy that protects a box lives outside the
# repository: /opt/bob/bin/firma-instalacion, root's, installed once.
#
#   firma-instalacion.sh huella <rev> [<repo>] [--lista]
#       The digest of the whole tree at <rev>, read from git objects (never the
#       working tree, the index or .gitattributes). --lista prints one line per
#       file: mode, path, sha256 of the bytes.
#   firma-instalacion.sh mensaje <digest-base> <digest-nuevo>
#       The exact text Henry signs: the pair, so an old signature cannot bring
#       back a state already signed once.
#   firma-instalacion.sh verificar <firmantes> <mensaje> <firma>
#       Checks the signature against an allowed_signers file.
#   sudo /opt/bob/bin/firma-instalacion caja <repo> <commit> cadena|resto [VAR=value …]
#       On a box, as root. See caja() below. The connection settings go as
#       arguments (POSTGRES_ENV=…), never through sudo's environment: no
#       SETENV in sudoers for this command.
#   firma-instalacion.sh caja-prueba <raiz> <repo> <commit> cadena|resto [VAR=value …]
#       The same, never as root, with <raiz> for /opt/bob and any listed key
#       accepted: only for tests/install-approval.test.mjs.
#
# The digest covers every file of the tree, by mode, path and sha256, except
# supabase/provision/aprobaciones/, where approvals go (adding one does not
# change what it approves). A symlink (120000), a submodule (160000) or a path
# outside [A-Za-z0-9_./-] anywhere in the tree is refused.
set -euo pipefail
NS=bob-install-chain
EXCLUIDO=supabase/provision/aprobaciones/
PATH_FIJO=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin
PASAN="POSTGRES_ENV POSTGRES_HOST POSTGRES_PORT MIGRADOR_ENV MIGRADOR_PUERTO"
fail() { echo "firma-instalacion: $1" >&2; exit 1; }
WORK=""; trap '[ -z "$WORK" ] || rm -rf "$WORK"' EXIT
# git, with nothing from a repository's config or hooks that runs code.
G() { git -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.untrackedCache=false \
          -c safe.directory='*' -c protocol.file.allow=always -c color.ui=never "$@"; }
if command -v sha256sum >/dev/null; then sha() { sha256sum | cut -d' ' -f1; }; else sha() { shasum -a 256 | cut -d' ' -f1; }; fi

# extraer <git-dir> <rev> <dir> <lista>: writes every covered file of <rev>
# into <dir>, byte for byte from its blob, and <lista> with one line per file,
# sorted. The bytes hashed are the bytes written.
extraer() {
  local gd=$1 rev=$2 dir=$3 lista=$4 commit rec meta path mode type obj n=0 h
  local re='^[A-Za-z0-9_.][A-Za-z0-9_./-]*$'
  commit=$(G --git-dir="$gd" rev-parse -q --verify "$rev^{commit}") || fail "no commit $rev"
  G --git-dir="$gd" ls-tree -r -z --full-tree "$commit" > "$dir.tree" || fail "cannot read the tree of $rev"
  mkdir -p "$dir"; : > "$lista.u"
  while IFS= read -r -d '' rec; do
    meta=${rec%%$'\t'*}; path=${rec#*$'\t'}
    case "$path" in "$EXCLUIDO"*) continue ;; esac
    [[ "$path" =~ $re ]] || fail "a path outside [A-Za-z0-9_./-], refused: $path"
    case "/$path/" in */../*|*/./*|*//*|*/.git/*) fail "path refused: $path" ;; esac
    read -r mode type obj <<<"$meta"
    case "$mode" in 100644|100755) ;; *) fail "mode $mode refused (symlink or submodule): $path" ;; esac
    [ "$type" = blob ] || fail "not a file, refused: $path"
    mkdir -p "$dir/$(dirname "$path")"
    G --git-dir="$gd" cat-file blob "$obj" > "$dir/$path" || fail "cannot read $path"
    if [ "$mode" = 100755 ]; then chmod 755 "$dir/$path"; else chmod 644 "$dir/$path"; fi
    h=$(sha < "$dir/$path") || fail "cannot hash $path"
    printf '%s %s %s\n' "$mode" "$path" "$h" >> "$lista.u"
    n=$((n + 1))
  done < "$dir.tree"
  [ "$n" -gt 0 ] || fail "the tree of $rev is empty"
  LC_ALL=C sort "$lista.u" > "$lista"
}

huella() {
  local rev=$1 repo=${2:-.} lista=${3:-} gd t
  gd=$(G -C "$repo" rev-parse --absolute-git-dir) || fail "$repo is not a git repository"
  WORK=$(mktemp -d); t=$WORK
  extraer "$gd" "$rev" "$t/arbol" "$t/lista"
  if [ "$lista" = --lista ]; then cat "$t/lista"; else sha < "$t/lista"; fi
}

mensaje() {
  [[ "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[0-9a-f]{64}$ ]] || fail "two digests"
  printf '%s 1\nbase %s\nnueva %s\n' "$NS" "$1" "$2"
}

# verificar <firmantes> <mensaje> <firma> [relajado]: relajado (caja-prueba
# only) accepts a key that is not a security key, so tests can sign.
verificar() {
  local signers=$1 msg=$2 sig=$3 relajado=${4:-} keys=0 line principal options keytype key principals out p
  [ -f "$signers" ] || fail "$signers does not exist: nobody can sign yet"
  [ -s "$sig" ] || fail "no signature"
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    read -r principal options keytype key _ <<<"$line"
    # Options are optional in allowed_signers: a line without them has the key type second.
    if [[ "$options" =~ ^(sk-|ssh-|ecdsa-) ]]; then key=$keytype; keytype=$options; options=""; fi
    [[ "$options" != *cert-authority* ]] || fail "the key of $principal is a cert-authority: refused"
    [[ "$options" == *"namespaces=\"$NS\""* ]] || fail "the key of $principal is not restricted to namespaces=\"$NS\": refused"
    [[ "$options" != *no-touch-required* ]] || fail "the key of $principal is marked no-touch-required: refused"
    [ -n "$key" ] || fail "the line of $principal has no key"
    if [ "$relajado" != relajado ]; then
      case "$keytype" in sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) ;;
        *) fail "the key of $principal in $signers is $keytype, not a security key that must be touched: refused" ;; esac
      [[ ",$options," == *,verify-required,* ]] || fail "the key of $principal lacks verify-required (a PIN or biometric with the touch): refused"
    fi
    keys=$((keys + 1))
  done < "$signers"
  [ "$keys" -gt 0 ] || fail "$signers holds no key: until Henry adds his, nothing that installs BOb can change"
  principals=$(ssh-keygen -Y find-principals -s "$sig" -f "$signers" 2>/dev/null) || fail "the signature is by no key in $signers"
  while IFS= read -r p; do
    if out=$(ssh-keygen -Y verify -f "$signers" -I "$p" -n "$NS" -s "$sig" < "$msg" 2>&1) \
       && { [ "$relajado" = relajado ] || grep -q -- '-SK key' <<<"$out"; }; then
      echo "$out"; return 0
    fi
  done <<<"$principals"
  fail "the signature does not verify with a touched security key in $signers"
}

propio() {  # <path> <uid>: owned by <uid>, writable by nobody else
  local o m
  [ -e "$1" ] || fail "$1 does not exist: refused"
  o=$(stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"); m=$(stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1")
  [ "$o" = "$2" ] || fail "$1 is not owned by uid $2: refused"
  (( (8#$m & 8#022) == 0 )) || fail "$1 is writable by others than its owner: refused"
}
secreto() {  # <path>: a file holding a password, readable by its owner only
  local m
  m=$(stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1")
  (( (8#$m & 8#077) == 0 )) || fail "$1 holds a password and is readable by a group or others (mode $m; 600 it): refused"
}

cadena_propia() {  # <path>: the file, every link to it and every directory up to /, root's and not writable by others
  local f=$1 t dd n=0
  while :; do
    dd=$(cd -P "$(dirname "$f")" && pwd -P) || fail "cannot resolve $f"
    while :; do propio "$dd" 0; [ "$dd" = / ] && break; dd=$(dirname "$dd"); done
    [ -L "$f" ] || break
    n=$((n + 1)); [ "$n" -lt 20 ] || fail "too many links: $1"
    t=$(readlink "$f"); case "$t" in /*) f=$t ;; *) f=$(dirname "$f")/$t ;; esac
  done
  propio "$f" 0
}

# Whatever caja and instalar-bob.sh can run as root is found on the fixed PATH
# or in git's exec-path, plus psql's real binary (below). Discovered, not
# listed: every directory there must be root's along its whole path; every file
# in it root's and writable by no group or other; and every link in it, hop by
# hop, root's along each hop's whole path. Not checked: the shared libraries
# and the loader, and what an interpreter loads.
directorio_propio() {  # <dir>
  local d=$1 bad links l
  cadena_propia "$d"
  bad=$(find -L "$d" -mindepth 1 -maxdepth 1 \( ! -uid 0 -o -perm -0002 -o -perm -0020 \) -print -quit 2>&1) \
    || fail "cannot check $d: $bad"
  [ -z "$bad" ] || fail "$bad (on the PATH) is not root's, or is writable by a group or others: refused"
  links=$(find "$d" -mindepth 1 -maxdepth 1 -type l 2>&1) || fail "cannot list the links in $d: $links"
  while IFS= read -r l; do [ -z "$l" ] || cadena_propia "$l"; done <<<"$links"
}
# psql as the binary itself: Debian's /usr/bin/psql is pg_wrapper, a perl
# script that loads modules from outside the PATH. Its newest
# /usr/lib/postgresql/<v>/bin/psql is used instead, checked with its directory.
psql_real() {
  local p v best=""
  for p in /usr/lib/postgresql/*/bin/psql; do
    [ -x "$p" ] || continue
    v=${p#/usr/lib/postgresql/}; v=${v%%/*}
    [[ "$v" =~ ^[0-9]+$ ]] || continue
    if [ -z "$best" ] || [ "$v" -gt "${best%%:*}" ]; then best="$v:$p"; fi
  done
  if [ -n "$best" ]; then p=${best#*:}; else p=$(command -v psql 2>/dev/null) || fail "no psql on this box: install postgresql-client"; fi
  directorio_propio "$(dirname "$p")" >&2; cadena_propia "$p" >&2
  [ "$(head -c 2 "$p")" != '#!' ] || fail "$p is a script, not psql itself: refused"
  echo "$p"
}
herramientas() {
  local d
  command -v git >/dev/null && command -v ssh-keygen >/dev/null || fail "git and ssh-keygen are required"
  for d in ${PATH_FIJO//:/ }; do [ -d "$d" ] && directorio_propio "$d"; done
  d=$(git --exec-path) || fail "git --exec-path failed"
  directorio_propio "$d"
}

# hosts: where root sends a password. Loopback, or a line of
# <raiz>/hosts-permitidos (root's): the database's container name, for one.
host_permitido() {  # <raiz> <uid> <host>
  local l
  case "$3" in 127.0.0.1|localhost|::1) return 0 ;; esac
  [ -f "$1/hosts-permitidos" ] || return 1
  propio "$1/hosts-permitidos" "$2"
  while IFS= read -r l; do l=${l%%#*}; l=${l//[[:space:]]/}; [ "$l" = "$3" ] && return 0; done < "$1/hosts-permitidos"
  return 1
}
clave() {  # <file> <KEY>: a value, as instalar-bob.sh reads it
  sed -n "s/^$2=//p" "$1" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

revocada() {  # <file> <base> <nueva>: is the pair, or the new digest, revoked?
  local l
  while IFS= read -r l; do
    l=${l%%#*}; l=${l//[[:space:]]/}
    [ -n "$l" ] || continue
    [[ "$l" =~ ^[0-9a-f]{64}(-[0-9a-f]{64})?$ ]] || fail "$1: a line that is neither a digest nor a pair: $l"
    [ "$l" = "$3" ] || [ "$l" = "$2-$3" ] && return 0
  done < "$1"
  return 1
}

# caja: on a box, as root. Henry names the commit he reviewed. Nothing of the
# checkout runs, and nothing of it is read but its git objects:
#   1. a clean environment: env -i, bash -p, a fixed PATH, only the five
#      connection settings, given as arguments and each checked;
#   2. root's own files, root's and writable by nobody else: /opt, /opt/bob,
#      /opt/bob/bin, this script, /opt/bob/firmantes_instalacion,
#      /opt/bob/aprobaciones-revocadas, /opt/bob/instalacion-firmada (the
#      digest this box stands at; Henry writes it once, by hand, P5 §6.2), the
#      connection files, and every program run, along its whole path;
#   3. one caja at a time (flock on /opt/bob/.instalando); old work directories
#      are removed;
#   4. the commit is fetched by its sha into a new repository of root's, with
#      every object checked (transfer.fsckObjects), git-upload-pack running as
#      the caller (setpriv), and its tree written byte for byte from the blobs
#      into a directory of root's, 700: no working tree, no index, no
#      attributes, no filter, no hook, no fsmonitor;
#   5. the digest of that directory must have an approval from where this box
#      stands (<prev>-<digest>.aprobacion in /opt/bob/aprobaciones/ or in the
#      tree, or any approval of the digest when the box is already there),
#      not revoked, signed by a listed security key;
#   6. for cadena, the supabase CLI must be the version CI pins;
#   7. Henry sees the commit, the pair and its log, and types «instalo»;
#   8. instalar-bob.sh runs from that directory, and only if it ends well is
#      the new digest written as this box's state. The directory is removed.
caja() {
  local raiz=$1 uid=$2 relajado=$3 repo=$4 commit=$5 step=$6 v gd d prev cand ok c base pin have rc n src up ans f h hosts red psql u
  case "$step" in cadena|resto) ;; *) fail "step: cadena or resto" ;; esac
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "the commit: its full sha, as Henry read it (git rev-parse HEAD)"
  [[ "$repo" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "the repository: an absolute path in [A-Za-z0-9_./-]"
  # The environment is exactly what the re-exec set.
  for v in $(compgen -e); do
    case " FIRMA_ENV_LIMPIO FIRMA_UID FIRMA_GID PATH HOME LANG PWD OLDPWD SHLVL _ $PASAN " in *" $v "*) ;; *) fail "unexpected variable in the environment: $v" ;; esac
  done
  [ "$PATH" = "$PATH_FIJO" ] || fail "PATH is not the fixed one"
  propio "$raiz" "$uid"
  if [ "$relajado" != relajado ]; then
    propio /opt 0; propio "$raiz/bin" 0
    [ "$0" = "$raiz/bin/firma-instalacion" ] || fail "run $raiz/bin/firma-instalacion, not $0"
    propio "$0" 0
    # caja-prueba runs on a developer's machine or a CI runner, whose programs
    # need not be root's (on GitHub's runner, psql's directory is writable by
    # others: measured). The check itself is tested apart (herramienta).
    herramientas
    psql=$(psql_real) || exit 1
  else
    psql=""
  fi
  propio "$raiz/firmantes_instalacion" "$uid"
  propio "$raiz/aprobaciones-revocadas" "$uid"
  propio "$raiz/instalacion-firmada" "$uid"
  [ ! -e "$raiz/aprobaciones" ] || propio "$raiz/aprobaciones" "$uid"
  # The connection files are read by root: root's, along their whole path.
  conf() { if [ "$relajado" = relajado ]; then propio "$1" "$uid"; else cadena_propia "$1"; fi; secreto "$1"; }
  [ -z "${POSTGRES_ENV:-}" ] || conf "$POSTGRES_ENV"
  # Root sends passwords only to a permitted host.
  hosts="postgres@${POSTGRES_HOST:-127.0.0.1}:${POSTGRES_PORT:-5432}"
  host_permitido "$raiz" "$uid" "${POSTGRES_HOST:-127.0.0.1}" || fail "POSTGRES_HOST ${POSTGRES_HOST} is not loopback nor in $raiz/hosts-permitidos: refused"
  if [ "$step" = resto ]; then
    f=${MIGRADOR_ENV:-$raiz/secrets/migrador.env}
    [ -e "$f" ] || fail "$f does not exist: resto needs the alta's file (MIGRADOR_ENV)"
    conf "$f"; u=$(clave "$f" MIGRADOR_USUARIO); h=$(clave "$f" MIGRADOR_HOST); red=$(clave "$f" MIGRADOR_RED)
    [ -n "$u" ] || fail "$f has no MIGRADOR_USUARIO"
    [ -n "$h" ] || fail "$f has no MIGRADOR_HOST"
    host_permitido "$raiz" "$uid" "$h" || fail "MIGRADOR_HOST in $f is not loopback nor in $raiz/hosts-permitidos: refused"
    hosts="$hosts, $u@$h:${MIGRADOR_PUERTO:-5432} (from $f; MIGRADOR_RED=${red:-none})"
  fi

  # One at a time; what an interrupted run left is removed.
  if command -v flock >/dev/null; then
    exec 9>"$raiz/.instalando"; flock -n 9 || fail "another caja is running on this box"
  elif [ "$relajado" != relajado ]; then fail "flock is required"; fi
  rm -rf "$raiz"/trabajo.*

  prev=$(cat "$raiz/instalacion-firmada")
  [[ "$prev" =~ ^[0-9a-f]{64}$ ]] || fail "$raiz/instalacion-firmada does not hold one digest"

  WORK=$(mktemp -d "$raiz/trabajo.XXXXXX"); chmod 700 "$WORK"
  gd=$WORK/git
  G init -q --bare "$gd" || fail "cannot make root's repository"
  up=()
  if [ "$relajado" != relajado ]; then
    # git-upload-pack reads the caller's repository as the caller, never as root.
    [[ "${FIRMA_UID:-}" =~ ^[1-9][0-9]*$ && "${FIRMA_GID:-}" =~ ^[1-9][0-9]*$ ]] || fail "run through sudo, as Henry: SUDO_UID is missing"
    command -v setpriv >/dev/null || fail "setpriv is required"
    up=(--upload-pack="setpriv --reuid=$FIRMA_UID --regid=$FIRMA_GID --clear-groups env HOME=/ git-upload-pack")
  fi
  G -c transfer.fsckObjects=true --git-dir="$gd" fetch -q --no-tags --no-write-fetch-head ${up[@]+"${up[@]}"} "file://$repo" "$commit" \
    || fail "cannot fetch $commit from $repo"
  [ "$(G --git-dir="$gd" cat-file -t "$commit")" = commit ] || fail "$commit is not a commit"
  extraer "$gd" "$commit" "$WORK/arbol" "$WORK/lista"
  d=$(sha < "$WORK/lista")
  [ -f "$WORK/arbol/scripts/instalar-bob.sh" ] || fail "$commit has no scripts/instalar-bob.sh"

  if [ "$prev" = "$d" ]; then
    cand=$( { G --git-dir="$gd" ls-tree --name-only "$commit" "$EXCLUIDO" | sed "s#^$EXCLUIDO##"
              [ ! -d "$raiz/aprobaciones" ] || ls "$raiz/aprobaciones"; } \
            | sed -n "s#^\([0-9a-f]\{64\}\)-$d\.aprobacion\$#\1#p" | sort -u)
  else
    cand=$prev
  fi
  ok=""
  for base in $cand; do
    c=$base-$d.aprobacion
    if [ -f "$raiz/aprobaciones/$c" ] && [ -f "$raiz/aprobaciones/$c.sig" ]; then
      propio "$raiz/aprobaciones/$c" "$uid"; propio "$raiz/aprobaciones/$c.sig" "$uid"
      cat "$raiz/aprobaciones/$c" > "$WORK/msg"; cat "$raiz/aprobaciones/$c.sig" > "$WORK/sig"; src="$raiz/aprobaciones"
    elif G --git-dir="$gd" cat-file blob "$commit:$EXCLUIDO$c" > "$WORK/msg" 2>/dev/null \
         && G --git-dir="$gd" cat-file blob "$commit:$EXCLUIDO$c.sig" > "$WORK/sig" 2>/dev/null; then
      src="the commit"
    else continue; fi
    cmp -s "$WORK/msg" <(mensaje "$base" "$d") || fail "$c is not the text of $base → $d: refused"
    ! revocada "$raiz/aprobaciones-revocadas" "$base" "$d" || fail "$base → $d is revoked in $raiz/aprobaciones-revocadas: refused"
    verificar "$raiz/firmantes_instalacion" "$WORK/msg" "$WORK/sig" "$relajado"
    ok=$base; break
  done
  [ -n "$ok" ] || fail "no approval from $prev (this box) to $d ($commit): nothing installed"

  if [ "$step" = cadena ]; then
    pin=$(sed -n 's/^  SUPABASE_CLI_VERSION: *\([0-9][0-9.]*\)$/\1/p' "$WORK/arbol/.github/workflows/ci.yml" 2>/dev/null | head -1)
    have=$(supabase --version 2>/dev/null || true)
    [ -n "$pin" ] && [ "$have" = "$pin" ] || fail "the supabase CLI here is '${have:-none}', CI pins '${pin:-none}': nothing installed"
  fi

  # Henry sees what is about to run, with which settings, and says so. This is
  # a last look, not proof that he is there: the barrier is the signature.
  resumen() {
    echo "commit   $commit"
    echo "base     $prev (this box)"
    echo "nueva    $d (approval in $src)"
    echo "settings ${ajustes:-none}"
    echo "sends passwords to $hosts"
  }
  ajustes=""; for v in $PASAN; do [ -z "${!v:-}" ] || ajustes="$ajustes $v=${!v}"; done
  echo "== About to run $step on this box, as root"
  resumen
  G --git-dir="$gd" --no-pager log --oneline --no-decorate -n 30 "$commit" | LC_ALL=C tr -cd '[:print:]\n'
  echo "== Again:"
  resumen
  if [ "$relajado" != relajado ]; then [ -t 0 ] || fail "the confirmation needs a terminal"; fi
  printf 'Type «instalo» to install it: '
  read -r ans || ans=""
  [ "$ans" = instalo ] || fail "not confirmed: nothing installed"

  set +e
  (cd "$WORK/arbol" && BOB_FIRMA_VERIFICADA=$d BOB_PSQL=$psql SUDO="" /bin/bash -p scripts/instalar-bob.sh "$step")
  rc=$?
  set -e
  [ "$rc" = 0 ] || fail "$step failed (exit $rc): this box stays at $prev"
  n=$raiz/instalacion-firmada.nuevo
  printf '%s\n' "$d" > "$n"; chmod 644 "$n"; mv -f "$n" "$raiz/instalacion-firmada"
  echo "this box now stands at $d"
}

# Re-exec with nothing of the caller's environment: the connection settings come
# as VAR=value arguments, each checked; the caller's uid for git-upload-pack.
limpio() {
  local home=$1 cmd=$2 v val re a pass=() args=() i=0
  shift 2
  for a in "$@"; do
    i=$((i + 1))
    if [ "$i" -le "$NFIJOS" ]; then args+=("$a"); continue; fi
    v=${a%%=*}; val=${a#*=}
    case " $PASAN " in *" $v "*) ;; *) fail "unknown setting: $v (only $PASAN)" ;; esac
    case "$v" in *_ENV) re='^/[A-Za-z0-9_./-]+$' ;; *_HOST) re='^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$' ;; *) re='^[0-9]{1,5}$' ;; esac
    [[ "$val" =~ $re ]] || fail "$v refused: not a plain value"
    pass+=("$v=$val")
  done
  [[ "${SUDO_UID:-}" =~ ^[0-9]+$ ]] && pass+=("FIRMA_UID=$SUDO_UID")
  [[ "${SUDO_GID:-}" =~ ^[0-9]+$ ]] && pass+=("FIRMA_GID=$SUDO_GID")
  exec /usr/bin/env -i FIRMA_ENV_LIMPIO=1 PATH="$PATH_FIJO" HOME="$home" LANG=C ${pass[@]+"${pass[@]}"} /bin/bash -p "$0" "$cmd" "${args[@]}"
}

cmd=${1:-}; shift || true
case "$cmd" in
  huella) huella "${1:?rev}" "${2:-.}" "${3:-}" ;;
  mensaje) mensaje "${1:?}" "${2:?}" ;;
  verificar) verificar "${1:?}" "${2:?}" "${3:?}" ;;
  herramienta) if [ -d "${1:?path}" ]; then directorio_propio "$1"; else cadena_propia "$1"; fi; echo "root's along its whole path: $1" ;;
  caja)
    [ "$(id -u)" = 0 ] || fail "run as root: sudo /opt/bob/bin/firma-instalacion caja <repo> <commit> cadena|resto [VAR=value …]"
    NFIJOS=3; [ "${FIRMA_ENV_LIMPIO:-}" = 1 ] || limpio /root caja "$@"
    caja /opt/bob 0 "" "${1:?repo}" "${2:?commit}" "${3:?step}" ;;
  caja-prueba)
    [ "$(id -u)" != 0 ] || fail "caja-prueba never runs as root"
    [[ "${1:?raiz}" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "raiz: an absolute path"
    PATH_FIJO=/usr/bin:/bin:/usr/sbin:/sbin   # the system's only, on a developer's machine too
    NFIJOS=4; [ "${FIRMA_ENV_LIMPIO:-}" = 1 ] || limpio "$1" caja-prueba "$@"
    caja "$1" "$(id -u)" relajado "${2:?repo}" "${3:?commit}" "${4:?step}" ;;
  *) echo "Usage: $0 huella|mensaje|verificar|caja|caja-prueba …" >&2; exit 2 ;;
esac
