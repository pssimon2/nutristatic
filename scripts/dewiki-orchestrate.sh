#!/bin/bash
# Waits for (a) the dewiki dump download and (b) the enwiki build to finish,
# frees disk, then builds the German index with umlaut transliteration.
# Meant to run detached (nohup).
set -u
cd ./data
LOG=dewiki-build.log
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

log "orchestrator: waiting for dewiki download and enwiki build"

# Wait for the dewiki download (curl exits) and full expected size.
while pgrep -f 'curl.*dewiki-latest-pages-articles' > /dev/null; do sleep 60; done
sz=$(stat -c%s dewiki.xml.bz2 2>/dev/null || echo 0)
if [ "$sz" -lt 7900000000 ]; then
  log "ERROR: dewiki dump too small ($sz bytes) — download failed?"
  exit 1
fi
log "dewiki dump complete ($sz bytes)"

# Wait for the enwiki build to reach a terminal state.
while :; do
  if grep -qE 'SUCCESS: wiki-merged.index' enwiki-build.log 2>/dev/null; then
    log "enwiki build succeeded; cleaning its stage-1 files"
    rm -f s1-*.index
    break
  fi
  if grep -qE '^.*ERROR' enwiki-build.log 2>/dev/null && \
     ! pgrep -f 'make-index wikipedia' > /dev/null; then
    log "WARNING: enwiki build ended with errors; proceeding anyway"
    break
  fi
  sleep 120
done

# German transliteration: umlauts/eszett get their standard ASCII digraphs;
# all other non-ASCII behaves like upstream (word break).
TRANSLIT="sed -e 's/ä/ae/g; s/ö/oe/g; s/ü/ue/g; s/ß/ss/g; s/Ä/Ae/g; s/Ö/Oe/g; s/Ü/Ue/g; s/ẞ/Ss/g'"

log "starting dewiki build"
exec bash ./scripts/build-wiki.sh dewiki dewiki.xml.bz2 dewiki-merged.index "$TRANSLIT"
