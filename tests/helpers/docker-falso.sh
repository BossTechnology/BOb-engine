#!/usr/bin/env bash
# A stand-in for docker, for tests/ensayo-desinstalar.test.mjs only: the handful of calls
# scripts/ensayo/desinstalar-bob.sh makes, over two tab-separated files in $DOCKER_FALSO:
#   contenedores   name, compose project, image id, running (true|false)
#   imagenes       image id, tags (space-separated)
# Every call is appended to $DOCKER_FALSO/log, so a test can tell a dry run wrote nothing.
set -euo pipefail
d=${DOCKER_FALSO:?DOCKER_FALSO: the fake docker state directory}
printf '%s\n' "$*" >> "$d/log"
c=$d/contenedores; i=$d/imagenes; touch "$c" "$i"
last=${*: -1}
fila() { awk -F'\t' -v k="$2" '$1 == k' "$1"; }
reescribir() { local f=$1; shift; awk -F'\t' -v OFS='\t' "$@" "$f" > "$f.n"; mv "$f.n" "$f"; }

case "$1" in
  ps)
    if [ "${3:-}" = --filter ]; then awk -F'\t' -v id="${4#ancestor=}" '$3 == id { print $1 }' "$c"
    else awk -F'\t' '{ print $1 "\t" $2 }' "$c"; fi ;;
  inspect)
    l=$(fila "$c" "$last"); [ -n "$l" ] || { echo "Error: No such object: $last" >&2; exit 1; }
    case "$3" in *Running*) cut -f4 <<<"$l" ;; *) cut -f3 <<<"$l" ;; esac ;;
  stop|start)
    [ -n "$(fila "$c" "$2")" ] || { echo "Error: No such container: $2" >&2; exit 1; }
    v=false; [ "$1" = start ] && v=true
    reescribir "$c" -v n="$2" -v v="$v" '$1 == n { $4 = v } { print }'; echo "$2" ;;
  rm)
    [ -n "$(fila "$c" "$last")" ] || { echo "Error: No such container: $last" >&2; exit 1; }
    reescribir "$c" -v n="$last" '$1 != n'; echo "$last" ;;
  image)
    case "$2" in
      inspect)
        l=$(fila "$i" "$last"); [ -n "$l" ] || { echo "Error: No such image: $last" >&2; exit 1; }
        case "${4:-}" in *RepoTags*) cut -f2 <<<"$l" ;; *) echo "$last" ;; esac ;;
      rm)
        if [[ "$3" == sha256:* ]]; then
          [ -n "$(fila "$i" "$3")" ] || { echo "Error: No such image: $3" >&2; exit 1; }
          ! cut -f3 "$c" | grep -qxF "$3" || { echo "Error: image is being used by a container" >&2; exit 1; }
          reescribir "$i" -v r="$3" '$1 != r'
        else
          awk -F'\t' -v r="$3" '{ k = split($2, t, " "); for (j = 1; j <= k; j++) if (t[j] == r) f = 1 } END { exit !f }' "$i" \
            || { echo "Error: No such image: $3" >&2; exit 1; }
          reescribir "$i" -v r="$3" '{ n = ""; k = split($2, t, " "); for (j = 1; j <= k; j++) if (t[j] != r) n = n t[j] " "; $2 = n; print }'
        fi ;;
      *) echo "docker falso: no sé «$*»" >&2; exit 3 ;;
    esac ;;
  *) echo "docker falso: no sé «$*»" >&2; exit 3 ;;
esac
