#!/usr/bin/env bash
set -euo pipefail

CODE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${INDEXTTS_RUNTIME_ROOT:-$CODE_ROOT/runtime}"
UV="${INDEXTTS_UV:-$CODE_ROOT/bin/uv}"
PYPI_INDEX_URL="${PYPI_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}"
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
TRANSLATE_ENV="$RUNTIME_ROOT/envs/translate"
MODELS_ROOT="$RUNTIME_ROOT/models"

mkdir -p "$RUNTIME_ROOT/envs" "$MODELS_ROOT"

if [ ! -x "$TRANSLATE_ENV/bin/python" ]; then
  "$UV" venv --python 3.11 "$TRANSLATE_ENV"
fi

"$UV" pip install --python "$TRANSLATE_ENV/bin/python" \
  --index-url "$PYPI_INDEX_URL" \
  "mlx-audio[stt]" mlx-lm soundfile nagisa soynlp fastapi uvicorn

export HF_ENDPOINT HF_HUB_DISABLE_XET=1
export INDEXTTS_RUNTIME_ROOT="$RUNTIME_ROOT"
"$TRANSLATE_ENV/bin/python" - <<'PY'
import os
from pathlib import Path

from huggingface_hub import snapshot_download

root = Path(os.environ["INDEXTTS_RUNTIME_ROOT"]) / "models"
models = {
    "qwen3-asr-0.6b": "mlx-community/Qwen3-ASR-0.6B-4bit",
    "qwen3-forced-aligner-0.6b": "mlx-community/Qwen3-ForcedAligner-0.6B-8bit",
    "qwen3-4b-instruct": "mlx-community/Qwen3-4B-Instruct-2507-4bit",
}
for name, repo_id in models.items():
    target = root / name
    print(f"[translate-setup] {repo_id} -> {target}", flush=True)
    snapshot_download(repo_id=repo_id, local_dir=str(target), max_workers=4)
print("[translate-setup] models ready", flush=True)
PY

touch "$RUNTIME_ROOT/.translate-setup-complete"
echo "[translate-setup] complete"