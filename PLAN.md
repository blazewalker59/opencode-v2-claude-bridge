# Implementation plan

This plan is the handoff document for evolving the initial read-only, text-streaming bridge into a complete OpenCode V2 Claude Agent SDK provider.

## Current baseline

The `feature/agent-sdk-alpha` branch provides:

- an OpenCode V2 plugin, implemented with `Plugin.define({ setup })`;
- a loopback-only, OpenAI Chat-compatible adapter started for each loaded workspace;
- streaming text from the public Claude Agent SDK into OpenCode;
- a small fixed catalog of Claude models;
- a read-only Agent SDK policy (`Read`, `Glob`, `Grep`) that does not bypass permissions;
- the Milestone 1 tool-call bridge for OpenCode's read-only tools (see Milestone 1 status); and
- offline protocol tests plus manually approved live smoke tests of text streaming and of a read-only tool call.

The bridge deliberately does **not** read or copy OAuth credentials, clone Claude Code headers, or expose a Claude.ai login flow. It relies on the local user’s existing `claude login` state through the public Agent SDK.

## Product goal

Allow a user who has authenticated Claude Code locally to select a `claude-agent-sdk/*` model in OpenCode and work normally:

1. OpenCode owns the UI, transcript, tool rendering, and permission decisions.
2. The Agent SDK owns Claude model execution, Claude Code session behavior, and authentication.
3. Tool calls travel from the Agent SDK to OpenCode, and OpenCode tool results return to the waiting Agent SDK call.
4. No bridge component silently grants filesystem, shell, network, or credential access.

## Non-goals and constraints

- Do not implement a Claude.ai login screen, credential collection, token copying, or request-header/billing-metadata emulation.
- Do not use private Claude Code session-file formats as an integration protocol.
- Do not bind the bridge to a non-loopback address.
- Do not enable shell or write tools by default just to make tests pass.
- Each user uses their own `claude login`; credentials and plan usage are never shared.
- Agent SDK usage can consume the signed-in user’s subscription quota. Ask before live tests.

## Architecture target

```text
OpenCode V2 session
  │  OpenAI Chat-compatible request + tool results
  ▼
OpenCode V2 plugin
  │  workspace-scoped provider registration
  ▼
Loopback bridge server
  │  public Claude Agent SDK query() / streaming input
  ▼
Claude Code subprocess using the local user's authenticated account
```

For tool execution, add an in-process Agent SDK MCP server to the bridge:

```text
Claude Agent SDK tool_use
  → bridge emits an OpenAI tool call to OpenCode
  → OpenCode executes under its existing permission rules
  → subsequent OpenCode request carries tool result
  → bridge resolves the matching pending MCP call
  → Agent SDK continues the same turn
```

The [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) implementation is a useful MIT-licensed behavioral reference for this pattern. Reimplement against the public Agent SDK and OpenCode V2 APIs; do not transplant its host-specific code or credential handling.

## Milestone 1 — OpenCode tool-call bridge

### Objective

Turn OpenCode tool definitions into Agent SDK MCP tools and return Agent SDK tool calls as OpenAI-compatible `tool_calls` that OpenCode can execute.

### Work items

- Define a bridge-owned tool/session state model:
  - OpenCode session ID;
  - Agent SDK query/session ID;
  - pending tool calls keyed by a stable tool-call ID;
  - buffered result received before its handler begins waiting;
  - cancellation and terminal-state flags.
- Convert OpenCode `tools` from incoming chat-completion requests into MCP `tools/list` results without lossy JSON-schema conversion.
- Use an in-process MCP server (`createSdkMcpServer()` or the MCP SDK directly) whose handler waits for the corresponding OpenCode tool result.
- Stream Agent SDK `tool_use` blocks into OpenAI chat-completion chunks.
- End the OpenAI response with `finish_reason: "tool_calls"` only after every emitted tool-call input is complete.
- Accept `role: "tool"` results on the next request, pair them by call ID, and resolve the pending MCP handlers.
- Preserve text-before-tool output and resumed text-after-tool output in order.
- Reject malformed, unknown, duplicate, or stale tool-result IDs with actionable errors; never leave an MCP promise waiting indefinitely.

### Acceptance criteria

- A Claude response can invoke OpenCode `read`, receive its result, and then provide a final answer.
- A Claude response can invoke two independent tools without cross-pairing results.
- An OpenCode permission denial becomes an error result visible to Claude, which can adapt or ask the user for another path.
- Interrupting an OpenCode session releases all pending MCP handlers and terminates the Agent SDK query cleanly.
- No tool executes unless OpenCode authorizes it.

### Tests

- Unit-test OpenAI tool-call chunk generation and result pairing.
- Unit-test out-of-order results, duplicate results, malformed JSON, cancellation, and a tool result delivered before handler registration.
- Add a mocked Agent SDK multi-turn integration test.
- Add one manually approved live test using a read-only tool.

