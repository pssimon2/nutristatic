#!/bin/bash
# Build the full English Wikipedia Nutrimatic index with bounded disk usage.
#
# Streams the compressed dump through remove-markup | make-index, and
# concurrently merges completed 1M-chain chunk files (batches of >=50, cutoff
# 2) into stage-1 indexes, deleting the raw chunks as it goes. When the
# producer finishes, remaining chunks are merged and all stage-1 files merge
# into wiki-merged.index with frequency cutoff 5 (upstream's setting).
#
# Not resumable: on failure, remove wikipedia.*.index, s1-*.index and re-run.

set -u
cd ./data
BIN=./build-cpp
LOG=enwiki-build.log
MIN_FREE_GB=15

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
free_gb() { df -BG --output=avail / | tail -1 | tr -dc 0-9; }

log "=== build started ==="

( set -o pipefail
  lbzip2 -dc enwiki.xml.bz2 \
    | "$BIN/remove-markup" 2>remove-markup.err \
    | "$BIN/make-index" wikipedia
  echo $? > make-index.rc
) &
PRODUCER=$!
log "producer started (pid $PRODUCER)"

s1=$(ls s1-*.index 2>/dev/null | wc -l)

merge_completed() { # $1 = yes|no (exclude newest, possibly-in-progress chunk), $2 = min batch
  local exclude_last=$1 min=$2 files n out
  files=$(ls wikipedia.*.index 2>/dev/null | sort)
  [ -z "$files" ] && return 0
  if [ "$exclude_last" = yes ]; then files=$(echo "$files" | head -n -1); fi
  [ -z "$files" ] && return 0
  n=$(echo "$files" | grep -c .)
  [ "$n" -lt "$min" ] && return 0
  out=$(printf 's1-%04d.index' "$s1")
  log "merging $n chunks -> $out"
  # shellcheck disable=SC2086
  if "$BIN/merge-indexes" 2 $files "$out"; then
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

rc=$(cat make-index.rc 2>/dev/null || echo missing)
if [ "$rc" != 0 ]; then
  log "ERROR: producer pipeline rc=$rc ($(head -c 300 remove-markup.err 2>/dev/null))"
  exit 1
fi
log "producer finished cleanly"

merge_completed no 1 || exit 1

log "final merge of $(ls s1-*.index | wc -l) stage-1 files (cutoff 5)"
if "$BIN/merge-indexes" 5 s1-*.index wiki-merged.index; then
  log "SUCCESS: wiki-merged.index ($(du -h wiki-merged.index | cut -f1))"
else
  log "ERROR: final merge failed"
  exit 1
fi
