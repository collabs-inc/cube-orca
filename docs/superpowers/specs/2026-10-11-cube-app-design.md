# Orca on Cube

Run the upstream Orca web client and Node-only runtime as an installable Cube
app. Repositories, files, worktrees, terminals, and agent processes belong to
the Cube machine. Preserve upstream MIT attribution and its pairing protocol.

The integration adds a root manifest, reproducible Linux x64 installer, and
loopback launcher. Build upstream `orcad` and `out/web`; no Electron session
or replacement UI is needed. A gateway serves the web assets and proxies
runtime WebSockets. It bootstraps the browser using the runtime's pairing offer,
rewriting only the advertised endpoint to the authenticated Cube origin.
Pairing credentials must never appear in launcher logs or cacheable responses.

Keep state at `~/.orca/cube`, overridable for isolated tests. The launcher owns
only its runtime child. Preserve the upstream persistent terminal daemon and
use explicit session controls for terminal termination. Desktop-only features
retain upstream capability checks. Do not promise native desktop control.

Reject foreign origins, unknown hosts, and traversal. Serve only built assets;
keep pairing/bootstrap endpoints same-origin. Do not remove Orca authentication.
Test a real disposable repository, worktree, terminal input/output, web reload,
and launcher restart. Use a controlled shell command instead of paid agents.