### Status: complete (offline suite + one live read-only smoke test)

Code: `src/tool-bridge.ts` (tool conversion, MCP server, pending-call pairing), `src/turn.ts` (one Agent SDK query across several OpenCode requests), `src/bridge-server.ts` (request validation and routing). Tests: `tests/tool-bridge.test.ts` (unit) and `tests/tool-flow.test.ts` (HTTP end-to-end against a fake Agent SDK that calls the real MCP server over an in-memory transport).

| Acceptance criterion | Status |
| --- | --- |
| Claude invokes OpenCode `read`, receives the result, and answers | Offline ✔ (`a tool call streams to OpenCode…`). Live ✔ on OpenCode 2.0.21 with `claude-sonnet-4-6`: one Agent SDK query spanned both OpenCode requests. |
| Two independent tools without cross-pairing | Offline ✔ (parallel, sequential, and out-of-order result tests). |
| OpenCode permission denial is visible to Claude, which can adapt | Offline ✔. Since Milestone 2, OpenCode's error envelope becomes an MCP `isError` result. |
| Interrupting releases all pending MCP handlers and terminates the query | Offline ✔ for a mid-stream disconnect, a timeout while awaiting results, a new message superseding the turn, bridge shutdown, and MCP request cancellation. |
| No tool executes unless OpenCode authorizes it | By construction: OpenCode executes every bridged call. Claude has no built-in tools in this mode, and `dontAsk` denies anything not allowlisted. Live: OpenCode executed the `read` call and recorded it in its own transcript. |

### Design decisions

- **JSON Schema fidelity.** The MCP server uses the MCP SDK's low-level `tools/list` and `tools/call` handlers, not the Agent SDK's `tool()` helper. `tool()` requires Zod shapes, and converting from JSON Schema would be lossy. Schemas are deep-copied verbatim; `type: "object"` is added only when absent.
- **Turn routing.** A turn stays alive across OpenCode requests and is keyed by Claude's `tool_use` IDs, which OpenCode echoes back as `tool_call_id`. `role: "tool"` messages after the last assistant message resume the matching turn. A request without them starts a new turn from the transcript.
- **Messages after tool results.** The live test showed OpenCode V2 inserting a system notice ("The Code Mode tool catalog has changed…") after a tool result. It is sent as a `user` message once the user's MCP servers finish connecting. Messages that follow the results are appended, labelled, to the last result of the batch. This keeps the turn alive and lets Claude see them. Feeding them through Agent SDK streaming input was rejected: how Claude Code folds a queued message into a turn that is waiting on a tool is undocumented.
- **Handler pairing.** The `tools/call` request has no public field carrying the `tool_use` ID. A handler claims the oldest unclaimed streamed call with the same tool name and canonical arguments, falling back to the same tool name. Results may arrive before or after the handler starts waiting.
- **Tool calls come from the stream.** Each call is emitted when its `tool_use` block completes, with fully buffered arguments. `finish_reason: "tool_calls"` is sent at `message_stop`. Blocks with malformed JSON, or for tools the bridge did not expose, are never sent to OpenCode.
- **Errors.** A malformed request, duplicate IDs within one request, or a mix of known and unknown IDs returns `400`; nothing is applied. Results re-delivered to a live turn return `409`. Results for no live turn (stale, after a restart, or after the user declined a prompt and OpenCode stopped its loop) start a new turn from the transcript, which already contains them. An earlier version returned `409` here, which left such a session permanently stuck. An unknown ID while the history's turn is still live is a `400`. Expected results that are missing are answered with an `isError` result so Claude never waits forever.
- **Read-only policy.** Milestone 1 bridged only `read`, `glob`, and `grep`. OpenCode 2.0.21 offers `edit`, `glob`, `grep`, `question`, `read`, `shell`, `skill`, `subagent`, `webfetch`, `websearch`, `write`, and `execute` (Code Mode, which reaches MCP tools). Milestone 2 replaced the fixed list with `toolPolicy`.
- **Lifetime.** A turn waiting for results is cancelled after 30 minutes (`toolResultTimeoutMs`). It is cancelled immediately when the client disconnects mid-stream, or when a new OpenCode message's history references its tool calls.

### Live verification notes

- Verified: OpenCode's tool names, Claude Code invoking the in-process MCP handler for a streamed `mcp__opencode__read` call, OpenCode accepting the single-chunk tool-call format, and the result resuming the same query.
- Not yet exercised live: parallel calls, a permission denial, and an interrupted tool. These are covered offline only.
- Diagnostics: set `OPENCODE_CLAUDE_BRIDGE_DEBUG_LOG` to a file path to record request and turn metadata (no message content).

