#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
FF=/home/ademola/sightline/node_modules/ffmpeg-static/ffmpeg
OUT=../till-launch-film.mp4
FPS=${FPS:-60}

rm -rf build/frames
rm -rf /tmp/till-film-chrome
google-chrome --headless=new --remote-debugging-port=9222 --hide-scrollbars \
  --window-size=1920,1080 --force-device-scale-factor=1 \
  --allow-file-access-from-files --disable-gpu --disable-extensions \
  --no-first-run --no-default-browser-check --user-data-dir=/tmp/till-film-chrome \
  "file://$PWD/film.html" > /tmp/till-chrome.log 2>&1 &
CHROME=$!
trap 'kill $CHROME 2>/dev/null || true; pkill -f till-film-chrome 2>/dev/null || true' EXIT
sleep 5

node render.mjs 9222 "$FPS" 0 -1 build/frames

echo "[encode] $OUT"
"$FF" -y -hide_banner -loglevel warning \
  -framerate "$FPS" -i build/frames/%05d.jpg \
  -i build/audio/mix.wav \
  -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -profile:v high -level 4.2 \
  -x264-params "keyint=120:min-keyint=60" \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart -shortest \
  "$OUT"

ls -lh "$OUT"
