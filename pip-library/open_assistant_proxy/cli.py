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

def run_upload(args) -> None:
    """Parse locally saved agent sessions and upload them as traces."""
    from .traces import collect_traces

    traces, notes = collect_traces(args.paths)
    if args.platform:
        traces = [t for t in traces if t["platform"] in args.platform]
    for n in notes:
        print(f"  ! {n}")
    if not traces:
        print("No conversation traces found.")
        sys.exit(1)

    print(f"Found {len(traces)} conversation(s):")
    for t in traces:
        print(f"  [{t['platform']:>13}] {t['turns']:>3} turn(s)  {t['title'][:60]}  ({t['file']})")

    if args.dry_run:
        print("\nDry run — nothing uploaded.")
        return

    config = load_config()
    if not config.get("api_key"):
        print("\nNo Open Assistant API key configured. Run `oa-proxy config` first.", file=sys.stderr)
        sys.exit(1)

    # On-device redaction before anything leaves the machine (same layers as
    # the live proxy: secret patterns + PII NER, applied to the normalized
    # messages AND the verbatim source copy). --no-redact skips it.
    classifier = None
    if not args.no_redact:
        from .redactor import redact_messages, redact_source_text
        print("\nLoading on-device PII redactor…")
        classifier = load_classifier()
        cache: dict = {}
        for i, t in enumerate(traces, 1):
            print(f"Redacting {i}/{len(traces)}…", end="\r")
            t["messages"] = redact_messages(t["messages"], classifier, True, cache)
            if t.get("source"):
                t["source"]["text"] = redact_source_text(
                    t["source"]["text"], t["source"].get("kind", "jsonl"), classifier, True, cache)
        print()

    import httpx

    server_url = config.get("server_url", "https://oa.laion.ai/").rstrip("/")
    upload_url = server_url + config.get("ingest_path", "/proxy/api/ingest")
    headers = {"Content-Type": "application/json",
               "Authorization": f"Bearer {config['api_key']}"}

    saved = 0
    # One trace per request: payloads carry full sources and single failures
    # shouldn't sink the batch.
    for i, t in enumerate(traces, 1):
        payload = {"traces": [{
            "model": t["model"],
            # `trace:` prefix files these under the local-trace tab in the UI
            # (live pip captures keep their own `pip-library` marker).
            "platform": f"trace:{t['platform']}"[:40],
            "conversation_id": t["conversation_id"],
            "messages": t["messages"],
            **({"source": t["source"]} if t.get("source") else {}),
        }]}
        try:
            res = httpx.post(upload_url, json=payload, headers=headers, timeout=60.0)
            if res.status_code == 200:
                saved += res.json().get("saved", 0)
                print(f"  ✓ {i}/{len(traces)} {t['title'][:60]}")
            else:
                print(f"  ✗ {i}/{len(traces)} HTTP {res.status_code}: {res.text[:200]}")
        except Exception as e:
            print(f"  ✗ {i}/{len(traces)} {e}")
    print(f"\nUploaded {saved}/{len(traces)} trace(s) to {server_url}."
          + ("" if args.no_redact else " (PII redacted on-device)"))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Open Assistant 2.0 Local Completions Proxy and PII Redactor CLI"
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands to execute")

    subparsers.add_parser("config", help="Configure proxy settings (API keys, upstream url, port)")
    subparsers.add_parser("setup", help="Force download/verify the on-device PII redactor model")
    subparsers.add_parser("start", help="Start the local OpenAI-compatible completions proxy server")

    up = subparsers.add_parser(
        "upload",
        help="Parse and upload locally saved agent sessions (Claude Code, Codex, "
             "pi, command-code, Crush, Hermes, OpenCode)")
    up.add_argument("paths", nargs="+", help="Session files or folders to scan "
                    "(e.g. ~/.claude/projects, ~/.codex/sessions, a pod's config dir)")
    up.add_argument("--dry-run", action="store_true", help="List what would be uploaded and exit")
    up.add_argument("--no-redact", action="store_true",
                    help="Skip on-device PII redaction (uploads raw text!)")
    up.add_argument("--platform", action="append",
                    help="Only upload traces of this platform (repeatable), "
                         "e.g. --platform claude-code")

    args = parser.parse_args()

    if args.command == "config":
        run_config()
    elif args.command == "setup":
        run_setup()
    elif args.command == "start":
        run_start()
    elif args.command == "upload":
        run_upload(args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