## Milestone 2 — Permission and user-input handoff

### Objective

Make write/shell actions use OpenCode’s existing permission experience instead of Agent SDK auto-approval.

### Work items

- Keep Agent SDK built-in file and shell tools disabled whenever their OpenCode equivalents are available.
- Bridge the OpenCode `question`/user-input tool into an Agent SDK custom MCP tool or use the SDK’s public user-input/elicitation facilities after confirming the supported contract.
- Map OpenCode permission errors and user cancellations to MCP error results.
- Add explicit, documented bridge options for tool capability policy; default to OpenCode-controlled tools only.
- Confirm no setting uses `allowDangerouslySkipPermissions` or automatic unrestricted Bash approval.

### Acceptance criteria

- A write or shell request is rendered and approved/denied by OpenCode—not silently by the bridge.
- A model can ask a user a question and receive the chosen response.
- A denial does not wedge the Agent SDK turn or break the OpenCode session.

### Status: complete (offline suite, scripted-agent checks against real OpenCode, and one interactive live-Claude test)

Interactive live test (OpenCode 2.0.21 TUI, `claude-sonnet-4-6`, `toolPolicy: "opencode"`, `ask` rules for `edit` and `shell`): Claude asked a `question` and the user's answer ("howdy") returned to the same turn. Claude called `write`; the user approved and the file was created. Claude called `shell`; the user declined and the command never ran. Declining stops OpenCode's loop without returning the denial to the model, so the turn waits for the user's next message. That finding drove the stale-result recovery change described under Milestone 1's error handling.

Real-OpenCode checks ran `opencode run --standalone` against a temporary workspace, with a scripted agent standing in for the Agent SDK. They exercised the real MCP server and OpenCode's real tools and permission engine, and made no Claude requests.

| Work item / criterion | Status |
| --- | --- |
| Built-in Claude Code tools disabled when OpenCode tools are present | ✔ `tools: []`, `dontAsk`, `strictMcpConfig`, `settingSources: []`; pinned by `tests/agent-options.test.ts`. |
| `question` bridged | ✔ Bridged as an ordinary OpenCode tool under the default policy, so OpenCode renders it in its own UI. A non-interactive run cancels it with a `tool.execution` error, which Claude receives as `isError`. Live ✔: an interactive answer reached Claude in the same turn. |
| Permission errors and cancellations become MCP error results | ✔ OpenCode 2.x's error envelope `{"error":{"type","message"},"content":[]}` maps to `isError` (exact match only). Verified with real `permission.rejected` output. |
| Explicit tool policy, default OpenCode-controlled | ✔ `toolPolicy: "read-only"` (default) or `"opencode"`, validated. An invalid value fails plugin load and never widens access. Verified that object-form plugin options reach the plugin. |
| No `allowDangerouslySkipPermissions` or automatic Bash approval | ✔ Pinned by tests. No `canUseTool`, and no bypass/acceptEdits/auto modes. |
| Write/shell approved or denied by OpenCode, not the bridge | ✔ Real OpenCode: a `deny` rule rejected `shell rm` (the file survived), and an `ask` rule rejected `write` in a non-interactive run (no file created). Live ✔: an interactive approval ran `write`, and an interactive decline blocked `shell`. |
| A denial does not wedge the turn | ✔ Non-interactive denials end the turn cleanly. After an interactive decline, the user's next message resumes the same turn, or replays the transcript if the turn has ended (offline-tested with the captured `aborted` envelope). |

### Design decisions

- **`question` is an ordinary bridged tool.** The Agent SDK's own user-input path (`canUseTool`/`AskUserQuestion`) would ask outside OpenCode. Bridging OpenCode's `question` tool keeps OpenCode in charge of the UI and the answer.
- **Default stays read-only.** OpenCode V2's base policy allows `edit` and `shell` without asking. Exposing them by default would hand Claude unattended write/shell access, so `"opencode"` is opt-in and documented alongside recommended `ask` rules.
- **Denied tools are invisible.** A `deny` rule for a whole action removes the tool from OpenCode's request, so Claude never sees it. Resource-scoped denials such as `shell` + `rm *` surface as `permission.rejected` results.

## Milestone 3 — Persistent session mapping

### Objective

Resume an Agent SDK session per OpenCode session rather than rebuilding the full OpenCode transcript into every request.

### Work items

- Store an OpenCode-session-ID → Agent-SDK-session-ID mapping in plugin-scoped storage.
- Start the first Agent SDK query with an explicit UUID/session ID where supported.
- Resume that session on subsequent OpenCode turns using the public Agent SDK `resume` option.
- Define reset behavior for OpenCode compaction, session fork, revert, model change, and manually deleted SDK sessions.
- Retain the existing transcript-to-prompt conversion only as a recovery path when a session cannot resume.
- Add cleanup for removed OpenCode sessions and stale mappings.

