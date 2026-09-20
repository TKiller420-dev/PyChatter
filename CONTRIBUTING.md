# Contributing

Thanks for taking the time to improve PyChatter.

## Development Workflow

1. Fork or branch from `master`.
2. Create a virtual environment and install dependencies:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   python -m pip install -r requirements.txt
   ```

3. Keep changes scoped and easy to review.
4. Run the relevant checks before opening a pull request.

## Checks

Run syntax checks:

```bash
python3 -m py_compile server/store.py server/server.py server/web_bridge.py server/admin_server.py
node --check web/app.js
```

Run the integration smoke test while `scripts/run_server.sh` is running:

```bash
python3 tests/integration_smoke.py
```

## Project Conventions

- Keep persistent or permission-sensitive features server-authoritative.
- If the browser adds a feature that changes durable state, add the matching server packet/handler.
- Do not commit local databases, secrets, real TURN credentials, or token files.
- Prefer small, clear changes over broad rewrites.
- Keep the web client dependency-free unless there is a strong reason to change that direction.

## Pull Request Checklist

- [ ] The change is described clearly.
- [ ] Server/client packet changes are documented in the PR.
- [ ] Relevant checks were run.
- [ ] No secrets or generated local data are included.
