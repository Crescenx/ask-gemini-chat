# Third-party dependencies

This repository contains project source extracted from the local gemini-mcp-lab
implementation. It does not vendor browser scripts, captured responses, Google
assets, credentials, or third-party source code. The optional login helper uses the
Chrome DevTools Protocol through Node's built-in WebSocket client; it does not
embed browser scripts or require a browser automation dependency. Dependencies are installed
separately by npm and pip and retain their own licenses.

Direct runtime dependencies (declared package metadata):

| Package | Version | License |
| --- | --- | --- |
| @modelcontextprotocol/sdk | 1.32.1 | MIT |
| mime-types | 3.0.2 | MIT |
| zod | 4.6.7 | MIT |
| curl_cffi | 0.16.3 | MIT |

Development dependencies: TypeScript (Apache-2.0) and @types/node (MIT).
The npm lockfile records the full resolved dependency tree and license identifiers.
Its transitive packages declare MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause or ISC.
Consult the installed packages for the authoritative license texts and notices.
Python wheels can contain native libraries with additional notices; preserve the
licenses supplied by curl_cffi and its dependencies when redistributing binaries.
This project does not redistribute those wheels or native binaries.

Gemini and Google are trademarks of their respective owners. The MIT license
covers this project's code, not access to Google's services or their content.