### Acceptance criteria

- Two ordinary OpenCode turns share an Agent SDK session.
- Resuming avoids re-sending the complete prior transcript.
- After an interrupted turn or missing SDK session, the bridge recovers predictably and reports the fallback in debug logs.
- Forked OpenCode sessions never share mutable pending-tool state.

### Status: complete (offline suite, scripted-agent checks against real OpenCode, and a live two-turn resume)

Code: `src/sessions.ts` (fingerprints, turn planning, store), `src/turn.ts` (ordered run plans with fallback), `src/bridge-server.ts` (headers, state recording), `src/index.ts` (`model.request` hook, plugin-storage store). Tests: `tests/sessions.test.ts`, `tests/session-flow.test.ts`, `tests/agent-options.test.ts`.

| Acceptance criterion | Status |
| --- | --- |
| Two ordinary turns share an Agent SDK session | ✔ Offline. ✔ Real OpenCode (scripted agent): two separate `opencode run` processes on one session; the second request resumed the first's Agent SDK session, with state read back from plugin storage. ✔ Live (OpenCode 2.0.21, `claude-sonnet-4-6`): turn 1 "Remember the codeword HERON"; turn 2 was a separate `opencode run --session` process that resumed with only "What was the codeword?" and Claude answered HERON. No fallback. |
| Resuming avoids re-sending the transcript | ✔ The resumed prompt is only the new message, verified offline and in real OpenCode. |
| Predictable recovery after an interrupted turn or missing SDK session | ✔ Offline: a cancelled turn's mapping is removed (next message replays). A resume that fails before output falls back to a replay within the same response, logged as `session.fallback`. A failure after output is reported, not retried. |
| Forked sessions never share mutable pending-tool state | ✔ Pending tool state is per turn; session state is keyed by OpenCode session ID, so a fork has no state and replays. |

### Design decisions

- **Session identity from a public hook.** The plugin's `model.request` hook (scoped to this provider) adds `x-opencode-session-id` and `x-opencode-request-kind`. Requests without them (other clients, tests) are stateless replays, as before.
- **Resume only on an exact match.** The bridge records fingerprints of every non-system OpenCode message the Agent SDK session already contains, plus its ID, but only after a turn completes cleanly. A next request resumes when its history equals that record, followed by Claude's final (tool-free) reply and then only new user or system messages. Fingerprints compare meaning (role, text, tool calls), not encoding. Any other shape replays into a fresh session with a new explicit `sessionId`. This makes revert, compaction, edit, fork and provider switches safe without special cases.
- **Fallback inside the response.** A turn carries ordered run plans (resume, then replay). A plan that fails before any text or tool call is emitted is replaced by the next one, transparently to OpenCode. Each attempt gets its own MCP server instance, because an instance connects only once.
- **System prompt.** OpenCode's leading system messages become `systemPrompt: { type: "custom", prompt, snapshot: false }`. They are no longer embedded in the user prompt, and are re-rendered on every request, so resumed sessions do not keep a stale recorded prompt.
- **Throwaway requests.** Title and compaction requests use `persistSession: false`, so they no longer leave session files behind. They also never record or clear session state: the first live run showed `opencode run` abandoning the title request after the answer, and an early version let that erase the primary turn's mapping.

### Remaining work

- ✔ Session cleanup: a `session.deleted` subscription drops the mapping immediately. A startup sweep removes mappings whose OpenCode session no longer exists, which covers deletions made while no OpenCode server ran the plugin (verified: a one-shot `opencode session delete --standalone` left the mapping, and the sweep removed it). It deletes only on an explicit not-found error; the in-process API reports `Session.NotFoundError` and HTTP reports `SessionNotFoundError`. Agent SDK transcripts are left to Claude Code's retention.

## Milestone 4 — Model inventory and configuration

### Objective

Replace the fixed model list with a safe, supported inventory and user-visible configuration.

### Work items

- Use the public Agent SDK model-list/control API to discover models after the local Claude session is initialized, if it is available and stable for the selected SDK version.
- Keep a documented fallback catalog when discovery is unavailable.
- Add plugin options for:
  - default model;
  - explicit model allowlist;
  - workspace path override only when necessary;
  - SDK executable path for unusual environments;
  - debug logging path and level.
- Surface clear diagnostics for missing Claude Code, unauthenticated Claude Code, unsupported model, quota/rate-limit, and gateway configuration errors.
- Avoid representing subscription limits or making plan eligibility claims in code; let the Agent SDK report availability.

### Acceptance criteria

- The model picker shows only bridge-supported models.
- A missing/expired Claude login gives a helpful repair command without exposing credentials.
- Settings changes take effect after OpenCode reload/restart and remain scoped to the intended workspace or user.

### Status: implemented; discovery and options verified against real OpenCode (quota-free)

