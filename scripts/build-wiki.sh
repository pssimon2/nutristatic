#!/bin/bash
# Generalized Wikipedia index build with bounded disk usage: read a dump,
# clean markup, window into phrases, and merge shards with a frequency cutoff.
#
# usage: build-wiki.sh NAME DUMP OUT [FILTER]
#   NAME    chunk/stage prefix (e.g. "dewiki")
#   DUMP    path to pages-articles.xml.bz2
#   OUT     final merged index filename
#   FILTER  optional shell command applied between remove-markup and
#           make-index (e.g. a transliteration sed); default: cat
#
# Rolling merges: completed 1M-chain chunks merge in >=50 batches (cutoff 2),
# raw chunks deleted as they go; final merge uses cutoff 5.
# Paths are overridable so the same script runs locally and on the server:
#   DATA_DIR  working directory (default <repo>/data)
#   BIN       directory with the compiled tools (default <repo>/build-cpp)
#   NICE      command prefix for the heavy processes (e.g. "nice -n 19 ionice -c3")
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME=$1; DUMP=$2; OUT=$3; FILTER=${4:-cat}
DATA_DIR=${DATA_DIR:-$ROOT/data}
BIN=${BIN:-$ROOT/build-cpp}
NICE=${NICE:-}
cd "$DATA_DIR"
LOG=${NAME}-build.log
MIN_FREE_GB=${MIN_FREE_GB:-15}

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
free_gb() { df -BG --output=avail "$DATA_DIR" | tail -1 | tr -dc 0-9; }

log "=== $NAME build started (dump $DUMP, filter: $FILTER) ==="

( set -o pipefail
  $NICE lbzip2 -dc "$DUMP" \
    | $NICE "$BIN/remove-markup" 2>"$NAME-remove-markup.err" \
    | eval "$NICE $FILTER" \
    | $NICE "$BIN/make-index" "$NAME"
  echo $? > "$NAME-make-index.rc"
) &
PRODUCER=$!
log "producer started (pid $PRODUCER)"

s1=$(ls "${NAME}-s1-"*.index 2>/dev/null | wc -l)

merge_completed() { # $1 = yes|no (exclude newest chunk), $2 = min batch size
  local exclude_last=$1 min=$2 files n out
  files=$(ls "${NAME}."*.index 2>/dev/null | sort)
  [ -z "$files" ] && return 0
  if [ "$exclude_last" = yes ]; then files=$(echo "$files" | head -n -1); fi
  [ -z "$files" ] && return 0
  n=$(echo "$files" | grep -c .)
  [ "$n" -lt "$min" ] && return 0
  out=$(printf '%s-s1-%04d.index' "$NAME" "$s1")
  log "merging $n chunks -> $out"
  # shellcheck disable=SC2086
  if $NICE "$BIN/merge-indexes" 2 $files "$out"; then
    # shellcheck disable=SC2086
    rm -f $files
    s1=$((s1 + 1))
    log "done $out ($(du -h "$out" | cut -f1)), free $(free_gb)G"
  else
    log "ERROR: chunk merge failed for $out"
    return 1
  fi
}

while kill -0 "$PRODUCER" 2>/dev/null; do
  if [ "$(free_gb)" -lt "$MIN_FREE_GB" ]; then
    log "ERROR: low disk ($(free_gb)G free), aborting producer"
    kill "$PRODUCER" 2>/dev/null
    exit 1
  fi
  merge_completed yes 50 || { kill "$PRODUCER" 2>/dev/null; exit 1; }
  sleep 30
done
wait "$PRODUCER" 2>/dev/null

rc=$(cat "$NAME-make-index.rc" 2>/dev/null || echo missing)
if [ "$rc" != 0 ]; then
  log "ERROR: producer pipeline rc=$rc ($(head -c 300 "$NAME-remove-markup.err" 2>/dev/null))"
  exit 1
fi
log "producer finished cleanly"

merge_completed no 1 || exit 1

log "final merge of $(ls "${NAME}-s1-"*.index | wc -l) stage-1 files (cutoff 5)"
if $NICE "$BIN/merge-indexes" 5 "${NAME}-s1-"*.index "$OUT"; then
  log "SUCCESS: $OUT ($(du -h "$OUT" | cut -f1))"
  rm -f "${NAME}-s1-"*.index
  log "cleaned up stage-1 files, free $(free_gb)G"
else
  log "ERROR: final merge failed"
  exit 1
fi
