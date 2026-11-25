#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
UV="${INDEXTTS_UV:-$ROOT/bin/uv}"
[ -x "$UV" ] || UV="$(command -v uv)"

mkdir -p "$ROOT/runtime/envs"
if [ ! -x "$ROOT/runtime/envs/backend/bin/python" ]; then
  "$UV" venv --python 3.11 "$ROOT/runtime/envs/backend"
fi
"$UV" pip install \
  --python "$ROOT/runtime/envs/backend/bin/python" \
  --index-url "${PYPI_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}" \
  -r "$ROOT/backend/requirements.txt"

echo "Backend ready: $ROOT/runtime/envs/backend/bin/python"