Code: `src/models.ts` (discovery, catalog, allowlist), `src/options.ts` (validated plugin options), `src/diagnostics.ts` (repair hints), `src/index.ts` (discovery then `provider.reload()`), `src/bridge-server.ts` (title model, executable). Tests: `tests/models.test.ts`, `tests/options.test.ts`, `tests/diagnostics.test.ts`, plus additions to the session, agent-option and tool-flow tests.

| Acceptance criterion | Status |
| --- | --- |
| The model picker shows only bridge-supported models | ✔ The list comes from Claude Code's `supportedModels()`, with the duplicate `default` row dropped and an optional `models` allowlist applied. Verified with `opencode serve`: the provider reloaded from the fallback aliases to the discovered list, narrowed by the allowlist. |
| A missing or expired login gives a repair command without exposing credentials | ✔ Offline: auth-shaped Agent SDK errors gain a `claude login` hint, or name the gateway variables (never their values) that override the login. Not yet seen live with a real expired login. |
| Settings take effect after reload/restart, scoped as intended | ✔ Options come from the plugin entry's object form, so they follow OpenCode's config scoping (project or global). Verified that object-form options reach the plugin. |

### Design decisions

- **Quota-free discovery.** Discovery starts a query whose input never yields a message and reads `supportedModels()` from Claude Code's startup handshake, with `persistSession: false`, no settings and no tools. A probe on a real account answered in about 0.6 s. A 20 s timeout keeps the fallback list.
- **Aliases over pinned IDs.** The fallback catalog is `opus`, `sonnet`, `haiku`, and discovered entries keep Claude Code's own values, so the picker does not go stale when new models ship. Display names show what each alias currently resolves to. Removing the old pinned IDs is a documented breaking change.
- **Context limits.** `ModelInfo` reports no limits. Entries get 200k context, or 1M when the ID carries Claude Code's `[1m]` marker, and 64k output. The Agent SDK, not these numbers, governs real behavior.
- **Title model.** `title` requests run on `titleModel` (default `haiku`) instead of the session's model.
- **Diagnostics stay factual.** Hints are appended after the SDK's own text and only say what to check (login, gateway variables, executable, model choice). Rate-limit and usage-limit messages pass through unchanged; the bridge makes no plan or quota claims.
- **Options fail closed.** Unknown keys and malformed values stop the plugin with the option's name, like `toolPolicy`.

### Remaining work

- ✔ Working-directory override: `workingDirectory`, absolute or relative to each OpenCode project (so one global setting works across projects), checked to exist at plugin load. Verified in OpenCode 2.0.21: `"packages/api"` resolved per project and every turn ran there; a typo stopped the plugin from loading with the resolved path in OpenCode's "failed to load plugin" log. It moves where Claude Code runs and keeps its transcripts, never what OpenCode's tools can reach.
- ✔ Title requests ran on `haiku` live (Milestone 5 checks).
- ✔ Auth hint against a genuinely logged-out Claude Code: during the Milestone 6 smoke-test work, a run with a throwaway home reached the installed Claude Code, which reported "Not logged in"; OpenCode showed the message with the `claude login` hint and classified it `provider.auth`, without retrying.

## Milestone 5 — Attachments, rich output, and compaction

### Objective

Handle OpenCode content beyond plain text without silently dropping context.

### Work items

- Decide which OpenCode media input types map to supported Agent SDK input and explicitly reject unsupported assets with a user-visible explanation.
- Map Agent SDK reasoning/text events to the OpenCode/OpenAI-compatible stream where supported.
- Implement an OpenCode compaction policy:
  - keep OpenCode compaction independent if it does not disturb the resumed Agent SDK state; or
  - intentionally rebuild/fork the Agent SDK session after a compact boundary.
- Document cache and context-window behavior, especially when recovery rebuilds a session.

### Acceptance criteria

- Unsupported attachments fail explicitly rather than disappearing.
- Long sessions either maintain a stable mapping or use a documented, tested recovery strategy.
- Context compaction does not mispair tools or silently lose the newest user turn.

### Status: complete (offline suite, scripted-agent checks against real OpenCode, and live vision checks)

Code: `src/content.ts` (attachment conversion, MCP blocks, content keys), `src/openai.ts` (attachment-aware transcript, `reasoning_content`), `src/sessions.ts` (attachment-aware new-message prompts and fingerprints), `src/tool-bridge.ts` (image-aware tool results and follow-ups), `src/turn.ts` (thinking events). Tests: `tests/content.test.ts`, plus additions to the tool-bridge and server tests.

