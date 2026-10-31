# dsh-memory-chain

Five-layer memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): **opening a new conversation shouldn't feel like meeting a stranger.**

Zero dependencies, no patches to the DSH install, everything on local files. It exists to answer one question — context windows are expensive, so why store "remembering" and "recalling" in the same place?

English | [中文说明](README.zh.md)

## The five layers

| Layer | What is stored | Cost per request |
|---|---|---|
| **L0 Library** | Bodies on disk in `L0/docs/<id>.md`, index in `L0/index.json` | Titles + ids of the 6 newest, ≤420 chars |
| **L1 Bridge** | The last 4 messages of the previous conversation (90 chars each) | ≤320 chars, and only in the first turns of a new session |
| **L2 Recall** | Ebbinghaus-weighted entries | Top 12 by weight, ≤1100 chars |
| **L3 Artifacts** | Documents tagged `artifact:*` | 5 newest, ≤320 chars, owner switch |
| **L4 Self-note** | What the model writes about itself, rolling window | 24 entries / 3600 chars |

All five are system-prompt sections, re-evaluated on every assembly. Nothing is appended to the message history.

## Measured cost

Numbers from one machine (the host estimates 4 chars/token; CJK text is denser in practice):

- Tool schemas, all 7: 2331 chars ≈ **583 tokens per request**
- The four cards, with 2 documents and 1 artifact in the library: **338 chars ≈ 85 tokens**
- A 1100-character artifact costs **34 tokens** in context; its body stays on disk

Tool schemas are a permanent tax, which is why L3 adds **no new tool** — it reuses `memory_search(tag:"artifact")` and only pays for one extra `tag` field (+17 tokens).

## Install

Requires DSH `>=0.2.1-rc.2`.

```bash
# from a local checkout
dsh plugin --profile web add /path/to/dsh-memory-chain
# or straight from git
dsh plugin --profile web add git+https://github.com/doresu/dsh-memory-chain.git
```

The plugin manager adds the package to the profile's `bundles` — no manual patch editing. Then **restart the engine**.

Check `~/.dsh/memory/state.json`:

```json
{ "status": "active", "sections": 5, "tools": 7 }
```

A new conversation should show a `## 原文库` section once it is live.

Manual install without the package manager: see [`examples/cordis.patch.yml`](examples/cordis.patch.yml).

## Files

```
$DSH_HOME/memory/
  L1/bridge.json      tail of the previous conversation
  L0/index.json       document index
  L0/docs/<id>.md     document bodies
  L2/items.json       weighted entries
  L2/archived.jsonl   faded or forgotten entries
  L3/owner.json       artifact card switch ({enabled:false} hides it)
  L4/self.json        self-narrative window
  L4/archive/         archived notes
  state.json          written only after registration succeeds
```

## Tools

| Tool | What it does |
|---|---|
| `memory_write_doc` | Persist a document; same title updates in place, id stays |
| `memory_search` | Keyword search returning snippets and paths, **never full text**; optional `tag` |
| `memory_read_doc` | Read a body by id, pageable |
| `memory_note` | Record a durable fact; same key merges, raises weight, lengthens half-life |
| `memory_forget` | Retract a fact (archived, not deleted) |
| `selfnote_append` | Append a self-narrative entry |
| `selfnote_rewrite` | Rewrite the whole window; the old version is archived first |

## Design notes

- **Sections, not messages.** Sections are re-evaluated every assembly and cost no history. `interpolate: false` keeps `{{…}}` inside memory text from being read as template variables.
- **Weights are bucketed to 0.05 before hashing.** Decay is continuous, but the prompt only reorders when a value crosses a bucket — otherwise the prefix cache is invalidated every turn.
- **L1 is truncation, not summarisation.** A summary would cost an extra model call and would drift; truncation is free, faithful, and merely unpolished.
- **L2 fades out of the prompt; it is not deleted.** Entries drop out below 0.1 and are archived below 0.02 after 30 days.
- **L3 reuses L0's storage.** Storing and reading are separate concerns: artifact bodies stay readable, only the card is owner-gated.

## Known limits

- **No semantic search.** L0 matches substrings; phrasing too far from the original wording will miss. Embeddings mean a dependency and a network hop — a bad trade on a phone.
- **Code changes need an engine restart.** The host caches ES modules. During development you can bust it with `file://…?v=2`, but only a recomposition actually reloads.
- **The owner switch only hides a card**, it is not password-grade isolation. Per-session isolation would mean registering tools in an agent scope.
- **No cross-process locking.** Two processes writing the same JSON can lose an update; fine for a single host.
- `importance` on L2 is filled in by the model, not a calibrated parameter.

## Development

```bash
node test/store.test.mjs   # 30 tests, pure functions, no DSH needed
```

## License

MIT
