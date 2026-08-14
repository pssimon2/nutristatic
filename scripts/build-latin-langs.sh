#!/bin/bash
# Build Italian, Dutch, Spanish, French Wikipedia indexes in order: wait for
# each dump (chain-downloaded separately), run the parallel build with
# diacritic folding, build the .idxz sidecar, and upload index + sidecar to
# the server. Meant to run detached (nohup); logs to latin-langs.log.
set -u
cd ./data
MAIN_LOG=latin-langs.log
log() { echo "$(date '+%F %T') $*" >> "$MAIN_LOG"; }

declare -A EXPECTED=(
  [it]=4224634881
  [nl]=2036083695
  [es]=5168277554
  [fr]=6959602859
)
FILTER="sed -f ./tools/latin-fold.sed"

for lang in it nl es fr; do
  dump="${lang}wiki.xml.bz2"
  out="${lang}wiki-merged.index"

  log "waiting for $dump (${EXPECTED[$lang]} bytes)"
  while [ "$(stat -c%s "$dump" 2>/dev/null || echo 0)" != "${EXPECTED[$lang]}" ]; do
    sleep 30
  done
  log "$dump complete; building"

  if ! NAME="${lang}wiki" LOG="${lang}wiki-build.log" WORKERS=14 NICE='nice -n 5' \
       DATA_DIR=./data \
       bash ./scripts/build-wiki-par.sh "${lang}wiki" "$dump" "$out" "$FILTER"; then
    log "ERROR: $lang build failed (see ${lang}wiki-build.log)"
    continue
  fi
  log "$lang index built: $(du -h "$out" | cut -f1)"

  if ! npx tsx ./cli/compress-index.ts "$out" 2>>"$MAIN_LOG"; then
    log "ERROR: $lang sidecar build failed"
    continue
  fi

  if rsync -a --partial --inplace "$out" \
       "simon@example.com:/srv/nutristatic/${lang}-wiki.index" &&
     rsync -a --partial --inplace "$out.idxz" \
       "simon@example.com:/srv/nutristatic/${lang}-wiki.index.idxz"; then
    log "SUCCESS: $lang uploaded ($(du -h "$out" | cut -f1) + sidecar)"
  else
    log "ERROR: $lang upload failed"
  fi
done
log "ALL DONE"
