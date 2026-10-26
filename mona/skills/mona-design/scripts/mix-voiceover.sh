#!/usr/bin/env bash
# mix-voiceover.sh · Mix narration with an MP4's existing audio when present
#
# Usage:
#   bash mix-voiceover.sh <video.mp4> --voiceover=<voice.mp3> [options]
#
# Required:
#   --voiceover=<path>    Path to voiceover mp3 (人声主轨, 来自 narrate-pipeline.mjs)
#
# Optional:
#   --voice-volume=<0-2>  人声音量倍率, 默认 1.0
#   --out=<path>          输出路径, 默认 <input>-voiced.mp4
#
# Behavior:
#   - 视频流 stream copy（不重编码，快）
#   - 保留视频画面；视频已有音轨时与旁白混合
#   - 输出长度与视频一致，旁白较短时补静音，较长时按视频时长截断
#
# Examples:
#   bash mix-voiceover.sh anim.mp4 --voiceover=narration/voiceover.mp3
#   bash mix-voiceover.sh anim.mp4 --voiceover=v.mp3
#
set -e

INPUT=""
VOICEOVER=""
VOICE_VOLUME="1.0"
OUTPUT=""

for arg in "$@"; do
  case "$arg" in
    --voiceover=*)    VOICEOVER="${arg#*=}" ;;
    --voice-volume=*) VOICE_VOLUME="${arg#*=}" ;;
    --out=*)          OUTPUT="${arg#*=}" ;;
    -*)               echo "未知参数：$arg" >&2; exit 1 ;;
    *)                INPUT="$arg" ;;
  esac
done

if [ -z "$INPUT" ] || [ ! -f "$INPUT" ]; then
  echo "Usage: bash mix-voiceover.sh <video.mp4> --voiceover=<v.mp3> [--voice-volume=<0-2>] [--out=<path>]" >&2
  exit 1
fi
if [ -z "$VOICEOVER" ] || [ ! -f "$VOICEOVER" ]; then
  echo "✗ 缺 --voiceover=<path>" >&2
  exit 1
fi

# 输出路径
if [ -z "$OUTPUT" ]; then
  base="${INPUT%.*}"
  OUTPUT="${base}-voiced.mp4"
fi

echo "─ mix-voiceover ──────────────"
echo "  视频:     $INPUT"
echo "  人声:     $VOICEOVER (vol=$VOICE_VOLUME)"
echo "  输出:     $OUTPUT"
echo "──────────────────────────────"

VIDEO_DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$INPUT")
if [ -z "$VIDEO_DURATION" ]; then
  echo "✗ 无法读取视频时长: $INPUT" >&2
  exit 1
fi

SOURCE_AUDIO=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$INPUT" | head -1)
if [ -n "$SOURCE_AUDIO" ]; then
  # 保留源音轨中的音效等内容，并加入旁白。
  ffmpeg -y -i "$INPUT" -i "$VOICEOVER" \
    -filter_complex "[0:a]volume=1[source];[1:a]volume=${VOICE_VOLUME}[voice];[source][voice]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=${VIDEO_DURATION}[a]" \
    -map 0:v -map "[a]" \
    -c:v copy -c:a aac -b:a 192k -t "$VIDEO_DURATION" \
    "$OUTPUT"
else
  ffmpeg -y -i "$INPUT" -i "$VOICEOVER" \
    -filter_complex "[1:a]volume=${VOICE_VOLUME},apad,atrim=duration=${VIDEO_DURATION}[a]" \
    -map 0:v -map "[a]" \
    -c:v copy -c:a aac -b:a 192k -t "$VIDEO_DURATION" \
    "$OUTPUT"
fi

echo "✓ 完成：$OUTPUT"
