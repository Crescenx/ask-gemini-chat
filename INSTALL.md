# Agent installation runbook

This is the entrypoint when a user asks an agent to install and configure this
repository. Complete the steps below in the downloaded checkout. Do not treat
`npm ci`, configuration generation, or `tools/list` alone as a working installation.

## 1. Prepare the runtime

Use Node **24+**, npm, and Python **3.10+** on the same machine/environment that
will run the MCP server. Prefer the user's existing version manager. If those
prerequisites are absent, install them using that machine's normal tooling and
permissions; do not replace unrelated global environments. On Linux, Python must
include `venv` support. On Windows use PowerShell 7 for shell commands. WSL agents
should run Node and Python in WSL, while Chrome can remain on Windows.

Run from this checkout:

```sh
npm run setup
```

This installs locked npm dependencies, creates `.venv`, installs the pinned HTTP
dependency there, and writes machine-specific files under ignored `.runtime/`:

- `install.json`: local installation state, including the chosen Python path;
- `mcp.json`: the `ask-gemini-chat` entry for clients using `mcpServers`;
- `codex.toml`: the equivalent Codex entry, with a 180-second tool timeout.

If the user already provides `GEMINI_HTTP_PYTHON`, setup checks that interpreter
and the pinned dependency without modifying it. Do not set it accidentally to a
base/system Python. Clear it to use the default project environment. Setup records
absolute Node/Python/server paths and existing proxy settings; it does not invent
a proxy or write to any agent's global configuration. Keep `.runtime/` private.
Rerun setup if this checkout or its runtime executables move.

## 2. Sign in through the user's browser

Tell the user, in their language:

> Open Gemini in your own Chrome and sign in to the Google account you want to
> use. Open `chrome://inspect/#remote-debugging`, enable Remote Debugging, and
> leave the Gemini tab open. I'll synchronize the login; Chrome will ask you to
> Allow the connection. You never need to give me your password or copy cookies.

Requires Chrome 144+ for this connection flow. Then run:

```sh
npm run auth -- login
```

Keep that single process running while the user clicks Allow and completes sign-in
or MFA. It waits up to five minutes after connecting and reuses one connection;
do not launch another login process while it waits. The command uses only target
listing/attachment and URL-scoped cookie reads. It does not launch Chrome, click,
type, navigate, install extensions, or send questions. The user performs Google
sign-in. Cookie values stay in the local process and private session file.

The command validates the session against Gemini over HTTP before returning
`state: ready`. An already valid saved session avoids Chrome entirely. After a
successful sync, the connection closes; the user can disable Remote Debugging.
Subsequent questions and session refreshes use HTTP. While running, the MCP process
maintains the session in the background every ten minutes, with backoff for network
failures. If login later expires, repeat this step; the MCP process can stay running
and picks up the renewed session without a restart. Keep the session directory on
a local filesystem so cross-process SQLite locking works reliably.

Chrome's remote-debugging permission grants broader browser access than the few
read-only commands this helper uses. Explain that permission when asking the user
to enable it; this is **not an OAuth consent screen** or an official Google login
integration. A browser-owned confirmation cannot be completed by the agent.

### Discovery and account selection

The helper reads `DevToolsActivePort` from the normal Chrome User Data directory
on Linux, macOS or Windows. In WSL it also discovers the Windows LocalAppData path
through PowerShell 7. No username or browser port is hard-coded.

For a custom Chrome installation, set `GEMINI_CHROME_PROFILE` to its **User Data
root**, the directory containing `DevToolsActivePort` (not `Default`/`Profile 1`).
For an explicitly known endpoint, `GEMINI_BROWSER_WS` accepts only a loopback
`ws://.../devtools/browser/...` address. WSL requires access to Windows localhost;
if that is unavailable, run the install in the browser's environment or use the
manual import fallback in README. Do not expose remote debugging to a network.

The HTTP client uses the default Google account (account 0). If the desired Gemini
page is `/u/1/` or another account, ask the user to open it in a separate Chrome
profile where it is the default. On ambiguity or `ACCOUNT_MISMATCH`, do not guess
or delete the existing database; use a separate `GEMINI_DATA_DIR` and rerun setup.

If the agent already has a browser connection, avoid adding browser-control tools
or repeatedly reconnecting. This helper still needs its own one-time consent to
read the cookies; do not promise that another tool's consent transfers to it.
Never request that the user paste cookies into the agent conversation.