| Acceptance criterion | Status |
| --- | --- |
| Unsupported attachments fail explicitly rather than disappearing | ✔ Images and PDFs pass through; everything else becomes a visible `[… omitted: …]` note. Before this milestone, the text-only declaration made OpenCode itself refuse attachments with an explicit `ERROR: Cannot read …` (captured). |
| Long sessions keep a stable mapping or a documented, tested recovery | ✔ Milestone 3's resume and replay rules; fingerprints now include attachments. |
| Compaction does not mispair tools or lose the newest user turn | ✔ Compaction requests are throwaway; the post-compaction history diverges and replays in full, newest message included (tests: "compacted into a summary", throwaway compaction requests). Tool pairing is per live turn and unaffected. |

Real-OpenCode findings (scripted agent, no Claude requests):

- With `input: ["text"]`, OpenCode refuses a PDF with `ERROR: Cannot read "tiny.pdf" (this model does not support pdf input).`
- With `image` and `pdf` declared, OpenCode sends `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}` and `{type:"file", file:{filename, file_data:"data:application/pdf;base64,…"}}`. The bridge turned these into a Claude image block and a document block (titled `tiny.pdf`).
- OpenCode's `read` of an image returns `"Image read successfully"` as the tool result and the image in a following user message. The earlier text-only follow-up note would have dropped it silently; Claude now receives it as an MCP image block on the tool result.
- `reasoning_content` deltas become OpenCode `reasoning` parts.

### Design decisions

- **Markers plus blocks.** Prompts stay a single user message: the transcript text with numbered markers, followed by labelled image or document blocks. Text-only prompts stay plain strings.
- **Replay carries every attachment in history.** This is correct but can be large; resumed turns send only the new message's attachments.
- **Tool results carry images only.** MCP tool results support text and images; a PDF there becomes a note rather than an unverified embedded resource.
- **Thinking counts as output.** Once reasoning has streamed, a failure is reported rather than silently retried, so OpenCode never shows thinking that a replay then repeats.

### Remaining work

- ✔ Live (OpenCode 2.0.21, `sonnet`): with an attached 64×32 PNG (left red, right blue), Claude answered "The left side of the image is red and the right side is blue." When Claude opened the same file with OpenCode's `read` tool, the image arrived as a follow-up in the same turn, and Claude answered that mixing the two "would give you purple". Title requests ran on `haiku` (Milestone 4).
- ✔ Thinking (live, direct `claude login`, no gateway): the bridge asks for `thinking: { type: "adaptive", display: "summarized" }` for models that discovery reports support adaptive thinking, and the first request waits up to 2 s for discovery (a live run showed the first turn starting about 330 ms before discovery answered). Three harder prompts each produced a stored OpenCode reasoning part and a correct answer: a remainder puzzle on `sonnet` (answer 423), a task-balancing problem on `sonnet` after `glob` and `read` tool calls (best possible maximum of 103), and counting domino tilings of a 3×8 rectangle on `opus` (153). Simple prompts and title requests produced no thinking blocks (stream counts in `turn.end`), which is adaptive thinking's choice. `opencode run --format json` prints reasoning parts only with `--thinking`, which had hidden them in an earlier check. Earlier Milestone 1–5 live checks inherited `ANTHROPIC_BASE_URL` from the Claude Code shell they were launched from; live checks now unset it.

### Error reporting and OpenCode retries (follow-up)

Found live: a Claude API error ("You're out of extra usage") reached OpenCode as an error chunk with no `code`, which OpenCode 2.0.21 classifies as an unknown provider error and retries. It retried 11 times over about 97 s. The message also carried a misleading "Claude Agent SDK error (success)" label.

- `src/errors.ts` classifies a failed turn from the message text, the SDK's error category (the `error` field of its synthetic assistant message) and `api_error_status`, and the error chunk now carries `code` (HTTP-style status) and `type`. OpenCode never retries 4xx (402 quota, 401/403 auth and account, 400/404 invalid), and retries 429 and 5xx. Quota wording wins over the status, because the API reports some exhaustion as 400 or 429.
- Failures with no API status (Claude Code crashed, bridge errors) are `400 bridge_error`: shown once, not retried.
- On account errors (401, 402, 403, 429, 529) the bridge skips its resume-to-replay fallback, which would fail the same way.
- API errors show the API's own message.
- Tests: `tests/errors.test.ts` and flow tests in `tests/tool-flow.test.ts` and `tests/session-flow.test.ts`. Verified against real OpenCode with a scripted agent returning the live error: one attempt, classified `provider.quota`, run ended in 4 s.
- The mapping follows OpenCode 2.0.21's classifier, read from its build; a later OpenCode may classify differently.

## Milestone 6 — Packaging and release

### Objective

Make installation repeatable for any user without asking them to edit source files.

### Work items

- Add a versioned release process and changelog.
- Decide on distribution:
  - GitHub clone + build (current approach); or
  - publish a package to npm.
