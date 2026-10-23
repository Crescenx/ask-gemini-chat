# Agent entrypoint

When the user says "install and configure", read [INSTALL.md](INSTALL.md) and
carry the process through dependency setup, browser login, model verification,
and registration with the user's MCP client. README contains the public interface.

Use `npm run setup`, `npm run auth -- login`, `npm run doctor`, and `npm run verify`.
The user signs in and confirms Chrome's connection themselves. Do not ask for
passwords/cookies in chat, automate sign-in, or print private local files.
Do not equate successful tool discovery with successful Gemini access.
Preserve existing client settings and reuse request IDs when recovering results.

For code changes, run `npm run check` and `npm test`. Keep the three-tool surface
and the separation between one-time browser authentication and HTTP generation.
Never commit `.runtime`, session files, cookie exports, databases or live transcripts.
