import os
import json
from pathlib import Path
from typing import Any, Dict

CONFIG_DIR = Path.home() / ".open_assistant"
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULT_CONFIG = {
    "api_key": "",
    "server_url": "https://oa.laion.ai/",
    "upstream_url": "https://api.openai.com/v1",
    "upstream_key": "",
    "upstream_model": "gpt-4o",
    "port": 1010
}

def load_config() -> Dict[str, Any]:
    if not CONFIG_FILE.exists():
        return DEFAULT_CONFIG.copy()
    try:
        with open(CONFIG_FILE, "r") as f:
            user_config = json.load(f)
            # Merge with defaults for any missing keys
            config = DEFAULT_CONFIG.copy()
            config.update(user_config)
            return config
    except Exception:
        return DEFAULT_CONFIG.copy()

def save_config(config: Dict[str, Any]) -> None:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_FILE, "w") as f:
            json.dump(config, f, indent=4)
    except Exception as e:
        print(f"Error saving configuration: {e}")
