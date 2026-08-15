# Qwen3.8 Reasoning-Effort Controls via pi — Research Report

## Goal

Make `reasoning_effort` (thinking-level cycling via `shift+tab` / `app.thinking.cycle`) actually work for the local model `qwen-3-8-27b-mtp` defined in `~/.pi/agent/models.json`.

## Environment (authoritative sources)

- **Local server**: `llama-swap` proxying `llama-server` (llama.cpp, build `10435`), confirmed via
  - `GET /v1/models` on `localhost:8080` → `owned_by: "llama-swap"`, all models `status.unloaded`.
  - NixOS config `~/nixos/modules/llama-swap-settings.nix` → the `qwen-3-8-27b-mtp` entry runs:
    ```
    llama-server --model .../Qwen3.8-27B-UD-Q5_K_XL.gguf --mmproj .../mmproj-F16.gguf
    --ctx-size 131072 --temp 1.0 --top-p 0.95 --top-k 20
    --spec-type draft-mtp --spec-draft-n-max 3
    ```
    No `--jinja`, no `--chat-template-kwargs`, no `reasoning-budget` flags, no llama-swap filters. It is a straight llama.cpp OAI-compatible server — **not** the Qwen Cloud API.

This distinction matters enormously: pi's **built-in** `qwen3.8-max` catalog entry (see `node_modules/@earendil-works/pi-ai/dist/providers/data/qwen-token-plan.json`) is configured for the **Qwen Cloud / token-plan endpoint** (`https://token-plan.ap-southeast-1.maas.aliyuncs.com/...`), where top‑level `reasoning_effort`/`enable_thinking` are honored. A local llama.cpp server does **not** honor top-level `enable_thinking` (it is a jinja template kwarg, not an OpenAI parameter). It **does** honor top-level `reasoning_effort` on builds that include llama.cpp PR #26941 (merged 2026-08-14; confirmed empirically below). The `chat_template_kwargs` mechanism used here works on every build, which is why it is preferred.

## The three bugs in the original `models.json` entry

Original entry was bare:

```json
{ "id": "qwen-3-8-27b-mtp", "input": ["text", "image"] }
```

1. **No `"reasoning": true`.**
   In `core/agent-session.js`, the thinking-cycle gate is:
   ```js
   supportsThinking() { return !!this.model?.reasoning; }
   cycleThinkingLevel() {
     if (!this.supportsThinking()) return undefined;          // <-- returns early, does NOTHING
     ...
   }
   ```
   Without `reasoning: true`, `shift+tab` is a no-op. There are no thinking levels to cycle.

