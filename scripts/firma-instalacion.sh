#!/usr/bin/env bash
# Henry's signature over what installs BOb on a box (O-3, P5 §6.2). One
# self-contained file, so that the copy that protects a box can live outside
# the repository: /opt/bob/bin/firma-instalacion, root's, installed once.
#
#   firma-instalacion.sh huella <rev> [<repo>] [--lista]
#       The digest of what installs BOb at <rev>, read from git objects (never
#       the working tree). --lista prints what it covers, one line each.
#   firma-instalacion.sh mensaje <digest-base> <digest-nuevo>
#       The exact text Henry signs: the pair, so an old signature cannot bring
#       back a state already signed once.
#   firma-instalacion.sh verificar <firmantes> <mensaje> <firma>
#       Checks the signature against an allowed_signers file.
#   firma-instalacion.sh caja <checkout> cadena|resto
#       On a box, before anything: the checkout is exactly a commit, its digest
#       has a valid approval whose base is where this box stands, and only then
#       runs <checkout>/scripts/instalar-bob.sh. Signers in
#       /opt/bob/firmantes_instalacion, state in /opt/bob/instalacion-firmada,
#       both root's.
#
# What the digest covers, by mode, path and sha256 of the content:
#   - every file under supabase/provision/, except supabase/provision/aprobaciones/
#     where approvals go (adding one does not change what it approves);
#   - every path supabase/provision/cubre-la-firma lists (absent ones count as
#     absent); a directory listed there is refused;
#   - every tracked file under a node_modules/ directory, anywhere.
# A symlink (120000) or a submodule (160000) among them is refused, and so is a
# path git has to quote.
set -euo pipefail
NS=bob-install-chain
fail() { echo "firma-instalacion: $1" >&2; exit 1; }
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
if command -v sha256sum >/dev/null; then sha() { sha256sum | cut -d' ' -f1; }; else sha() { shasum -a 256 | cut -d' ' -f1; }; fi

