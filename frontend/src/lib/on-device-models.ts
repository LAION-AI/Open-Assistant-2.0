export type OnDeviceModelId = "bonsai-27b-q1" | "gemma-4-e2b";

export interface OnDeviceModelOption {
  id: OnDeviceModelId;
  label: string;
  detail: string;
  downloadBytes: number;
  logModel: string;
  modelCard: string;
}

export interface OnDeviceProgressEvent {
  status: "init" | "tokenizer" | "weights" | "ready" | string;
  kind?: "bytes" | "tensors";
  message?: string;
  loaded?: number;
  total?: number | null;
  fraction?: number;
  fromCache?: boolean;
}

export interface OnDeviceLoadProgress {
  label: string;
  fraction?: number;
  loadedBytes?: number;
  totalBytes?: number;
}

export interface OnDeviceChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface RuntimeToken {
  delta?: string;
  text?: string;
}

interface BrowserChatRuntime {
  chatTemplateArgs?: Record<string, unknown>;
  generate(
    messages: OnDeviceChatMessage[],
    options?: { signal?: AbortSignal; maxNewTokens?: number },
  ): AsyncIterable<RuntimeToken>;
  warmup?(): Promise<void>;
  reset(): void;
  dispose(): void;
}

interface LoadedSession {
  id: OnDeviceModelId;
  runtime: BrowserChatRuntime;
}

export const ON_DEVICE_MODELS: readonly OnDeviceModelOption[] = [
  {
    id: "bonsai-27b-q1",
    label: "Bonsai 27B 1-bit",
    detail: "27B · Q1_0 GGUF · custom WebGPU kernels",
    downloadBytes: 3_803_452_480,
    logModel: "local/bonsai-27b-q1",
    modelCard: "https://huggingface.co/prism-ml/Bonsai-27B-gguf",
  },
  {
    id: "gemma-4-e2b",
    label: "Gemma 4 E2B",
    detail: "2.3B effective params · QAT Mobile · WebGPU",
    downloadBytes: 2_490_281_472,
    logModel: "local/gemma-4-e2b",
    modelCard: "https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers",
  },
] as const;

let activeSession: LoadedSession | null = null;
let loadingSession: { id: OnDeviceModelId; promise: Promise<LoadedSession> } | null = null;

export function getOnDeviceModel(id: OnDeviceModelId): OnDeviceModelOption {
  const option = ON_DEVICE_MODELS.find(item => item.id === id);
  if (!option) throw new Error(`Unknown on-device model: ${id}`);
  return option;
}

export function onDeviceModelFromLogName(model: string): OnDeviceModelOption | null {
  return ON_DEVICE_MODELS.find(item => item.logModel === model) ?? null;
}

export function getLoadedOnDeviceModelId(): OnDeviceModelId | null {
  return activeSession?.id ?? null;
}

export function hasWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function formatModelBytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function describeOnDeviceProgress(event: OnDeviceProgressEvent): OnDeviceLoadProgress {
  if (event.status === "init") {
    return { label: event.message || "Requesting WebGPU device…" };
  }
  if (event.status === "tokenizer") {
    return { label: event.message || "Loading tokenizer…" };
  }
  if (event.status === "ready") {
    return { label: "Ready", fraction: 1 };
  }
  if (event.status === "weights" && event.kind === "bytes") {
    const loaded = finite(event.loaded) ? event.loaded : undefined;
    const total = finite(event.total) && event.total > 0 ? event.total : undefined;
    const fraction =
      finite(event.fraction) ? Math.max(0, Math.min(1, event.fraction)) :
      loaded !== undefined && total !== undefined ? Math.max(0, Math.min(1, loaded / total)) :
      undefined;
    const verb = event.fromCache ? "Loading cached weights" : "Downloading weights";
    const amounts =
      loaded !== undefined && total !== undefined
        ? ` · ${formatModelBytes(loaded)} / ${formatModelBytes(total)}`
        : "";
    return {
      label: `${verb}${amounts}`,
      fraction,
      loadedBytes: loaded,
      totalBytes: total,
    };
  }
  if (event.status === "weights" && event.kind === "tensors") {
    const counts =
      finite(event.loaded) && finite(event.total) && event.total > 0
        ? ` · ${Math.round(event.loaded)} / ${Math.round(event.total)}`
        : "";
    return { label: `${event.message || "Uploading weights to GPU"}${counts}` };
  }
  return { label: event.message || "Loading model…" };
}

async function createSession(
  id: OnDeviceModelId,
  onProgress: (event: OnDeviceProgressEvent) => void,
  signal?: AbortSignal,
): Promise<LoadedSession> {
  if (!hasWebGpu()) {
    throw new Error("WebGPU is unavailable. Use a recent Chrome, Edge, or Safari release with WebGPU enabled.");
  }
  if (signal?.aborted) throw new DOMException("Model load cancelled", "AbortError");

  if (id === "bonsai-27b-q1") {
    const module = await import("../vendor/webgpu/bonsai-27b.js");
    const runtime = (await module.Bonsai27B.load(null, {
      signal,
      onProgress,
    })) as BrowserChatRuntime;
    // Keep reasoning tokens in the generated content, but do not force a
    // thinking turn when the chat UI has no reasoning-effort control.
    runtime.chatTemplateArgs = { enable_thinking: false, preserve_thinking: true };
    return { id, runtime };
  }

  const module = await import("../vendor/webgpu/gemma-4-e2b.js");
  const runtime = (await module.Gemma4Mobile.load(null, {
    signal,
    onProgress,
  })) as BrowserChatRuntime;
  onProgress({ status: "weights", kind: "tensors", message: "Compiling and warming up WebGPU kernels" });
  await runtime.warmup?.();
  if (signal?.aborted) {
    runtime.dispose();
    throw new DOMException("Model load cancelled", "AbortError");
  }
  onProgress({ status: "ready", message: "Ready", fraction: 1 });
  return { id, runtime };
}

export async function loadOnDeviceModel(
  id: OnDeviceModelId,
  options: {
    onProgress?: (event: OnDeviceProgressEvent) => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  if (activeSession?.id === id) return;
  if (loadingSession?.id === id) {
    await loadingSession.promise;
    return;
  }
  if (loadingSession) throw new Error("Another on-device model is already loading.");

  disposeOnDeviceModel();
  const promise = createSession(id, options.onProgress ?? (() => {}), options.signal);
  loadingSession = { id, promise };
  try {
    activeSession = await promise;
  } finally {
    if (loadingSession?.promise === promise) loadingSession = null;
  }
}

export function resetOnDeviceModel(): void {
  activeSession?.runtime.reset();
}

export function disposeOnDeviceModel(): void {
  activeSession?.runtime.dispose();
  activeSession = null;
}

export async function* streamOnDeviceResponse(
  id: OnDeviceModelId,
  messages: OnDeviceChatMessage[],
  options: { signal?: AbortSignal; maxNewTokens?: number } = {},
): AsyncGenerator<string> {
  if (!activeSession || activeSession.id !== id) {
    throw new Error(`${getOnDeviceModel(id).label} is not loaded.`);
  }

  let rendered = "";
  for await (const token of activeSession.runtime.generate(messages, {
    signal: options.signal,
    maxNewTokens: options.maxNewTokens ?? 4096,
  })) {
    let delta = typeof token.delta === "string" ? token.delta : "";
    if (!delta && typeof token.text === "string") {
      delta = token.text.startsWith(rendered) ? token.text.slice(rendered.length) : token.text;
    }
    if (!delta) continue;
    rendered = typeof token.text === "string" ? token.text : rendered + delta;
    yield delta;
  }
}
