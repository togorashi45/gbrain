# Install on a Hermes VM (the verified recipe)

This is the known-good gbrain + Hermes configuration, distilled from bringing a
production VM (Postgres brain, Hermes agent, Composio/Hostaway/etc. MCP stack)
to **`gbrain doctor` 100/100**. Follow it and a fresh VM converges to the same
state instead of rediscovering every pitfall.

Fast path (idempotent):

```bash
export OPENROUTER_API_KEY=sk-or-...   # or put it in /opt/brain/.env
sudo bash scripts/vm-hermes-setup.sh
sudo bash scripts/vm-hermes-setup.sh --verify   # doctor only
```

Everything below is what the script does and **why**.

---

## 1. Layout

| Piece | Path | Notes |
|---|---|---|
| gbrain CLI | `~/.bun/bin/gbrain` | `bun install -g github:rspur-hq/gbrain` |
| Brain home | `/opt/brain` (`GBRAIN_HOME`) | ⚠️ changes the config path — see pitfall 1 |
| File-plane config | `$GBRAIN_HOME/.gbrain/config.json` | embed/chat/reranker + database_url |
| DB-plane config | Postgres `config` table | `gbrain config set <key> <value>` |
| Hermes config | `~/.hermes/config.yaml` | MCP server registration |

## 2. The working config (file plane)

```json
{
  "engine": "postgres",
  "database_url": "postgresql://brain:<password>@127.0.0.1:5432/brain",
  "embedding_model": "openrouter:openai/text-embedding-3-small",
  "embedding_dimensions": 1536,
  "chat_model": "openrouter:openai/gpt-5.2",
  "schema_pack": "gbrain-base-v2",
  "mcp": { "publish_skills": true },
  "reranker_model": "llama-server-reranker:cohere/rerank-4-fast",
  "provider_base_urls": {
    "llama-server-reranker": "https://openrouter.ai/api/v1"
  }
}
```

And the DB-plane mirror (belt-and-braces; keeps every reasoning-tier consumer
aligned):

```bash
gbrain config set models.chat openrouter:openai/gpt-5.2
gbrain config set models.tier.reasoning openrouter:openai/gpt-5.2
gbrain config set search.reranker.enabled true
gbrain config set search.reranker.model llama-server-reranker:cohere/rerank-4-fast
```

**OpenRouter model ids that work:** `openai/gpt-5.2` ✅ · `openai/gpt-5.2-mini` ❌
(does not exist — typos here fail at call time, not config time).

## 3. Hermes MCP registration

```yaml
mcp_servers:
  gbrain:
    command: /root/.bun/bin/gbrain
    args: [serve]
    enabled: true
    env:
      GBRAIN_DATABASE_URL: postgresql://brain:<REAL password>@127.0.0.1:5432/brain
      GBRAIN_HOME: /opt/brain
```

Expected result: ~102 gbrain tools in Hermes (`gbrain put_page`, `get_page`, …).

---

## Pitfalls (each one cost real debugging time)

### 1. `GBRAIN_HOME` changes the config path
With `GBRAIN_HOME=/opt/brain`, the config lives at `/opt/brain/.gbrain/config.json`
— **not** `~/.gbrain/config.json`. Editing the wrong file produces
"my config change did nothing" symptoms. Always
`GBRAIN_HOME=/opt/brain gbrain config …` (or export it).

### 2. File-plane `chat_model` was shadowed by hardcoded tier defaults (FIXED in v0.42.67)
`reconfigureGatewayWithEngine` resolves the chat model through
`resolveModel()`, whose chain put the hardcoded `TIER_DEFAULTS.reasoning`
(`anthropic:claude-sonnet-4-6`) *above* the file-plane fallback. On installs
with no DB-plane `models.*` keys, config.json's `chat_model` was silently
ignored → dream/extract ran on the wrong provider and produced 0 takes.

v0.42.67 adds a `configFileValue` slot to the resolver: an explicit config.json
value now beats the hardcoded defaults but still loses to every DB-plane key
(`models.chat` > `models.default` > `models.tier.*`) and env vars. Setting
`models.chat` in the DB plane (step 2 above) remains a valid, explicit
override.

### 3. MCP "Connection closed" = wrong `GBRAIN_DATABASE_URL`
The gbrain MCP server fails **silently** (Hermes shows 0 tools) when the
database URL password is wrong. Never guess (`brain:brain` is not the
password). Source of truth: `database_url` in `$GBRAIN_HOME/.gbrain/config.json`.
The setup script extracts it automatically.

### 4. Reranker without ZeroEntropy
The default reranker (`zeroentropyai:zerank-2`) needs a ZeroEntropy key. The
verified alternative is Cohere via OpenRouter, using the generic
`llama-server-reranker` provider pointed at OpenRouter's base URL (see config
above). `search.reranker.enabled true` + `search.reranker.model
llama-server-reranker:cohere/rerank-4-fast`.

### 5. Upgrade errors file goes stale
`~/.gbrain/upgrade-errors.jsonl` accumulates entries from old failed upgrades
and makes doctor report failures for a healthy system. After a successful
upgrade, delete it if the entries reference versions you no longer run.

### 6. Verify with live data, not just doctor
Doctor can be green while a model id is subtly wrong (typos pass config
validation). Smoke-test the real path: `gbrain put_page` a test note, run
extract, confirm takes land in the DB, and run a search with reranker on.

## Verification checklist (the 100/100 state)

- [ ] `gbrain doctor` — all categories 100
- [ ] Hermes MCP: `gbrain` server connected, ~102 tools
- [ ] Pages/links/takes extract end-to-end (put_page → extract → takes > 0)
- [ ] All chunks embedded (`chunks = pages` in doctor output)
- [ ] Search returns reranked results
- [ ] Dream cron runs on schedule (`~/.hermes/scripts/gbrain-dream.sh`)
