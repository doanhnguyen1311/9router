Local-only OpenAI-compatible fixture for Chat History integration tests. No workspace, account, live upstream or API key is needed. CLI 1.74.0 was used.

Also shared by per-key effort integration tests (`docs/key-effort/README.md`). Synthetic `openai/` and `moonshotai/` model responses echo the received effort; `openai/gpt-5.1` returns 429 to exercise fallback with an effort lock. These responses prove local request projection, not remote model support.

Run from repo root:
`postman simulation run postman/simulations/chat-history/chat-history.sim.yaml --port 14990 --no-history --output ndjson`

Then run the tests documented in docs/chat-history/README.md. Verify `request` events show both `rate-limited` (429) and `model` (200); a listening event alone does not prove gateway traffic reached the mock. No production credentials/content should be sent to this fixture. Stop the foreground process with Ctrl-C.

The CLI requires `mocks[].path` to point to `config.yaml`, not the mock directory (the directory example in the skill was rejected by CLI 1.74.0). Config/handler changes require restarting the simulation.
