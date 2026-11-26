#!/usr/bin/env bash
# Henry signs what a box is about to install (O-3, P5 §6.2). He signs when he
# installs («Al instalar en la caja»), on his own machine, with the key.
#
#   scripts/firmar-instalacion.sh <rev-nueva> --base <rev-base>|vacia --llave <key>
#       [--proveedor <provider>] [--ssh-keygen <program>] [--caja <machine-id>] [--salida <dir>]
#
# Henry, with the Secure Enclave key of his Mac (docs/adr/0001):
#   scripts/firmar-instalacion.sh <rev-nueva> --base <rev-base> \
#     --llave ~/.ssh/id_ecdsa_sk_rk_henry-bob-install \
#     --proveedor /usr/lib/ssh-keychain.dylib --ssh-keygen /usr/bin/ssh-keygen
# Apple's ssh-keygen, since Homebrew's has no such provider.
#
# --llave <key> (or FIRMA_LLAVE): the key file ssh-keygen signs with; for a
# resident key, its handle. Required: no key is assumed.
# --proveedor <provider> (or SSH_SK_PROVIDER): the security key provider,
# handed to ssh-keygen as -w. Without one, ssh-keygen's own.
# --ssh-keygen <program> (or FIRMA_SSH_KEYGEN): the ssh-keygen that signs;
# default the one on PATH. verificar checks the result with the one on PATH.
#
# --caja, only when both have the same digest: d → d, for a box that stands
# at d with no record of how it got there; it names that box (its
# /etc/machine-id), so it runs no other.
#
# <rev-base> is what the box runs today (its /opt/bob/instalacion-firmada is
# that commit's digest); <rev-nueva> is what it will run. --base vacia, for a
# box where BOb was never installed: the empty base (firma-instalacion.sh
# vacia), which that box's instalacion-firmada holds. Run from a clean
# checkout of main, at origin/main: the tools that compute and show what is
# signed are main's. Both revisions are read from git objects; nothing of them
# runs. It shows the whole diff and the log between them, asks before the
# touch, and signs the pair base → new with the security key (--llave) in
# the namespace bob-install-chain, which is
# this approval's alone: the key is not the one in Bzzz's
# config/bob/firmantes_imagen. It writes <base>-<nueva>.aprobacion and its
# .sig into <dir> (default a new directory under $TMPDIR, never the
# checkout), to copy to the box's
# /opt/bob/aprobaciones/ as root, but only after checking them as a box would
# (firma-instalacion.sh verificar, against main's signers file): a signature a
# box would refuse is reported here, never as «Signed». Nothing is committed.
set -euo pipefail
cd "$(dirname "$0")/.."
new_rev=${1:?Usage: $0 <rev-nueva> --base <rev-base> --llave <key> [--proveedor <provider>] [--ssh-keygen <program>] [--salida <dir>]}; shift
base_rev=""; out=""; caja=""
KEY=${FIRMA_LLAVE:-}; PROVIDER=${SSH_SK_PROVIDER:-}; KEYGEN=${FIRMA_SSH_KEYGEN:-ssh-keygen}
while [ $# -gt 0 ]; do
  case "$1" in --base) base_rev=${2:?}; shift 2 ;; --caja) caja=${2:?}; shift 2 ;; --salida) out=${2:?}; shift 2 ;;
    --llave) KEY=${2:?}; shift 2 ;; --proveedor) PROVIDER=${2:?}; shift 2 ;; --ssh-keygen) KEYGEN=${2:?}; shift 2 ;;
    *) echo "unknown: $1" >&2; exit 2 ;; esac
