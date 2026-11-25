#!/usr/bin/env bash
# Henry signs a change to what installs BOb (O-3, P5 §6.2).
#
#   scripts/firmar-instalacion.sh <pr-branch> [--base <rev>]
#
# Run from a clean checkout of main, at origin/main: the tools that compute and
# show what is signed are main's, never the PR's. It reads the PR branch from
# git objects (nothing of it runs), shows the diff of the whole tree, which the
# digest covers, between the base (origin/main, or --base) and the branch, and asks
# before the touch. It signs the pair base → new with the security key
# (FIRMA_LLAVE, default ~/.ssh/id_ed25519_sk) in the namespace bob-install-chain,
# which is this approval's alone: the key is not the one in Bzzz's
# config/bob/firmantes_imagen, nor any other namespace's. It then commits the
# approval and its signature on top of the branch, in a temporary worktree, and
# prints the push for Henry to run.
set -euo pipefail
cd "$(dirname "$0")/.."
branch=${1:?Usage: $0 <pr-branch> [--base <rev>]}
base_rev=origin/main
[ "${2:-}" = --base ] && base_rev=${3:?--base <rev>}
KEY=${FIRMA_LLAVE:-$HOME/.ssh/id_ed25519_sk}
F=scripts/firma-instalacion.sh
git fetch -q origin
[ -z "$(git status --porcelain --untracked-files=all)" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || { echo "Run from a clean checkout of main at origin/main (git switch main && git pull): the signing tools must be main's." >&2; exit 1; }
new_rev=origin/$branch
b=$("$F" huella "$base_rev" .); n=$("$F" huella "$new_rev" .)
[ "$b" != "$n" ] || { echo "Nothing that installs BOb differs between $base_rev and $new_rev: nothing to sign."; exit 0; }
ex=':(exclude)supabase/provision/aprobaciones'
echo "== What changes, $base_rev → $new_rev ($(git rev-parse --short "$new_rev")):"
git --no-pager -c core.attributesFile=/dev/null diff --no-ext-diff --no-textconv --summary --stat "$base_rev" "$new_rev" -- . "$ex"
git --no-pager -c core.attributesFile=/dev/null diff --no-ext-diff --no-textconv "$base_rev" "$new_rev" -- . "$ex"
echo
echo "base  $b"
echo "nueva $n"
read -r -p "Type 'firmo' to sign this pair with the key at $KEY: " ok
[ "$ok" = firmo ] || { echo "Not signed."; exit 1; }
wt=$(mktemp -d "${TMPDIR:-/tmp}/bob-firma.XXXXXX")
git worktree add -q --detach "$wt" "$new_rev"
a=supabase/provision/aprobaciones/$b-$n.aprobacion
"$F" mensaje "$b" "$n" > "$wt/$a"
ssh-keygen -Y sign -q -f "$KEY" -n bob-install-chain "$wt/$a"
git -C "$wt" add "$a" "$a.sig"
git -C "$wt" commit -q -m "chore(o3): sign the install change ${b:0:12} -> ${n:0:12}"
echo "Signed. Push it, then drop the worktree:"
echo "  git -C $wt push origin HEAD:refs/heads/$branch && git worktree remove $wt"
