#!/bin/bash
# Second-wave language builds: Portuguese, Polish, Czech, Swedish, Catalan,
# Indonesian, Turkish. Waits for the first wave (it/nl/es/fr) to finish so
# builds never compete for cores; a separate chain downloads the dumps.
# Meant to run detached (nohup); logs to latin-langs2.log.
set -u
cd ./data
MAIN_LOG=latin-langs2.log
log() { echo "$(date '+%F %T') $*" >> "$MAIN_LOG"; }

declare -A EXPECTED=(
  [pt]=2697906879
  [pl]=2722144556
  [cs]=1293407261
  [sv]=1564343399
  [ca]=1387411330
  [id]=1232894346
  [tr]=1048837152
)
FILTER="sed -f ./tools/latin-fold.sed"

log "waiting for first-wave builds to finish"
while ! grep -q "ALL DONE" latin-langs.log 2>/dev/null; do sleep 60; done
log "first wave done; starting second wave"

for lang in pt pl cs sv ca id tr; do
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
log "ALL DONE (second wave)"
