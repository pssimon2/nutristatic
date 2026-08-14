#!/bin/bash
# Waits for the enwiki dump download to finish, sanity-checks it, then runs
# the rolling index build. Meant to run detached (nohup).
set -u
cd ./data
LOG=enwiki-build.log

echo "$(date '+%F %T') orchestrator: waiting for download" >> "$LOG"
while pgrep -f 'curl.*enwiki-latest-pages-articles' > /dev/null; do sleep 30; done

sz=$(stat -c%s enwiki.xml.bz2 2>/dev/null || echo 0)
if [ "$sz" -lt 15000000000 ]; then
  echo "$(date '+%F %T') ERROR: dump looks too small ($sz bytes) — download failed?" >> "$LOG"
  exit 1
fi
echo "$(date '+%F %T') orchestrator: dump complete ($sz bytes), starting build" >> "$LOG"
exec bash ./scripts/build-enwiki.sh
