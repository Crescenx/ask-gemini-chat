# ask-gemini-chat

A local MCP server for Gemini web chat: ask complex questions, upload files,
continue conversations, and recover results after a disconnect or process restart.

**Unofficial and experimental.** This uses Gemini's private web protocol, not the
Google Gemini API. It needs your own signed-in Google account with access to the
configured Argon model. Protocol changes, account restrictions, and session expiry
can interrupt service. This project is not affiliated with Google.

## Install with your agent

Download this repository, open it in your local coding agent, and say:

> Install and configure ask-gemini-chat for my agent. Follow INSTALL.md and
> verify that it works. Tell me when I need to sign in or confirm Chrome's connection.

中文也可以直接说：**“按照 INSTALL.md 安装并配置这个工具，需要我登录时告诉我。”**

The agent installs dependencies, generates machine-specific MCP settings, checks
login and the real model, and registers the three tools. You sign in to Gemini in
your own Chrome and approve one browser connection; no manual cookie copying is
needed for the normal path. See [INSTALL.md](INSTALL.md) for the complete agent runbook.

## What it exposes

| Tool | Purpose |
| --- | --- |
| `upload_gemini_file` | Upload an authorized local file (absolute path, at most 20 MiB) and return `file_id` |
| `ask_gemini_chat` | Ask a question, optionally with `file_ids` or an existing `chat_id` |
| `get_gemini_result` | Poll or recover the original request using `run_id` |

Generation uses HTTP. Login optionally reads the user-approved Chrome session.
There is no page automation, native MCP invocation, local command execution,
or public HTTP server. Gemini may use its own built-in file analysis and calculation
features. Returned code and model text are data; this server does not execute them.

## Install from source

Requires Node.js **24 or later** and Python **3.10 or later**. Linux/WSL is tested;
other operating systems have not been verified. Clone or download this repository,
then run these commands in its root:

```sh
npm run setup
npm run auth -- login
npm run doctor
npm run verify
npm run check
npm test
```

The Python helper uses pinned `curl_cffi` with a Chrome TLS profile. Setup records the chosen interpreter locally. Without setup or
`GEMINI_HTTP_PYTHON`, it uses `python3` (`python` on Windows) from PATH. Keep the
interpreter path absolute when configuring an MCP client. Standard proxy variables
such as `HTTPS_PROXY` are honored; no machine-specific proxy is enabled by default.

## Authenticate

