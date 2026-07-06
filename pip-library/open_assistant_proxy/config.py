import os
import json
import secrets
from pathlib import Path
from typing import Any, Dict

CONFIG_DIR = Path.home() / ".open_assistant"
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULT_CONFIG = {
    "api_key": "",
    "proxy_api_key": "",
    "server_url": "https://oa.laion.ai/",
    "upstream_url": "https://api.openai.com/v1",
    "upstream_key": "",
    "upstream_model": "gpt-4o",
    "port": 2048,
    "host": "127.0.0.1"
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


def ensure_proxy_api_key() -> str:
    """Ensure a proxy API key exists, generating one if needed. Returns the key."""
    cfg = load_config()
    if not cfg.get("proxy_api_key"):
        cfg["proxy_api_key"] = secrets.token_urlsafe(32)
        save_config(cfg)
        print(f"Generated proxy API key: {cfg['proxy_api_key']}")
    return cfg["proxy_api_key"]


def rotate_proxy_api_key() -> str:
    """Generate a fresh proxy API key, persist it, and return it."""
    cfg = load_config()
    cfg["proxy_api_key"] = secrets.token_urlsafe(32)
    save_config(cfg)
    return cfg["proxy_api_key"]