- If publishing to npm/GitHub Packages, ensure package exports resolve the V2 plugin entry correctly and test the installed package—not just a source checkout.
- Add an install/update script only if it can preserve unrelated OpenCode configuration, avoids secret handling, and clearly reports every change before making it.
- Add CI for typecheck, tests, build, and a plugin-load test.
- Create a compatibility matrix for OpenCode, Node, Claude Agent SDK, and Claude Code versions.

### Acceptance criteria

- A user can follow the README—or give the supplied installation prompt to an agent—and install the bridge without credential sharing.
- The release artifact passes the same plugin-load test that a local checkout passes.
- Upgrade and uninstall instructions cleanly remove only this bridge’s configuration and files.

### Status: implemented; first CI and release runs pending a push

Distribution (decided): a release tarball attached to each GitHub release is the default install; source installs remain for contributors. The package name is unscoped (`opencode-v2-claude-bridge`).

Code: `scripts/opencode-smoke.mjs`, `scripts/package-smoke.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `CHANGELOG.md`, `tsconfig.test.json`; `package.json` gains `files`, `engines`, `prepack` and the smoke scripts.

| Acceptance criterion | Status |
| --- | --- |
| A user can install from the README, or an agent prompt, without credential sharing | ✔ Clone-and-build and tarball installs documented; both verified against OpenCode 2.0.21. No step handles credentials. |
| The release artifact passes the same plugin-load test as a checkout | ✔ `npm run smoke:package` packs the tarball, checks its file list, and has OpenCode install and load it; `npm run smoke:opencode` runs the same checks on `dist/`. Both pass locally; CI runs them once the branch is pushed. |
| Upgrade and uninstall touch only the bridge's configuration and files | Documented (README **Upgrade**, **Uninstall**), not exercised end to end. The bridge cannot remove its OpenCode plugin storage after it is unloaded; that storage holds session IDs only. |

The smoke test runs real OpenCode in a throwaway home with `claudeExecutable` pointing at a missing file: the plugin loads, discovery falls back to the built-in aliases, a turn routes through the bridge with `read` bridged, and OpenCode shows the missing-executable error once, classified `provider.invalid-request`. No Claude request is possible.

Findings (OpenCode 2.0.21):

- **Local directories:** OpenCode resolves `server` or `index` inside a local plugin directory and never reads `package.json` there, so a package root silently fails to load ("Model unavailable"). Point at `dist/`.
- **Git installs fail:** npm's Git fetcher prepares any package with a `build`, `prepare`, `prepack` or install script by running `npm install` through the current executable; inside OpenCode that is `opencode`, which rejects npm's arguments ("Help requested"), so the install fails with "git dep preparation failed". Workaround if Git installs are wanted: a release ref with `dist` committed and no such scripts.
- **Tarball installs work:** `"package": "file:/abs/path.tgz"` makes OpenCode install the tarball and its dependencies with its bundled npm (about 20 s with a cold cache). An `https://` tarball URL does not: OpenCode treats it as a local path and never requests it.
- **`$PWD`:** OpenCode takes its project directory from `$PWD`, not the process working directory. A Node-spawned OpenCode inherited the parent's `$PWD`, loaded the repository's own `opencode.json`, and silently ignored the test configuration.
- `opencode models` and `opencode api GET /api/provider` return nothing until a session starts, so they cannot serve as a plugin-load check.

### Remaining work

- First CI run after the branch is pushed, and the first tagged release (both need approval).
- Exercise upgrade and uninstall end to end once a second version exists.

## Pre-release code review (follow-up)

A local review before the first push found three blocking issues and a set of smaller ones; all are fixed, with tests.

