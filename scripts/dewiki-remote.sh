#!/bin/bash
# Runs ON THE SERVER (klartextlaw): download the dewiki dump to the volume,
# then build the German index with umlaut transliteration. Everything niced
# so Caddy and the hosted sites always win. Meant to run detached (nohup).
set -u
export DATA_DIR=/srv/nutrimatic-build
export BIN=$HOME/nutrimatic-build/bin
export NICE="nice -n 19 ionice -c3"
export MIN_FREE_GB=8
mkdir -p "$DATA_DIR" || { echo "cannot create $DATA_DIR" >&2; exit 1; }
cd "$DATA_DIR" || exit 1
LOG=dewiki-build.log
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

EXPECTED=7929283973
if [ "$(stat -c%s dewiki.xml.bz2 2>/dev/null || echo 0)" != "$EXPECTED" ]; then
  log "downloading dewiki dump ($EXPECTED bytes)"
  $NICE curl -sL -o dewiki.xml.bz2 --retry 10 --retry-delay 15 -C - \
    https://dumps.wikimedia.org/dewiki/latest/dewiki-latest-pages-articles.xml.bz2
  sz=$(stat -c%s dewiki.xml.bz2 2>/dev/null || echo 0)
  if [ "$sz" != "$EXPECTED" ]; then
    log "ERROR: download incomplete ($sz of $EXPECTED bytes)"
    exit 1
  fi
fi
log "dump present, starting build"

TRANSLIT="sed -e 's/ä/ae/g; s/ö/oe/g; s/ü/ue/g; s/ß/ss/g; s/Ä/Ae/g; s/Ö/Oe/g; s/Ü/Ue/g; s/ẞ/Ss/g'"
exec bash "$HOME/nutrimatic-build/build-wiki.sh" dewiki dewiki.xml.bz2 dewiki-merged.index "$TRANSLIT"
