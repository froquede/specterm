#!/bin/bash
# mdview - open a markdown file in Specterm
# Usage: mdview [--tab] <file.md>

MODE="split"
if [ "$1" = "--tab" ]; then
  MODE="tab"
  shift
fi

FILE="$1"
if [ -z "$FILE" ]; then
  echo "Usage: mdview [--tab] <file.md>" >&2
  exit 1
fi

# Resolve to absolute path
FILE="$(realpath "$FILE" 2>/dev/null || readlink -f "$FILE")"

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE" >&2
  exit 1
fi

# Emit OSC 1337 escape sequence
printf '\e]1337;OpenMD;path=%s;mode=%s\a' "$FILE" "$MODE"
