# Secrets audit (Task 2)

Scope: the whole repository at `arena/01a0f8a7-geocluster-2-0`, **including the
full git history** (every commit, every blob, text and binary), plus the working
tree. Date of audit: 2026-10-16.

## Result: nothing to rotate

**No API key, token, client id, client secret, password or certificate has ever
been committed to this repository.** The only environment-file path that has
ever been tracked is `api/.env.example`, which contains placeholder names with
empty values (and did so in every historical revision as well).

What the scans did find, and why each is safe:

| Finding | Where | Verdict |
| --- | --- | --- |
| `client_id` / `client_secret` as **variable names** | `api/geocluster/satellite.py`, `desktop/frontend/sentinel_client.py` (all revisions) | These are locals that `os.getenv(...)` fills; no literal value accompanies them. |
| `api_key="test-key"` | `api/tests/test_assistant.py` | A test double for a mocked client; never used against a real provider. |
| `MAX_UPLOAD_MB`, `SESSION_MAX_IMAGES`, … | `api/settings.py`, `.env.example` | Non-secret policy numbers that are also returned by `/health`. |
| `GROQ_API_KEY` / `FIREWORKS_API_KEY` / `COPERNICUS_CLIENT_*` | docs, READMEs, `.env.example`, source | Names only; every value is empty in the tracked template. |

## How this was checked (re-run any time)

```bash
cd /path/to/GEOCLUSTER-2.0

# 1) key-shaped literals in every blob that has ever existed (text + binaries)
for obj in $(git rev-list --all --objects | awk '{print $1}' | sort -u); do
  [ "$(git cat-file -t "$obj" 2>/dev/null)" = blob ] || continue
  git cat-file blob "$obj" | strings -a |
    grep -aoE '(gsk_|fw_|sk-|ghp_|AIza|xox[baprs]-)[A-Za-z0-9_-]{10,}'
done | sort -u

# 2) long values assigned to secret-ish names, in every commit
for c in $(git rev-list --all); do
  git grep -I -n -E '(api_?key|secret|password|token|licen[cs]e)["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9_/+-]{24,}' "$c" -- .
done | sort -u

# 3) any env-like file ever added
git log --all --diff-filter=A --name-only --pretty=format: |
  sort -u | grep -iE '\.env|secret|credential|\.pem$|\.key$|id_rsa|token'

# 4) the working tree
git grep -I -nE '(API_KEY|CLIENT_SECRET|PASSWORD|SECRET|TOKEN)["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9_-]{8,}'
```

The test suite keeps this property honest: `api/tests/test_security.py` plants
secret values in the environment and asserts that no endpoint returns them, and
`web/tests/smoke_test.py` scans everything under `web/` for key material and
environment access from browser code.

## What is protected now

Log hygiene is enforced too: `api/log_safety.py` redacts key-shaped strings from
every log line and logged traceback, so even a third-party error message that
quotes the request cannot write a key to the log.

See the **Security** section of `api/README.md` for the full contract:
environment-only secrets, no secret/path/traceback in any response, a CORS
allow-list, `ENABLE_DOCS=false` in production, per-IP rate limits on
`/ai/chat` and `/satellite/fetch`, message/upload size caps, and static serving
that publishes `web/` only (dot-files and parent segments answer 404).

## If you have ever pasted a key somewhere else

The audit covers git history, not your machines, chat logs or deployment
dashboards. If a real Groq key or Copernicus client secret was ever pasted into
a ticket, a screenshot or a shell history, rotate it at the provider and put the
new value in the deployment's environment variables (never in a tracked file).
