#!/usr/bin/env bash
# Henry signs what a box is about to install (O-3, P5 §6.2). He signs when he
# installs («Al instalar en la caja»), on his own machine, with the key.
#
#   scripts/firmar-instalacion.sh <rev-nueva> --base <rev-base> [--salida <dir>]
#
# <rev-base> is what the box runs today (its /opt/bob/instalacion-firmada is
# that commit's digest); <rev-nueva> is what it will run. Run from a clean
# checkout of main, at origin/main: the tools that compute and show what is
# signed are main's. Both revisions are read from git objects; nothing of them
# runs. It shows the whole diff and the log between them, asks before the
# touch, and signs the pair base → new with the security key (FIRMA_LLAVE,
# default ~/.ssh/id_ed25519_sk) in the namespace bob-install-chain, which is
# this approval's alone: the key is not the one in Bzzz's
# config/bob/firmantes_imagen. It writes <base>-<nueva>.aprobacion and its
# .sig into <dir> (default ./aprobacion), to copy to the box's
# /opt/bob/aprobaciones/ as root. Nothing is committed.
set -euo pipefail
cd "$(dirname "$0")/.."
new_rev=${1:?Usage: $0 <rev-nueva> --base <rev-base> [--salida <dir>]}; shift
base_rev=""; out=aprobacion
while [ $# -gt 0 ]; do
  case "$1" in --base) base_rev=${2:?}; shift 2 ;; --salida) out=${2:?}; shift 2 ;; *) echo "unknown: $1" >&2; exit 2 ;; esac
done
[ -n "$base_rev" ] || { echo "--base <rev>: what the box runs today" >&2; exit 2; }
KEY=${FIRMA_LLAVE:-$HOME/.ssh/id_ed25519_sk}
F=scripts/firma-instalacion.sh
git fetch -q origin
[ -z "$(git status --porcelain --untracked-files=all)" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || { echo "Run from a clean checkout of main at origin/main (git switch main && git pull): the signing tools must be main's." >&2; exit 1; }
b=$("$F" huella "$base_rev" .); n=$("$F" huella "$new_rev" .)
[ "$b" != "$n" ] || { echo "$base_rev and $new_rev have the same digest: nothing to sign."; exit 0; }
ex=':(exclude)supabase/provision/aprobaciones'
echo "== What changes, $base_rev → $new_rev ($(git rev-parse "$new_rev^{commit}")):"
git --no-pager log --oneline --no-decorate "$base_rev..$new_rev" | LC_ALL=C tr -cd '[:print:]\n'
git --no-pager -c core.attributesFile=/dev/null diff --no-ext-diff --no-textconv --summary --stat "$base_rev" "$new_rev" -- . "$ex"
git --no-pager -c core.attributesFile=/dev/null diff --no-ext-diff --no-textconv "$base_rev" "$new_rev" -- . "$ex"
echo
echo "base  $b"
echo "nueva $n"
read -r -p "Type 'firmo' to sign this pair with the key at $KEY: " ok
[ "$ok" = firmo ] || { echo "Not signed."; exit 1; }
mkdir -p "$out"
a=$out/$b-$n.aprobacion
"$F" mensaje "$b" "$n" > "$a"
ssh-keygen -Y sign -q -f "$KEY" -n bob-install-chain "$a"
echo "Signed: $a and $a.sig. On the box, as root:"
echo "  install -o root -g root -m 644 $a $a.sig /opt/bob/aprobaciones/"
