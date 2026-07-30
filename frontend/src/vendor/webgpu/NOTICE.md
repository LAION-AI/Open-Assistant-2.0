# Vendored WebGPU model runtimes

These minified JavaScript runtimes are vendored under the repository's Apache
License 2.0:

- `bonsai-27b.js` was extracted without semantic changes from the
  `<script type="module">` runtime in
  `webml-community/bonsai-webgpu-kernels/index.html`, Space commit
  `baf1a20b9fc7e12da1787764ede3abd5760ff188`. The extraction ends immediately
  after the module's public `Bonsai27B` exports and intentionally excludes the
  demo page UI.
- `gemma-4-e2b.js` is the unmodified
  `webml-community/gemma-4-webgpu-kernels/gemma-4-e2b.js`, Space commit
  `158f16ae0f672943ca304d59c47c8e3a264e399e`.

Upstream Spaces:

- https://huggingface.co/spaces/webml-community/bonsai-webgpu-kernels
- https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels

Model weights are fetched directly by the browser from their Apache-2.0 model
repositories and are not stored in this source repository.