## 3. Verify locally before registering

```sh
npm run doctor
npm run verify
```

`doctor` checks the selected Python dependency, initializes the actual stdio server
from a different working directory, discovers exactly three tools, and checks
Google authentication separately. It uses a temporary database for transport
checks. A successful doctor **does not establish model access**.

`verify` sends one small question over the real MCP transport. It checks the answer
and the actual Argon model ID from upstream history. This consumes a model request
and may take several minutes. Its private `install-check.json` records the request
ID before sending, so restarting the command queries/replays that same request,
not a fresh generation. Do not delete this file to retry an uncertain result.
A cached success explicitly reports its timestamp; it is not a fresh availability
check. If an old completed check now needs retesting, use a separate test data
context deliberately rather than disguising it as recovery.

If status remains `running` or `uncertain`, keep the run ID and poll; do not shorten
the upstream budget or invent new IDs. Report authentication failures, transport
failures and model/answer failures distinctly. A model-unavailable account is not
fixed by changing to another model silently.

Run verification before another client opens this installation's persistent
database. `DATABASE_LOCKED` means a live service already owns it; stop that known
service cleanly or verify through its existing client. Never remove an active lock.

## 4. Register with the user's agent

Identify the current agent from the user's context. If unknown, ask which client
they use; continue setup and login while waiting. Read the generated entry and merge
only `ask-gemini-chat` into that client's current configuration. Preserve unrelated
servers and settings. If an entry already exists, inspect it and update that entry
instead of adding a duplicate. Use the client's supported configuration mechanism.

For **Codex**, merge `.runtime/codex.toml` into the active Codex configuration
(normally `$CODEX_HOME/config.toml`, or `~/.codex/config.toml`). These are two TOML
tables, including the `env` subtable; do not append duplicate tables. Alternatively,
use `codex mcp add ask-gemini-chat --env KEY=VALUE ... -- NODE SERVER` with the exact
values from the generated entry, then set only this server's `tool_timeout_sec`
to 180. Confirm with `codex mcp get ask-gemini-chat --json`.
See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

For **Claude Code, Cursor, or other local MCP clients**, use `.runtime/mcp.json`
as the entry data and follow that client's current supported config location/CLI.
Do not assume every client uses the same file, scope or timeout key. Check the
client's documentation if needed. A cloud-only agent without access to this local
stdio process requires a different deployment; do not claim local registration works.

Refresh/restart the MCP connection using the client's supported mechanism and
confirm it lists `ask_gemini_chat`, `get_gemini_result`, and `upload_gemini_file`.
Multiple stdio clients with the same configuration now share one local background
service and database. On the first upgrade from a direct-database server, let its
active requests finish, stop that old server, and reconnect the clients once.
Later business-source updates reload at idle without closing client connections;
changes to the stdio entrypoint or client configuration still require reconnection.
If this session cannot reload tools, report that a new client session is required;
local SDK verification does not prove the current agent has loaded the tools.

## Completion report

Report: checkout path, client registration/scope, authentication status, actual
model check result (and whether cached), and whether this agent session can see
the three tools. If a user action is pending, name it precisely and continue after
it happens. Do not claim success from generated configuration alone.

## Troubleshooting

| Code | Next action |
| --- | --- |
| `ENABLE_CHROME_REMOTE_DEBUGGING` | User enables it in Chrome 144+; retry login once ready |
| `BROWSER_PERMISSION_TIMEOUT` | User checks Chrome's Allow dialog; do not spawn repeated login processes |
| `OPEN_GEMINI_IN_BROWSER` / `SIGN_IN_TO_GEMINI` | User opens Gemini and completes login; current process waits |
| `OPEN_DEFAULT_GEMINI_ACCOUNT` | Use the intended account as account 0 in a separate profile |
| `BROWSER_PROFILE_AMBIGUOUS` | Set the explicit Chrome User Data root; do not choose arbitrarily |
| `ACCOUNT_MISMATCH` | Keep existing state; use a separate data directory for the new account |
| `NETWORK_ERROR` | Inspect connectivity/proxy; do not extract more cookies to fix networking |
| `PYTHON_DEPENDENCY_UNAVAILABLE` | Check generated absolute interpreter path and pinned requirements |
| `DATABASE_LOCKED` | Use/stop the known existing server; never remove an active lock |

Browser flow reference: [Chrome's session connection documentation](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session).
