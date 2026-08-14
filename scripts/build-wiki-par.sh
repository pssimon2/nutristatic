#!/bin/bash
# Parallel Wikipedia index build: xml-split fans pages out to N independent
# remove-markup|make-index pipelines; completed chunks roll-merge (cutoff 2)
# while production runs; final merge applies cutoff 5. Byte-identical output
# to the sequential pipeline (verified: chunk contents differ only in
# partitioning; merging is order-insensitive).
#
# usage: build-wiki-par.sh NAME DUMP OUT [FILTER]
# env: DATA_DIR, BIN, NICE, MIN_FREE_GB, WORKERS (default 12), LOG
#      FILTER must not contain a '%' character (worker cmd is a printf fmt).
set -u
NAME=$1; DUMP=$2; OUT=$3; FILTER=${4:-}
DATA_DIR=${DATA_DIR:-./data}
BIN=${BIN:-./build-cpp}
NICE=${NICE:-}
WORKERS=${WORKERS:-12}
cd "$DATA_DIR"
LOG=${LOG:-${NAME}-build.log}
MIN_FREE_GB=${MIN_FREE_GB:-15}

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
free_gb() { df -BG --output=avail "$DATA_DIR" | tail -1 | tr -dc 0-9; }

WORKER_CMD="$NICE $BIN/remove-markup 2>>$NAME-remove-markup.err"
if [ -n "$FILTER" ]; then WORKER_CMD="$WORKER_CMD | $FILTER"; fi
WORKER_CMD="$WORKER_CMD | $NICE $BIN/make-index ${NAME}-p%d"

log "=== $NAME parallel build started ($WORKERS workers, dump $DUMP) ==="

( set -o pipefail
  $NICE lbzip2 -dc "$DUMP" \
    | $NICE "$BIN/xml-split" "$WORKERS" "$WORKER_CMD"
  echo $? > "$NAME-pipeline.rc"
) &
PRODUCER=$!
log "producer started (pid $PRODUCER)"

s1=$(ls "${NAME}-s1-"*.index 2>/dev/null | wc -l)

completed_chunks() { # $1 = yes|no: exclude each worker's newest (in-progress) chunk
  local w files
  for w in $(seq 0 $((WORKERS - 1))); do
    files=$(ls "${NAME}-p${w}."*.index 2>/dev/null | sort)
    [ -z "$files" ] && continue
    if [ "$1" = yes ]; then files=$(echo "$files" | head -n -1); fi
    [ -n "$files" ] && echo "$files"
  done
}

merge_completed() { # $1 = yes|no (exclude in-progress), $2 = min batch size
  local files n out
  files=$(completed_chunks "$1")
  [ -z "$files" ] && return 0
  n=$(echo "$files" | grep -c .)
  [ "$n" -lt "$2" ] && return 0
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
  sleep 15
done
wait "$PRODUCER" 2>/dev/null

rc=$(cat "$NAME-pipeline.rc" 2>/dev/null || echo missing)
if [ "$rc" != 0 ]; then
  log "ERROR: producer pipeline rc=$rc ($(tail -c 300 "$NAME-remove-markup.err" 2>/dev/null))"
  exit 1
fi
log "producer finished cleanly"

while [ -n "$(completed_chunks no)" ]; do
  merge_completed no 1 || exit 1
done

log "final merge of $(ls "${NAME}-s1-"*.index | wc -l) stage-1 files (cutoff 5)"
if $NICE "$BIN/merge-indexes" 5 "${NAME}-s1-"*.index "$OUT"; then
  log "SUCCESS: $OUT ($(du -h "$OUT" | cut -f1))"
  rm -f "${NAME}-s1-"*.index
  log "cleaned up stage-1 files, free $(free_gb)G"
else
  log "ERROR: final merge failed"
  exit 1
fi
