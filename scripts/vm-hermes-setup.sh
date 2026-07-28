#!/bin/bash
# vm-hermes-setup.sh — provision a fresh VM with the verified gbrain + Hermes
# configuration (the "known-good" recipe: doctor 100/100 on the reference VM).
#
# What it does (idempotent — safe to re-run):
#   1. Installs/upgrades gbrain from this repo via bun
#   2. Writes $GBRAIN_HOME/.gbrain/config.json (file plane) with the
#      OpenRouter-first recipe (embed + chat + reranker)
#   3. Mirrors the model keys into the DB plane (gbrain config set)
#   4. Registers the gbrain MCP server in Hermes config.yaml, wiring the
#      REAL database_url from config.json (the #1 install pitfall — a guessed
#      or stale GBRAIN_DATABASE_URL makes the MCP server fail with
#      "Connection closed" and zero tools)
#   5. Restarts the Hermes gateway and runs `gbrain doctor` for verification
#
# Prerequisites: bun, postgres with a `brain` database, Hermes installed,
# OPENROUTER_API_KEY in env or $GBRAIN_HOME/.env.
#
# Every value is env-overridable. Defaults match the reference VM:
#   GBRAIN_HOME=/opt/brain
#   CHAT_MODEL=openrouter:openai/gpt-5.2        (gpt-5.2-mini does NOT exist)
#   EMBED_MODEL=openrouter:openai/text-embedding-3-small
#   EMBED_DIMS=1536
#   RERANKER_MODEL=llama-server-reranker:cohere/rerank-4-fast
#   RERANKER_BASE_URL=https://openrouter.ai/api/v1
#   DATABASE_URL=postgresql://brain:<password>@127.0.0.1:5432/brain
#
# Usage:
#   sudo bash scripts/vm-hermes-setup.sh              # full setup + verify
#   sudo bash scripts/vm-hermes-setup.sh --verify     # doctor only

set -euo pipefail

GBRAIN_HOME="${GBRAIN_HOME:-/opt/brain}"
CHAT_MODEL="${CHAT_MODEL:-openrouter:openai/gpt-5.2}"
EMBED_MODEL="${EMBED_MODEL:-openrouter:openai/text-embedding-3-small}"
EMBED_DIMS="${EMBED_DIMS:-1536}"
RERANKER_MODEL="${RERANKER_MODEL:-llama-server-reranker:cohere/rerank-4-fast}"
RERANKER_BASE_URL="${RERANKER_BASE_URL:-https://openrouter.ai/api/v1}"
HERMES_CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
CONFIG_DIR="$GBRAIN_HOME/.gbrain"
CONFIG_JSON="$CONFIG_DIR/config.json"

log()  { echo "[vm-setup] $*"; }
fail() { echo "[vm-setup] ERROR: $*" >&2; exit 1; }

if [ "${1:-}" = "--verify" ]; then
  exec gbrain doctor
fi

command -v bun    >/dev/null || fail "bun not found — install: curl -fsSL https://bun.sh/install | bash"
command -v gbrain >/dev/null || log "gbrain not on PATH yet — installing…"

# --- 1. Install / upgrade gbrain ------------------------------------------------
GBRAIN_PKG="${GBRAIN_PKG:-github:rspur-hq/gbrain}"
log "installing gbrain from $GBRAIN_PKG"
bun install -g "$GBRAIN_PKG" || log "already installed / upgrade skipped (continuing)"
command -v gbrain >/dev/null || fail "gbrain still not on PATH after install"

# --- 2. File-plane config.json --------------------------------------------------
mkdir -p "$CONFIG_DIR"

# Preserve an existing database_url — it holds the real Postgres password and
# must never be regenerated blindly.
EXISTING_DB_URL=""
if [ -f "$CONFIG_JSON" ]; then
  EXISTING_DB_URL=$(python3 -c "import json;print(json.load(open('$CONFIG_JSON')).get('database_url',''))" 2>/dev/null || true)
fi
DATABASE_URL="${DATABASE_URL:-$EXISTING_DB_URL}"
[ -n "$DATABASE_URL" ] || fail "no database_url: set DATABASE_URL=postgresql://user:pass@host:5432/brain (or pre-seed $CONFIG_JSON)"

