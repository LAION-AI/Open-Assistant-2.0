import argparse
import sys
import uvicorn
from .config import load_config, save_config
from .redactor import setup_model, load_classifier

def run_config() -> None:
    config = load_config()
    print("--- Open Assistant Proxy Configuration ---")
    print("Leave empty to keep current value.\n")
    
    # Prompt user to register if they don't have an API key
    if not config.get("api_key"):
        print("NOTE: You must have an account on the Open Assistant website to generate an API key.")
        print("Please log in at https://oa.laion.ai/ and copy your key from the Settings panel.\n")
        
    api_key = input(f"Open Assistant API Key [{config['api_key']}]: ").strip()
    if api_key:
        config["api_key"] = api_key
        
    server_url = input(f"Open Assistant Server URL [{config['server_url']}]: ").strip()
    if server_url:
        config["server_url"] = server_url
        
    upstream_url = input(f"Upstream API Base URL [{config['upstream_url']}]: ").strip()
    if upstream_url:
        config["upstream_url"] = upstream_url
        
    upstream_key = input(f"Upstream API Key [{config['upstream_key']}]: ").strip()
    if upstream_key:
        config["upstream_key"] = upstream_key
        
    upstream_model = input(f"Upstream Default Model [{config['upstream_model']}]: ").strip()
    if upstream_model:
        config["upstream_model"] = upstream_model
        
    host_str = input(f"Local Proxy Host [{config['host']}]: ").strip()
    if host_str:
        config["host"] = host_str
        
    port_str = input(f"Local Proxy Port [{config['port']}]: ").strip()
    if port_str:
        try:
            config["port"] = int(port_str)
        except ValueError:
            print("Invalid port number. Keeping current value.")
            
    save_config(config)
    print("\nConfiguration saved successfully!")
    print("Now run `oa-proxy start` to start the proxy server.")

def run_setup() -> None:
    try:
        setup_model()
    except Exception as e:
        print(f"Setup failed: {e}", file=sys.stderr)
        sys.exit(1)

def run_start() -> None:
    config = load_config()
    
    # Verify setup has been run (model is cached)
    try:
        from huggingface_hub import HfApi
        from huggingface_hub.utils import LocalTokenNotFoundError
        # Just check if snapshot exists locally
        from huggingface_hub import snapshot_download
        # Try a quick offline-only download check
        snapshot_download(repo_id="openai/privacy-filter", local_files_only=True, ignore_patterns=["onnx/*", "original/*"])
    except Exception:
        print("PII Redactor model not found locally. Running setup first...")
        try:
            setup_model()
        except Exception:
            print("Setup failed. Cannot start proxy server.", file=sys.stderr)
            sys.exit(1)
            
    port = config.get("port", 2048)
    host = config.get("host", "127.0.0.1")
    print(f"Starting Open Assistant completions proxy server on http://{host}:{port}...")
    
    # Import uvicorn inside here to ensure it's not loaded on simple config queries
    from open_assistant_proxy.server import app
    uvicorn.run(app, host=host, port=port)

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Open Assistant 2.0 Local Completions Proxy and PII Redactor CLI"
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands to execute")
    
    subparsers.add_parser("config", help="Configure proxy settings (API keys, upstream url, port)")
    subparsers.add_parser("setup", help="Force download/verify the on-device PII redactor model")
    subparsers.add_parser("start", help="Start the local OpenAI-compatible completions proxy server")
    
    args = parser.parse_args()
    
    if args.command == "config":
        run_config()
    elif args.command == "setup":
        run_setup()
    elif args.command == "start":
        run_start()
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
