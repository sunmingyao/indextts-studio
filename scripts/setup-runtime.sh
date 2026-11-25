#!/bin/bash
set -euo pipefail

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CODE_ROOT="${INDEXTTS_CODE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
RUNTIME_ROOT="${INDEXTTS_RUNTIME_ROOT:-$CODE_ROOT/runtime}"
UV="${INDEXTTS_UV:-$CODE_ROOT/bin/uv}"
if [ ! -x "$UV" ]; then
  UV="$(command -v uv || true)"
fi
[ -x "$UV" ] || fail "uv not found. Bundle bin/uv or install uv first."

HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
PYPI_INDEX_URL="${PYPI_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}"
export HF_ENDPOINT
export HF_HUB_DISABLE_XET=1
export HF_HOME="$RUNTIME_ROOT/models/hf-cache"

BACKEND_ENV="$RUNTIME_ROOT/envs/backend"
MLX_ENV="$RUNTIME_ROOT/envs/mlx"
MPS_ENV="$RUNTIME_ROOT/envs/mps"
MLX_MODEL="$RUNTIME_ROOT/models/mlx"
MPS_MODEL="$RUNTIME_ROOT/models/mps/checkpoints"

mkdir -p "$RUNTIME_ROOT/envs" "$RUNTIME_ROOT/models" "$MLX_MODEL" "$MPS_MODEL" "$RUNTIME_ROOT/models/mps/hf"

log "Runtime root: $RUNTIME_ROOT"
log "Code root: $CODE_ROOT"
log "uv: $UV"
log "HF endpoint: $HF_ENDPOINT"
log "PyPI index: $PYPI_INDEX_URL"

if [ ! -x "$BACKEND_ENV/bin/python" ]; then
  log "Creating backend environment"
  "$UV" venv --python 3.11 "$BACKEND_ENV"
  "$UV" pip install --python "$BACKEND_ENV/bin/python" --index-url "$PYPI_INDEX_URL" -r "$CODE_ROOT/backend/requirements.txt"
else
  log "Backend environment already exists"
fi

if [ ! -x "$MLX_ENV/bin/python" ]; then
  log "Creating MLX environment"
  "$UV" venv --python 3.11 "$MLX_ENV"
  "$UV" pip install --python "$MLX_ENV/bin/python" --index-url "$PYPI_INDEX_URL" "index-tts-2.5-mlx==0.1.1"
else
  log "MLX environment already exists"
fi

if [ ! -x "$MPS_ENV/bin/python" ]; then
  log "Creating MPS environment from vendored official source"
  ( cd "$CODE_ROOT/vendor/index-tts" && UV_PROJECT_ENVIRONMENT="$MPS_ENV" "$UV" sync --frozen --extra webui --default-index "$PYPI_INDEX_URL" )
else
  log "MPS environment already exists"
fi

MLX_PY="$MLX_ENV/bin/python"
MPS_PY="$MPS_ENV/bin/python"

if [ ! -f "$MLX_MODEL/gpt_int8.safetensors" ]; then
  log "Downloading IndexTTS-2.5 MLX weights (~5GB)"
  "$MLX_PY" - "$MLX_MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="yunfengwang/IndexTTS-2.5-mlx",
    local_dir=sys.argv[1],
)
PY
else
  log "MLX weights already exist"
fi

if [ ! -f "$MPS_MODEL/gpt.pth" ]; then
  log "Downloading IndexTTS-2.5 MPS checkpoints (~6GB)"
  "$MLX_PY" - "$MPS_MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="IndexTeam/IndexTTS-2.5",
    local_dir=sys.argv[1],
)
PY
else
  log "MPS checkpoints already exist"
fi

if [ ! -d "$MPS_MODEL/hf_cache/w2v-bert-2.0" ] || [ ! -d "$MPS_MODEL/hf_cache/bigvgan" ]; then
  log "Downloading MPS auxiliary models (w2v-bert / BigVGAN / campplus)"
  "$MPS_PY" - "$MPS_MODEL" <<'PY'
import sys
from indextts.utils.model_download import ensure_models_available
ensure_models_available(sys.argv[1])
PY
else
  log "MPS auxiliary models already exist"
fi

printf '{"installedAt":"%s","runtimeRoot":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUNTIME_ROOT" > "$RUNTIME_ROOT/.setup-complete"
log "Setup complete"
printf 'SETUP_OK\n'