done
[ -z "$caja" ] || [[ "$caja" =~ ^[0-9a-f]{32}$ ]] || { echo "--caja: the box's machine-id (cat /etc/machine-id there), 32 hex" >&2; exit 2; }
[ -n "$base_rev" ] || { echo "--base <rev>: what the box runs today" >&2; exit 2; }
[ -n "$KEY" ] || { echo "--llave <key> (or FIRMA_LLAVE): the key to sign with; none is assumed" >&2; exit 2; }
[ -f "$KEY" ] || { echo "--llave: no key file at $KEY" >&2; exit 2; }
[ -z "$PROVIDER" ] || [ -f "$PROVIDER" ] || { echo "--proveedor: no security key provider at $PROVIDER" >&2; exit 2; }
command -v "$KEYGEN" > /dev/null || { echo "--ssh-keygen: $KEYGEN cannot be run" >&2; exit 2; }
sign_args=(-Y sign -q)
[ -z "$PROVIDER" ] || sign_args+=(-w "$PROVIDER")
sign_args+=(-f "$KEY" -n bob-install-chain)
F=scripts/firma-instalacion.sh
git fetch -q origin
[ -z "$(git status --porcelain --untracked-files=all)" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || { echo "Run from a clean checkout of main at origin/main (git switch main && git pull): the signing tools must be main's." >&2; exit 1; }
if [ "$base_rev" = vacia ]; then b=$("$F" vacia); else b=$("$F" huella "$base_rev" .); fi
n=$("$F" huella "$new_rev" .)
# The same digest: the pair d → d, for a box that already stands at d (its
# instalacion-firmada) and has no instalacion-aprobacion, say to run resto
# again. caja accepts it only at d; nothing changes, so there is no diff.
if [ "$b" = "$n" ]; then
  [ -n "$caja" ] || { echo "$base_rev and $new_rev have the same digest. If that is meant (d → d, a box at it with no record), say which box: --caja <its machine-id>." >&2; exit 2; }
  echo "== The same digest: this signs d → d, $n → $n, for the box $caja alone, to run a step again there."
else
  [ -z "$caja" ] || { echo "--caja is only for the same digest (d → d): $base_rev and $new_rev differ" >&2; exit 2; }
fi
ex=':(exclude)supabase/provision/aprobaciones'
echo "== What changes, $base_rev → $new_rev ($(git rev-parse "$new_rev^{commit}")):"
# From the empty base, everything is new: the log and the diff are from nothing.
if [ "$base_rev" = vacia ]; then rango=$new_rev; desde=$(git hash-object -t tree /dev/null); else rango=$base_rev..$new_rev; desde=$base_rev; fi
git --no-pager log --oneline --no-decorate "$rango" | LC_ALL=C tr -cd '[:print:]\n'
git --no-pager -c core.attributesFile=/dev/null diff --no-ext-diff --no-textconv --summary --stat "$desde" "$new_rev" -- . "$ex"
git --no-pager -c core.attributesFile=/dev/null diff --no-ext-diff --no-textconv "$desde" "$new_rev" -- . "$ex"
echo
echo "base  $b"
echo "nueva $n"
echo "signs with: $KEYGEN ${sign_args[*]} <aprobacion>"
read -r -p "Type 'firmo' to sign this pair with the key at $KEY: " ok
[ "$ok" = firmo ] || { echo "Not signed."; exit 1; }
[ -n "$out" ] || out=$(mktemp -d "${TMPDIR:-/tmp}/bob-aprobacion.XXXXXX")
mkdir -p "$out"
a=$out/$b-$n.aprobacion
"$F" mensaje "$b" "$n" $caja > "$a"
rm -f "$a.sig"
"$KEYGEN" "${sign_args[@]}" "$a"
# What a box does with it, against main's signers file: a signature it would
# refuse (another key, no touch, a line that wants UV) is never «Signed».
"$F" verificar supabase/provision/firmantes_instalacion "$a" "$a.sig" \
  || { echo "The signature in $a.sig does not pass verificar: a box would refuse it. Not signed." >&2; rm -f "$a.sig"; exit 1; }
echo "Signed: $a and $a.sig. On the box, as root:"
echo "  install -o root -g root -m 644 $a $a.sig /opt/bob/aprobaciones/"
