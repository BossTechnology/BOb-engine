#!/usr/bin/env bash
# Henry signs what installs BOb (O-3, P5 §6.2). Run it on the PR's branch,
# after the last push that touches anything the digest covers, with the
# security key at hand: ssh-keygen asks for the touch (and the PIN, with
# verify-required).
#
#   scripts/firmar-instalacion.sh            key: FIRMA_LLAVE, default ~/.ssh/id_ed25519_sk
#
# It signs the committed, pushed HEAD, not the working tree, and writes
# supabase/provision/aprobaciones/<digest>.sig. It does not commit or push:
# commit that one file and push it. CI then verifies it against
# supabase/provision/firmantes_instalacion on main.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=${FIRMA_LLAVE:-$HOME/.ssh/id_ed25519_sk}
git fetch -q
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || { echo "HEAD is not what is pushed: push first, then sign" >&2; exit 1; }
d=$(node scripts/huella-instalacion.mjs HEAD)
out=supabase/provision/aprobaciones/$d.sig
echo "Signing the digest of $(git rev-parse --short HEAD): $d"
printf '%s\n' "$d" | ssh-keygen -Y sign -f "$KEY" -n bob-install-chain > "$out.tmp"
mv "$out.tmp" "$out"
echo "Written $out. Now: git add $out && git commit -m 'chore(o3): sign the install chain at $(git rev-parse --short HEAD)' && git push"