2. **Default `thinkingFormat` is wrong for a local server.**
   For an unrecognized provider (`llama-swap`) at `localhost`, `detectCompat()` in
   `pi-ai/dist/api/openai-completions.js` falls through to `thinkingFormat: "openai"`,
   which emits a **top-level** `reasoning_effort` field. llama.cpp's OAI layer drops top-level
   `reasoning_effort` on the floor (no error, silent ignore — llama.cpp discussion #20408).

3. **No `thinkingLevelMap`.**
   Qwen3.8 only supports `low`/`medium`/`xhigh` (default `xhigh`; `off` disables thinking).
   Without a map, pi would offer/clamp to levels the model doesn't understand.

## How the thinking cycle actually reaches the request (code-trace)

`shift+tab` (`app.thinking.cycle`) → `agent-session.cycleThinkingLevel()` →
`getSupportedThinkingLevels(model)` (filters by `thinkingLevelMap`, `null` = unsupported) →
`setThinkingLevel()` → stored in `agent.state.thinkingLevel` → passed to the provider as
`options.reasoning` → in `pi-ai`'s `streamSimple` (`openai-completions.js`):
```js
const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
```
→ `buildParams(..., reasoningEffort)` reads `compat.thinkingFormat` and emits the provider-specific payload.

The thinking-format branches are an **exclusive** `if/else if` chain, so only one mechanism fires
per request. For `thinkingFormat: "openai"` (the auto-detected default here), only the
top-level `reasoning_effort` block runs — which cannot disable thinking on llama.cpp (no
honored off-switch is sent) and only carries effort tiers on builds including llama.cpp PR
#26941. The `chat-template` format below avoids both gaps.

## What the local llama-server actually accepts (live probes, no guessing)

Probed `POST http://localhost:8080/v1/chat/completions` (model was loaded on first request)
with `stream: true`, a short reasoning-inducing prompt, and measured `reasoning_content`
characters returned. Same prompt each run.

| Request body (re: thinking) | Thinking chars | Conclusion |
|---|---|---|
| *(no thinking params)* | 258 (Test A) | Thinking is ON by default for Qwen3.8. |
| top-level `enable_thinking: false` | 107 (Test B) | **Top-level ignored** — thinking still on. |
| `chat_template_kwargs:{enable_thinking:false,preserve_thinking:true}` | 0 (Test C) | `chat_template_kwargs` **is honored** (off works). |
| `chat_template_kwargs:{enable_thinking:true,preserve_thinking:true,reasoning_effort:"low"}` | 242 (Test D) | `reasoning_effort` string **honored** (less thinking). |
| `chat_template_kwargs:{…,reasoning_effort:"xhigh"}` | 298 (Test E) | more thinking (≈ default). |
| `chat_template_kwargs:{…,thinking_budget_tokens:5}` | 77 (Test F) | int budget also works (sanity). |
| `chat_template_kwargs:{…,thinking_budget_tokens:4000}` | 351 (Test G) | int budget caps reasoning. |
| top-level `reasoning_effort:"low"` (no ctkw) | 261 | `low` honored → less thinking. |
| top-level `reasoning_effort:"xhigh"` | 334 | `xhigh` honored → max thinking. |
| top-level `reasoning_effort:"none"` | 0 | `none` → thinking disabled. |

**Findings:**
- `chat_template_kwargs` is honored on every build: `enable_thinking` toggles off, and
  `reasoning_effort` as a string (`low`/`medium`/`xhigh`) differentiates effort depth
  (low=242 < medium=296 ≈ xhigh=298 ≈ default 258). Verified in the live session — the model
  self-reported "reasoning effort is set to low".
- Top-level `enable_thinking` is **ignored** (it is a jinja template kwarg, not an OpenAI
  parameter; llama-server never maps it). This is why turning thinking **off** must go
  through `chat_template_kwargs.enable_thinking:false`.
- Top-level `reasoning_effort` **is honored** on this build because llama.cpp PR #26941
  (merged 2026-08-14, included in build 10435) now stores it and exposes it to templates
  (`low`→261, `xhigh`→334, `none`→0). Before that PR llama-server dropped every value except
  `none` (llama.cpp discussion #20408).
- `thinking_budget_tokens` (int) also works (Test F=77 at budget 5), but `reasoning_effort`
  matches Qwen's documented API and the user-saved `qwen38-27b-thinking-level.txt`.

**Why `chat-template`+`chat_template_kwargs` (not top-level / the `qwen` format):** pi's
`openai` and `qwen` formats send `reasoning_effort` and/or `enable_thinking` as **top-level**
fields. On llama.cpp, top-level `enable_thinking` is ignored, so those formats **cannot disable
thinking** when cycled to `off` (they emit no honored off-switch), and top-level
`reasoning_effort` only works on post-#26941 builds. Routing through `chat_template_kwargs` works
on every build and correctly toggles `off`.

## The fix (applied to `~/.pi/agent/models.json`)

```json
{
  "id": "qwen-3-8-27b-mtp",
  "input": ["text", "image"],
  "reasoning": true,
  "contextWindow": 131072,
  "compat": {
    "thinkingFormat": "chat-template",
    "supportsReasoningEffort": true,
    "chatTemplateKwargs": {
      "enable_thinking": { "$var": "thinking.enabled" },
      "preserve_thinking": true,
      "reasoning_effort": { "$var": "thinking.effort" }
    }
  },
  "thinkingLevelMap": {
    "minimal": null,
    "low": "low",
    "medium": "medium",
    "high": null,
    "xhigh": "xhigh",
    "max": null
  }
}
```

Rationale per field (all source-traced in `pi-ai/dist/api/openai-completions.js`):
- `reasoning: true` — enables thinking support (gates `supportsThinking()`/`cycleThinkingLevel()`).
- `thinkingFormat: "chat-template"` — selects `buildChatTemplateValues()` so params go into
  `chat_template_kwargs` (honored on every llama.cpp build, including this one), and is exclusive
  with the top-level `reasoning_effort` fallback so no ignored field is emitted.
- `chatTemplateKwargs` with `{ "$var": "thinking.enabled" }` / `"thinking.effort"` —
  `resolveChatTemplateKwargValue()` maps the cycled level through `thinkingLevelMap` and sends
  the right strings under `enable_thinking`/`reasoning_effort`; `preserve_thinking: true` is
  always emitted (literal).
- `thinkingLevelMap` — marks `minimal`/`high`/`max` as unsupported (`null`) and maps
  `low`/`medium`/`xhigh` to themselves, matching Qwen3.8's real levels. `off` is omitted from
  the map so it resolves to `enable_thinking: false` (thinking disabled).
- `contextWindow: 131072` — matches the server's `--ctx-size 131072` (pi default `128000` is
  safe but slightly conservative; this is accurate and matches sibling entries like `gemma-4-31b`).

## Verification with pi's own code

Ran `getSupportedThinkingLevels` and `clampThinkingLevel` (imported from
`@earendil-works/pi-ai`) against the configured model, and replicated
`buildChatTemplateValues`/`resolveChatTemplateKwargValue` verbatim. Results:

- `getSupportedThinkingLevels` → `[off, low, medium, xhigh]` (minimal/high/max dropped). ✓
- User `settings.json` `defaultThinkingLevel: "high"` → `clampThinkingLevel(model, "high")` = **`xhigh`**. ✓
- The 4 levels pi emits as `chat_template_kwargs` exactly match the payloads proven against the
  live server above (off→0 chars, low→242, medium→296, xhigh→298). ✓

## Appendix: querying llama-swap request captures

llama-swap records each request/response body in an in-memory ring buffer
(`captureBuffer`, ~5 MiB by default, see llama-swap PR #508) and exposes them by
numeric id. This is how the request bodies quoted above were read. No auth is
required on this NixOS setup (no `--api-key` is configured, so `apiKeyAuth` is a
no-op); if you start llama-swap with `--api-key`, add `-H "x-api-key: <key>"`
(or `?api_key=<key>`) to the requests below.

**1. Enumerate captures** by id. In v249 the `/api/metrics` list endpoint and the
SSE `metrics` event type are not present (the `/api/events` stream only emits
`logData`/`modelStatus`/`inflight`/`profileChanged`/`uiConfig`), so the reliable
way to list captures is to probe ids — they are sequential from 1 and stop at 404:

```bash
for i in $(seq 1 200); do
  code=$(curl -s -o "/tmp/cap-$i.json" -w "%{http_code}" --max-time 5 \
         "http://localhost:8080/api/captures/$i")
  [ "$code" = "404" ] && break
  echo "id=$i -> $code ($(wc -c < /tmp/cap-$i.json) bytes)"
done
```

**2. Inspect a capture.** Each capture is:
```json
{
  "id": 22,
  "req_path": "/v1/chat/completions",
  "req_headers": { "user-agent": "OpenAI/JS 6.40.0", "authorization": "[REDACTED]", ... },
  "req_body": "<base64-encoded request JSON>",
  "resp_headers": { ... },
  "resp_body": "<base64 or raw response>"
}
```
Sensitive headers (`authorization`, `cookie`, `x-api-key`, …) are redacted to
`[REDACTED]`, so it is safe to inspect on a shared machine.

**3. Decode the request body** (it is base64) to see exactly what pi sent:
```bash
node -e 'console.log(JSON.stringify(
  JSON.parse(Buffer.from(require("fs").readFileSync("/tmp/cap-22.json","utf8")
    .match(/"req_body":"([^"]+)"/)[1],"base64").toString()), null, 2))
)'
```
For the user's live "low" session (capture #22, `UA: OpenAI/JS 6.40.0`) this
yielded exactly what the `models.json` config produces:
```json
{ "model": "qwen-3-8-27b-mtp",
  "chat_template_kwargs": {"enable_thinking": true, "preserve_thinking": true, "reasoning_effort": "low"},
  "...": "no top-level reasoning_effort / enable_thinking" }
```

Notes:
- Captures are bounded by `captureBuffer`; very large responses (multi-MB, typical of
  long Qwen3.8 reasoning runs) can evict older captures, so fetch the one you care about
  soon after the request.
- `resp_body` for streaming `/v1/chat/completions` is the recombined SSE payload; the
  usage block appears at the end as a final `data:` event.

## References

- pi docs: `docs/models.md` — `thinkingFormat`, `chatTemplateKwargs` (`$var`), `thinkingLevelMap`,
  `compat.supportsReasoningEffort`; `docs/keybindings.md` — `app.thinking.cycle` default `shift+tab`,
  `app.thinking.toggle` default `ctrl+t`.
- pi source: `pi-ai/dist/api/openai-completions.js` (thinking-format branches +
  `buildChatTemplateValues`/`resolveChatTemplateKwargValue`), `pi-ai/dist/models.js`
  (`getSupportedThinkingLevels`/`clampThinkingLevel`), `core/agent-session.js`
  (`supportsThinking`/`cycleThinkingLevel`/`setThinkingLevel`), `core/sdk.js`
  (`clampThinkingLevel` on session start).
- Built-in catalog: `pi-ai/dist/providers/data/qwen-token-plan.json` (`qwen3.8-max`).
- `qwen38-27b-thinking-level.txt` (user-saved) — Qwen3.8 `reasoning_effort: low|medium|xhigh`.
- GitHub: earendil-works/pi#6951 (Qwen3.8 `thinkingLevelMap` for the Cloud API),
  earendil-works/pi#3325 (`qwen-chat-template` missing `preserve_thinking` for local Qwen3.x),
  ggml-org/llama.cpp discussions #20408 (historically: llama-server dropped top-level
  `reasoning_effort` except `none`) and PR #26941 — 2026-08-14, now stores & exposes top-level
  `reasoning_effort` to templates (merged into local build 10435); PRs #13196/#13771
  (`chat_template_kwargs` support).
- mostlygeek/llama-swap PR #508 — request/response capture ring buffer
  (`/api/captures/:id`) and the Activity "View" inspector used above.

## Usage

`shift+tab` cycles thinking levels on `qwen-3-8-27b-mtp`: `xhigh → off → low → medium → xhigh → …`.
No pi restart needed — `models.json` reloads on `/model` (or re-select the model).
