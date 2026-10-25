# Secrets audit

Scope: the whole repository, including its full git history (every commit and
every blob, text and binary), plus the working tree. The last run was on
2026-10-25, on the cleanup branch `arena/01a0f8a7-geocluster-2-0`.

## Result: nothing to rotate

No API key, token, client ID, client secret, password or certificate has been
committed to this repository. The only environment file ever tracked is
`api/.env.example`, which holds placeholder names with empty values.

The scans did find some text that looks like a secret at first glance. Each
finding was reviewed and falls into one of these groups:

| Group | Where | Verdict |
| --- | --- | --- |
| Secret-named variables and parameters (for example `client_secret` in code that reads it from the environment) | `api/geocluster/`, `desktop/frontend/` (all revisions) | Identifiers, not values. A value is read at run time with `os.getenv`. |
| Test doubles for the AI and Copernicus clients | `api/tests/` | Placeholders such as `test-key` or `SECRET-TOKEN`, used by mocked clients only. |
| Fake, key-shaped sentinels | `api/tests/test_security.py`, `api/tests/test_unified_server.py`, and earlier revisions of this document | Deliberate test values. The tests plant them in the environment and assert that no response, error body or log line contains them. They are not credentials. Current revisions build them at run time, so the source has no complete key-shaped literal. The older revisions remain in history and are not rewritten. |
| Names of settings in documentation | READMEs, `api/.env.example`, `docs/` | Names only. Every value in the tracked template is empty. |

## How the checks work

Re-run these any time. The output should show only the groups above.

1. **Every blob in history.** For each object reachable from any branch, read the
   contents and match these families: Groq-style and OpenAI-style keys, GitHub
   tokens, Google API keys, Slack tokens, `Bearer` header values, private key
   blocks, and long values assigned to secret-named variables. Print only the
   finding type, the file and the commit that introduced it. Never print the value.
2. **Env-like files ever added.** `git log --all --diff-filter=A --name-only` filtered
   for `.env` (except `.env.example`), `.pem`, `.key`, `.p12`, `.pfx` and `id_rsa`.
3. **The working tree.** `git grep` for the same families, excluding documentation
   that describes them.
4. **Ignored files.** `git check-ignore` confirms that `.env`, `api/.env` and the
   virtual environment folders are ignored, and that `.env.example`, `LICENSE` and the
   README files are not.

The test suite keeps the runtime behaviour honest. `api/tests/test_security.py`
plants secret values in the environment and asserts that no endpoint returns them.
`web/tests/smoke_test.py` scans everything under `web/` for key material and for
environment access from browser code.

## What is protected at run time

`api/log_safety.py` redacts key-shaped strings from every log line and every logged
traceback. A third-party error message that quotes a request therefore cannot write
a key to the log.

See the **Security** section of [`api/README.md`](../api/README.md) for the full
contract: secrets only in environment variables, no secret, file path or traceback in
any response, a CORS allow-list, `ENABLE_DOCS=false` in production, per-IP rate
limits on `/api/ai/chat` and `/api/satellite/fetch`, message and upload size caps, and
static serving that publishes only `web/` (dot-files and parent segments answer 404).

## If you have ever pasted a key somewhere else

This audit covers git history. It does not cover your machines, chat logs, shell
history or deployment dashboards. If a real Groq key or Copernicus client secret was
ever pasted into a ticket, a screenshot or a shell history, rotate it at the provider
and put the new value in the deployment's environment variables, never in a tracked
file.
