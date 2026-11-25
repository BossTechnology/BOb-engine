#!/usr/bin/env bash
# Verifies Henry's signature over the digest of what installs BOb (O-3, P5 §6.2).
#
#   scripts/verificar-firma-instalacion.sh <firmantes> <digest> <signature>
#
# <firmantes> is supabase/provision/firmantes_instalacion as it is on main,
# never the PR's: a PR that brought its own key would sign its own change. Its
# format is Bzzz's for config/bob/firmantes_imagen (ssh-keygen allowed_signers),
# with one more rule: every key is a security key, one that must be touched to
# sign (sk-ssh-ed25519@openssh.com or sk-ecdsa-sha2-nistp256@openssh.com,
# Secure Enclave included), never marked no-touch-required, and restricted to
# this namespace:
#   <name> namespaces="bob-install-chain"[,verify-required] sk-… AAAA…
# Fails closed: no key, a key of another kind, or any doubt is a failure.
set -euo pipefail
NS=bob-install-chain
[ $# -eq 3 ] || { echo "Usage: $0 <firmantes> <digest> <signature>" >&2; exit 2; }
signers=$1 digest=$2 sig=$3
fail() { echo "$1" >&2; exit 1; }
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "not a digest: $digest"
[ -f "$signers" ] || fail "$signers is not on main: nobody can sign yet"
[ -s "$sig" ] || fail "no signature"

keys=0
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
[ "$keys" -gt 0 ] || fail "$signers on main holds no key: until Henry adds his, nothing that installs BOb can change"

principals=$(ssh-keygen -Y find-principals -s "$sig" -f "$signers" 2>/dev/null) || fail "the signature is by no key in $signers"
while IFS= read -r p; do
  if out=$(printf '%s\n' "$digest" | ssh-keygen -Y verify -f "$signers" -I "$p" -n "$NS" -s "$sig" 2>&1) \
     && grep -q -- '-SK key' <<<"$out"; then
    echo "$out"
    exit 0
  fi
done <<<"$principals"
fail "the signature does not verify for $digest with a touched security key in $signers"