- **Adapter access:** any local process (or a web page, through a CORS-free POST or DNS rebinding) could start Claude turns. Completion requests now need a per-launch secret that only OpenCode receives (the provider-scoped `model.request` hook adds it); `Host` must be `127.0.0.1:<port>`, an `Origin` is refused, the content type must be JSON, and bodies are capped at 50 MB. Real OpenCode's title and primary requests authenticate (smoke-tested).
- **No-tools fallback:** without bridged tools the bridge used to give Claude Code's built-in `Read`, `Glob` and `Grep`, outside OpenCode's permissions (also when OpenCode had denied its own tools). It is now text-only: no built-ins, no MCP servers, `strictMcpConfig`.
- **Debug log:** an unwritable log broke every request and could crash OpenCode. It is now checked at load (an unwritable path stops the plugin), switches itself off on a later failure, and is created `0600`.
- Also: a turn cut short ends with an error chunk, not `stop`; an abandoned request never starts a query; malformed requests are 400s naming the field; tool batches are snapshotted per response; a fallback that cannot start is reported; session-store read and remove errors are contained; setup failures and unload clean up (discovery is cancelled); the allowlist can no longer empty the picker; `image/jpg`, data-URL parameters and base64 validation; error status beats wording; fingerprints use known fields only (existing mappings replay once); shutdown no longer waits for keep-alive timeouts; the release job is split into a read-only build and a write-only publish, actions are SHA-pinned, the released tarball's file list is checked, and the smoke test kills OpenCode's whole process group.
- Decided: switching models resumes the same Agent SDK session (the planner's comment had claimed it replayed).

A second review pass found two more blocking issues, both in shutdown, and finished the partial fixes; all fixed, with tests (139 total).

- **Shutdown:** a request still preparing its turn when `close()` ran started a Claude query afterwards and kept `close()` from finishing; a request arriving during shutdown threw an unhandled rejection (`server.address()` is null once closing). Now a shutting-down flag answers such requests with 503, the expected `Host` is computed once, and nothing can escape the request handler.
- **Setup:** moved to `src/plugin-setup.ts` (with injectable Agent SDK, environment and console) and tested through a fake OpenCode context: the token reaches requests through the hook, a failed setup step shuts everything down, teardown always closes the adapter and is idempotent, unloading during discovery never reloads the provider.
- **Also:** tool messages anywhere in the history are validated; results on an already-closed request stay undelivered so a retry can continue the turn; refused requests close their connection; the debug log tightens existing files to `0600`, refuses symlinks, truncates strings, and an inherited environment-variable path only warns; discovery uses strict MCP; `models.unlisted` names allowlisted IDs Claude Code does not list; repeated IDs are dropped; unpadded and URL-safe base64 is normalized; the smoke test drops npm's settings and cleans up on Ctrl-C.
- **Release:** build provenance via `actions/attest-build-provenance`; tags must be on `main`; no npm cache in the release job; the exact tarball is passed between jobs; direct dependencies are pinned exactly; `npm run build` cleans `dist/` first.

A third review pass (after `ecf7809`) found two more blocking issues; both fixed, with tests.

- **Transcript forgery:** replayed transcripts wrapped messages in plain `<user>`/`<tool-result>` tags, so a fetched page or file could close its tag and pose as a user turn. Tags now carry a random per-prompt suffix (explained to Claude in one line), attribute values are escaped, and message bodies stay byte-for-byte. Escaping bodies was rejected because it would mangle code in replayed history.
- **Stale mapping:** a resumed session's mapping stayed valid while the turn changed the Agent SDK session, and `close()` did not wait for the removal. The mapping is now dropped when a resume starts and recorded again on completion, writes per session are chained, and `close()` waits for them.
- **Also:**
  - an MCP call that arrives before its streamed tool_use is held up to 5 s to be paired, rather than refused while OpenCode still runs the tool;
  - a stream with no result is an error;
  - `close()` force-drops connections after a 5 s grace period;
  - hints follow the error classification;
  - the debug log refuses FIFOs, devices, hard links and other users' files, and caps arrays;
  - model IDs are trimmed;
  - the smoke test passes only an allowlisted environment;
  - the release workflow packs in a script-free job, tests in another, checks the digest before publishing, and requires a dated changelog section with nothing left under Unreleased;
  - the version is 0.2.0;
  - docs, verify command and metadata are updated.
- **Tested by behaviour, not by its branch:** the closed-before-results check in `handleCompletion` cannot be reached in practice (a request that drops fails reading its body first), so the test covers the behaviour it protects instead: a results request that drops leaves the turn waiting, and the retry continues it.
- **Needs the owner:** a GitHub tag ruleset for `v*`, since the workflow's own checks run from the tagged commit. Tried and dropped: shipping `npm-shrinkwrap.json`. OpenCode 2.0.21's installer pinned the direct dependencies but resolved transitive ones fresh (`@anthropic-ai/sdk` 0.134.0 against a locked 0.133.0). Bundling `node_modules` would break the Agent SDK's platform-specific Claude Code packages, so transitive versions float within their ranges.

## Recommended execution order

1. Complete Milestone 1, including its live read-only tool test, before enabling any write or shell capability.
2. Complete Milestone 2 before claiming the bridge supports editing in OpenCode.
3. Complete Milestone 3 before optimizing context or cache behavior.
4. Add model discovery and attachments only after the tool/session path is reliable.
5. Publish a broader release only after the CI and installation path test a packaged artifact.

## Suggested next-session checklist

1. Read `README.md`, this plan, `src/bridge-server.ts`, and `src/openai.ts`.
2. Confirm the installed OpenCode V2 plugin and Agent SDK type versions before changing interfaces.
3. Read the current public Agent SDK docs for streaming input, MCP, sessions, and permissions; do not rely on private Claude Code protocol details.
4. Implement the tool bridge behind focused unit tests before trying a live request.
5. Ask the account holder before every live request that consumes plan usage.
6. Update `README.md` and this plan as milestones land.