# Merge (not clobber): keep unknown keys the user already has.
python3 - "$CONFIG_JSON" "$DATABASE_URL" "$EMBED_MODEL" "$EMBED_DIMS" "$CHAT_MODEL" "$RERANKER_MODEL" "$RERANKER_BASE_URL" <<'PY'
import json, sys
path, db_url, embed, dims, chat, reranker, reranker_base = sys.argv[1:8]
try:
    cfg = json.load(open(path))
except Exception:
    cfg = {}
cfg.update({
    "engine": "postgres",
    "database_url": db_url,
    "embedding_model": embed,
    "embedding_dimensions": int(dims),
    "chat_model": chat,
    "reranker_model": reranker,
})
cfg.setdefault("schema_pack", "gbrain-base-v2")
cfg.setdefault("mcp", {"publish_skills": True})
pbu = cfg.setdefault("provider_base_urls", {})
pbu["llama-server-reranker"] = reranker_base
json.dump(cfg, open(path, "w"), indent=2)
print(f"[vm-setup] wrote {path}")
PY

# --- 3. DB-plane mirror ----------------------------------------------------------
# v0.42.67+: file-plane chat_model now beats hardcoded tier defaults, so these
# are belt-and-braces — but they keep models.tier.reasoning aligned for every
# other reasoning-tier consumer (think, dream phases, fact extraction).
log "mirroring model config into DB plane"
GBRAIN_HOME="$GBRAIN_HOME" gbrain config set models.chat "$CHAT_MODEL"           || log "WARN: models.chat set failed"
GBRAIN_HOME="$GBRAIN_HOME" gbrain config set models.tier.reasoning "$CHAT_MODEL" || log "WARN: models.tier.reasoning set failed"
GBRAIN_HOME="$GBRAIN_HOME" gbrain config set search.reranker.enabled true        || log "WARN: reranker.enabled set failed"
GBRAIN_HOME="$GBRAIN_HOME" gbrain config set search.reranker.model "$RERANKER_MODEL" || log "WARN: reranker.model set failed"

# --- 4. Hermes MCP registration --------------------------------------------------
# The GBRAIN_DATABASE_URL here MUST be the real one from config.json — guessing
# (e.g. brain:brain) is the classic failure: MCP "Connection closed", 0 tools.
if [ -f "$HERMES_CONFIG" ]; then
  GBRAIN_BIN="$(command -v gbrain)"
  python3 - "$HERMES_CONFIG" "$GBRAIN_BIN" "$DATABASE_URL" "$GBRAIN_HOME" <<'PY'
import sys
path, gbrain_bin, db_url, gbrain_home = sys.argv[1:5]
try:
    import yaml
except ImportError:
    print("[vm-setup] PyYAML missing — add this block to mcp_servers in Hermes config manually:")
    print(f"""  gbrain:
    command: {gbrain_bin}
    args: [serve]
    enabled: true
    env:
      GBRAIN_DATABASE_URL: {db_url}
      GBRAIN_HOME: {gbrain_home}""")
    sys.exit(0)
cfg = yaml.safe_load(open(path)) or {}
mcp = cfg.setdefault("mcp_servers", {})
mcp["gbrain"] = {
    "command": gbrain_bin,
    "args": ["serve"],
    "enabled": True,
    "env": {"GBRAIN_DATABASE_URL": db_url, "GBRAIN_HOME": gbrain_home},
}
yaml.safe_dump(cfg, open(path, "w"), default_flow_style=False, sort_keys=False)
print(f"[vm-setup] gbrain MCP registered in {path}")
PY
else
  log "Hermes config not found at $HERMES_CONFIG — skipping MCP registration"
fi

# --- 5. Restart + verify ----------------------------------------------------------
if command -v supervisorctl >/dev/null; then
  supervisorctl restart hermes 2>/dev/null || supervisorctl restart all 2>/dev/null || true
  log "hermes gateway restarted"
fi

log "running gbrain doctor — target: all green (100/100)"
GBRAIN_HOME="$GBRAIN_HOME" gbrain doctor || log "WARN: doctor reported failures — inspect above"

log "done. If doctor is green, the VM matches the reference install."
