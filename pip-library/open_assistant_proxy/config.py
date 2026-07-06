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
    # Path (on server_url) that redacted traces are uploaded to. Defaults to the
    # backend ingestion route; override if pointing at the frontend upload path.
    "ingest_path": "/proxy/api/ingest",
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


# Cheap mtime-based cache so request handlers don't do a blocking disk read (and
# JSON parse) on every single proxied request.
_config_cache: Dict[str, Any] = {"data": None, "mtime": None}


def load_config_cached() -> Dict[str, Any]:
    try:
        mtime = CONFIG_FILE.stat().st_mtime
    except OSError:
        mtime = None
    if _config_cache["data"] is None or _config_cache["mtime"] != mtime:
        _config_cache["data"] = load_config()
        _config_cache["mtime"] = mtime
    return _config_cache["data"]


def invalidate_config_cache() -> None:
    _config_cache["data"] = None
    _config_cache["mtime"] = None


def save_config(config: Dict[str, Any]) -> None:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_FILE, "w") as f:
            json.dump(config, f, indent=4)
        invalidate_config_cache()
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
