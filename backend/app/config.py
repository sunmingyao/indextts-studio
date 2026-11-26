from __future__ import annotations

import json
import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = Path(
    os.environ.get("INDEXTTS_RUNTIME_ROOT") or PROJECT_ROOT / "runtime"
).expanduser().resolve()


def resolve_path(value: str | None, base: Path) -> Path | None:
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base / path
    return path


def project_path(value: str | None) -> Path | None:
    return resolve_path(value, PROJECT_ROOT)


def runtime_path(value: str | None) -> Path | None:
    return resolve_path(value, RUNTIME_ROOT)


def load_config() -> dict:
    config_path = project_path(os.environ.get("INDEXTTS_CONFIG") or "config/default.json")
    if not config_path or not config_path.exists():
        raise FileNotFoundError(f"Config not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)

    data_value = os.environ.get("INDEXTTS_DATA_DIR") or config.get("dataDir", "data")
    config["_config_path"] = str(config_path)
    config["_project_root"] = str(PROJECT_ROOT)
    config["_runtime_root"] = str(RUNTIME_ROOT)
    config["_data_dir"] = str(project_path(data_value))

    data_dir = Path(config["_data_dir"])
    (data_dir / "voices").mkdir(parents=True, exist_ok=True)
    (data_dir / "outputs").mkdir(parents=True, exist_ok=True)

    for engine in config.get("engines", {}).values():
        engine["_python"] = str(runtime_path(engine.get("python")))
        engine["_worker"] = str(project_path(engine.get("worker")))
        engine["_model_dir"] = str(runtime_path(engine.get("modelDir")))
        engine["_hf_home"] = str(runtime_path(engine.get("hfHome")))

    translator = config.get("translator", {})
    translator["_python"] = str(runtime_path(translator.get("python")))
    translator["_worker"] = str(project_path(translator.get("worker")))
    translator["_asr_model"] = str(runtime_path(translator.get("asrModel")))
    translator["_aligner_model"] = str(runtime_path(translator.get("alignerModel")))
    translator["_llm_model"] = str(runtime_path(translator.get("llmModel")))
    translator["_hf_home"] = str(runtime_path(translator.get("hfHome")))
    return config