huella() {
  local rev=$1 repo=${2:-.} lista=${3:-} tmp line meta path mode sha1 extra
  tmp=$(mktemp -d "$WORK/h.XXXXXX")
  git -C "$repo" rev-parse -q --verify "$rev^{commit}" >/dev/null || fail "no commit $rev"
  git -C "$repo" ls-tree -r --full-tree "$rev" > "$tmp/tree"
  extra=$(git -C "$repo" show "$rev:supabase/provision/cubre-la-firma" 2>/dev/null \
    | sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$' || true)
  : > "$tmp/covered"
  while IFS= read -r line; do
    meta=${line%%$'\t'*}; path=${line#*$'\t'}
    case "$path" in supabase/provision/aprobaciones/*) continue ;; esac
    case "$path" in
      \"*) fail "a path git quotes, refused: $path" ;;
      supabase/provision/*|node_modules/*|*/node_modules/*) printf '%s\t%s\n' "$path" "$meta" >> "$tmp/covered" ;;
    esac
  done < "$tmp/tree"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    line=$(awk -F'\t' -v p="$path" '$2 == p' "$tmp/tree")
    if [ -n "$line" ]; then printf '%s\t%s\n' "$path" "${line%%$'\t'*}" >> "$tmp/covered"
    elif [ "$(git -C "$repo" cat-file -t "$rev:$path" 2>/dev/null)" = tree ]; then fail "cubre-la-firma lists a directory, refused: $path"
    else printf '%s\tabsent\n' "$path" >> "$tmp/covered"; fi
  done <<<"$extra"
  LC_ALL=C sort -u "$tmp/covered" | while IFS=$'\t' read -r path meta; do
    if [ "$meta" = absent ]; then printf 'absent %s -\n' "$path"; continue; fi
    read -r mode _ sha1 <<<"$meta"
    case "$mode" in 100644|100755) ;; *) fail "mode $mode refused (symlink or submodule): $path" ;; esac
    printf '%s %s %s\n' "$mode" "$path" "$(git -C "$repo" cat-file blob "$sha1" | sha)"
  done > "$tmp/lines"
  if [ "$lista" = --lista ]; then cat "$tmp/lines"; else sha < "$tmp/lines"; fi
}

mensaje() {
  [[ "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[0-9a-f]{64}$ ]] || fail "two digests"
  printf '%s 1\nbase %s\nnueva %s\n' "$NS" "$1" "$2"
}

verificar() {
  local signers=$1 msg=$2 sig=$3 keys=0 line principal options keytype key principals out p
  [ -f "$signers" ] || fail "$signers does not exist: nobody can sign yet"
  [ -s "$sig" ] || fail "no signature"
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    read -r principal options keytype key _ <<<"$line"
    # Options are optional in allowed_signers: a line without them has the key type second.
    if [[ "$options" =~ ^(sk-|ssh-|ecdsa-) ]]; then key=$keytype; keytype=$options; options=""; fi
    case "$keytype" in sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) ;;
      *) fail "the key of $principal in $signers is $keytype, not a security key that must be touched: refused" ;; esac
    [[ "$options" == *"namespaces=\"$NS\""* ]] || fail "the key of $principal is not restricted to namespaces=\"$NS\": refused"
    [[ "$options" != *no-touch-required* ]] || fail "the key of $principal is marked no-touch-required: refused"
    [ -n "$key" ] || fail "the line of $principal has no key"
    keys=$((keys + 1))
  done < "$signers"
  [ "$keys" -gt 0 ] || fail "$signers holds no key: until Henry adds his, nothing that installs BOb can change"
  principals=$(ssh-keygen -Y find-principals -s "$sig" -f "$signers" 2>/dev/null) || fail "the signature is by no key in $signers"
  while IFS= read -r p; do
    if out=$(ssh-keygen -Y verify -f "$signers" -I "$p" -n "$NS" -s "$sig" < "$msg" 2>&1) && grep -q -- '-SK key' <<<"$out"; then
      echo "$out"; return 0
    fi
  done <<<"$principals"
  fail "the signature does not verify with a touched security key in $signers"
}

root_only() {  # <file>: owned by root, writable by nobody else
  local o m
  o=$(stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"); m=$(stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1")
  [ "$o" = 0 ] || fail "$1 is not root's: refused"
  (( (8#$m & 8#022) == 0 )) || fail "$1 is writable by others than root: refused"
}

caja() {
  local checkout step d msg base nueva prev tmp
  checkout=$(cd "$1" && pwd); step=$2
  case "$step" in cadena|resto) ;; *) fail "step: cadena or resto" ;; esac
  local FIRMANTES=/opt/bob/firmantes_instalacion ESTADO=/opt/bob/instalacion-firmada SUDO=${SUDO-sudo}
  # Exactly a commit: nothing modified, untracked or ignored (no node_modules,
  # no .env), so what runs is what the digest covers.
  [ -z "$(git -C "$checkout" status --porcelain --ignored --untracked-files=all)" ] \
    || fail "$checkout is not exactly a commit (modified, untracked or ignored files): refused"
  d=$(huella HEAD "$checkout")
  tmp=$(mktemp -d "$WORK/c.XXXXXX")
  git -C "$checkout" show "HEAD:supabase/provision/aprobaciones/$d.aprobacion" > "$tmp/msg" 2>/dev/null \
    || fail "no approval for digest $d in supabase/provision/aprobaciones/: nothing installed"
  git -C "$checkout" show "HEAD:supabase/provision/aprobaciones/$d.aprobacion.sig" > "$tmp/sig" 2>/dev/null \
    || fail "no signature for digest $d: nothing installed"
  base=$(sed -n 's/^base \([0-9a-f]\{64\}\)$/\1/p' "$tmp/msg"); nueva=$(sed -n 's/^nueva \([0-9a-f]\{64\}\)$/\1/p' "$tmp/msg")
  [ -n "$base" ] && [ "$nueva" = "$d" ] && cmp -s "$tmp/msg" <(mensaje "$base" "$nueva") \
    || fail "the approval is not for digest $d: refused"
  root_only "$0"; root_only "$FIRMANTES"
  verificar "$FIRMANTES" "$tmp/msg" "$tmp/sig"
  prev=""; [ -f "$ESTADO" ] && { root_only "$ESTADO"; prev=$(cat "$ESTADO"); }
  # The box goes from where it stands: a signed pair whose base is not this
  # box's last signed state (an old signature, replayed) is refused.
  if [ -n "$prev" ] && [ "$prev" != "$d" ] && [ "$prev" != "$base" ]; then
    fail "this box stands at $prev; this approval goes from $base: install the steps between, or have Henry sign $prev → $d"
  fi
  [ "$prev" = "$d" ] || printf '%s\n' "$d" | $SUDO tee "$ESTADO" >/dev/null
  echo "approved by Henry: $d (from $base); running $step"
  rm -rf "$WORK"
  exec env BOB_FIRMA_VERIFICADA="$d" "$checkout/scripts/instalar-bob.sh" "$step"
}

cmd=${1:-}; shift || true
case "$cmd" in
  huella) huella "${1:?rev}" "${2:-.}" "${3:-}" ;;
  mensaje) mensaje "${1:?}" "${2:?}" ;;
  verificar) verificar "${1:?}" "${2:?}" "${3:?}" ;;
  caja) caja "${1:?checkout}" "${2:?step}" ;;
  *) echo "Usage: $0 huella|mensaje|verificar|caja …" >&2; exit 2 ;;
esac