Run `npm run auth -- login`. In Chrome 144+, sign in normally at Gemini, enable
Remote Debugging at `chrome://inspect/#remote-debugging`, and click Allow when
Chrome asks. The helper reads only the two required session cookies, validates
them over HTTP and closes the connection. It never asks for passwords or prints
cookies. You can disable Remote Debugging afterward; normal operation uses HTTP.
See [login steps and account selection](INSTALL.md#2-sign-in-through-the-users-browser).
This is local session synchronization, not OAuth.

### Manual fallback (advanced)

If browser discovery is unavailable, explicit cookie import remains supported.
Sign in at `https://gemini.google.com` using the default Google account in that
browser profile. In browser developer tools, find the Google cookies named
`__Secure-1PSID` and `__Secure-1PSIDTS`. Store their values in a private JSON file
outside the repository, accessible only by you:

```json
{
  "__Secure-1PSID": "YOUR_COOKIE_VALUE",
  "__Secure-1PSIDTS": "YOUR_COOKIE_VALUE"
}
```

Import that file (or pipe JSON to `import -`):

```sh
npm run auth -- import /absolute/private/path/cookies.json
npm run auth -- status
```

Import validates the account over HTTP before saving the session. Browser automation
is not required. `npm run auth -- refresh` refreshes the saved session; if it reports
`LOGIN_REQUIRED`, stop the MCP server, import fresh cookies, then restart it. Do not
share cookies, put their values in command-line arguments, or commit session files.
Delete the temporary export after a successful import. Never submit cookies in issues.

## Configure an MCP client

`npm run setup` produces `.runtime/mcp.json` and `.runtime/codex.toml` with the
actual absolute paths. Have the agent merge the appropriate entry into its client
configuration as described in INSTALL.md. These files do not contain cookies.

Example configuration; replace both absolute paths:

```json
{
  "mcpServers": {
    "ask-gemini-chat": {
      "command": "node",
      "args": ["/absolute/path/ask-gemini-chat/scripts/server.ts"],
      "env": {
        "GEMINI_HTTP_PYTHON": "/absolute/path/ask-gemini-chat/.venv/bin/python"
      }
    }
  }
}
```

Ensure `node` resolves to Node 24+ in the client's environment; use its absolute
path if necessary. Set the client's per-tool timeout to at least 180 seconds for
uploads. Generation is polled in short calls, so the client need not hold a single
call open for the entire answer. Run from a source checkout; npm-registry installation
is not provided. The package is marked private to prevent accidental npm publication.

## Use

Upload a file:

```json
{"request_id":"upload-orders-1","path":"/absolute/path/orders.csv"}
```

Ask with the returned file ID:

```json
{"request_id":"question-1","prompt":"Compute the totals and explain the rules.","file_ids":["RETURNED_FILE_ID"],"wait_ms":20000}
```

If the answer is still `running`, call `get_gemini_result`:

```json
{"run_id":"RETURNED_RUN_ID","wait_ms":20000}
```

For a follow-up, call `ask_gemini_chat` with the returned `chat_id`, a new question,
and a new `request_id`. Up to eight files and 120,000 prompt characters are accepted.
`wait_ms` ranges from 0 to 25,000 (default 20,000).

**Keep the same request ID and arguments when retrying an interrupted tool call.**
Changing its arguments produces `IDEMPOTENCY_CONFLICT`. A result marked `uncertain`
means completion is unknown: query its original run; do not submit a new question
to recover it. Recovery checks exact upstream turn IDs, prompt and parent context.
A `completed` status confirms committed upstream output, not the correctness of
its content; Google can also return error prose as a completed answer.

## Local storage

By default, session and SQLite state are stored under
`~/.local/share/ask-gemini-chat/`, independently of the working directory.

| Environment variable | Override |
| --- | --- |
| `GEMINI_DATA_DIR` | Directory containing `session.json` and `state.sqlite` |
| `GEMINI_SESSION_FILE` | Session file path |
| `WEBCHAT_DATABASE` | SQLite database path |
| `GEMINI_HTTP_PYTHON` | Python executable with the HTTP dependency installed |

Use absolute override paths. Files contain credentials, conversation text and
attachment references. Uploads and prompts go to Google. One process may open a
database at a time: a second client using it receives `DATABASE_LOCKED`. Independent
clients need separate data directories and authentication. Keep the database to
preserve request deduplication and conversation continuity; removing it loses that
recovery information. Stop the server before changing or deleting its files.

## Validation and scope

`npm run doctor` checks installation, tool discovery and authentication separately.
`npm run verify` checks a real answer and actual model identity, preserving the
same request across retries.

`npm test` uses synthetic fixtures, a local HTTP server, and the real MCP SDK. It
needs the Python helper but no Google credentials or external model calls. Tests
cover upload bounds, MIME types, streaming, deduplication, continuation, process
interruption recovery, and explicit errors. `npm run check` type-checks TypeScript.
GitHub Actions runs both with an isolated Python environment.

The source implementation was verified on 2026-10-23 with CSV and rules attachments,
weighted projection calculations, a follow-up, and a server restart/replay. Both
rounds were confirmed from upstream history as Argon (`95a4c0abcba24364`); they took
about 232 and 333 seconds. This extracted package is separately checked with local
tests; private transcripts, credentials and live experiment artifacts are not
included. No multi-account or long-term availability guarantee is implied.

The standalone installer was also verified on 2026-10-23 in a clean source copy:
setup created its own Python environment, type-checking and 42 tests passed, and
doctor correctly distinguished missing authentication from working MCP transport.
On WSL, Chrome discovery and read-only synchronization were verified against an
already-authorized browser connection. The new `verify` command received a correct
real answer and confirmed Argon from history; rerunning reused its saved success.
A fresh Chrome permission dialog and native macOS/Windows installs were not tested.

The shared state/backend implementation retains internal revision and history
operations so existing recovery invariants stay intact. Only the three tools above
are public. There is no official Google API fallback or automatic model substitution.
The upstream request budget is 30 minutes, with additional history recovery time.

## Contributing and licensing

MIT; see [LICENSE](LICENSE) and [dependency notices](THIRD_PARTY_NOTICES.md).
Please include a synthetic reproduction and a test with changes. Before reporting
a bug, remove cookies, tokens, prompts, file contents and account identifiers.
Do not upload raw session files, databases or captured network traffic.
