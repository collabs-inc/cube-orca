# Orca for Cube

Install `https://github.com/collabs-inc/cube-orca` through Cube's app installer.
The root `cube.json` builds the upstream Orca browser UI and Node-only runtime.
Repositories, worktrees, terminals, and installed agent CLIs run on your Cube
machine. Agent provider credentials and subscriptions remain your own.

## Requirements

This package supports Linux x86_64 with glibc, Git, Python 3, Make, a C++
compiler, and tar. Installation needs network access and several gigabytes of
free disk and memory. The installer downloads checksum-pinned Node 24 and
pnpm, compiles the native PTY module, and builds the runtime and web client.
Electron is not installed or launched. Builds are bounded to a 2 GiB Node heap;
native build tools and other processes need additional memory.

## State and lifecycle

Orca state lives at `~/.orca/cube`, outside the replaceable app checkout.
Set `ORCA_CUBE_STATE_DIR` to use another directory. Repository contents and
worktrees remain on the machine at the locations managed by Orca.

Cube supplies `PORT` and authenticates the public app URL. The launcher binds
the gateway and runtime to loopback. The gateway serves only built web assets,
then pairs the browser through Orca's existing encrypted protocol. Don't expose
the loopback port through an unauthenticated proxy: access to this app grants
control of the machine's repositories and terminals.

Stopping the app stops its owned runtime. Orca's persistent terminal daemon
preserves active sessions across runtime restarts. Close terminals or remove
worktrees in Orca when you want their processes to stop.

## Scope

This fork packages Orca's existing web client; it doesn't recreate the desktop
shell. Native desktop integration and computer/browser automation requiring a
separate operator or Chromium sidecar aren't installed by this package.
Upstream capability checks determine which controls are available.

If startup reports `inotify_add_watch` with `No space left on device`, the
machine may have exhausted its file watches even when disk space is available.
Free unused watchers or have the machine administrator raise its inotify limit.
The installer keeps upstream runtime startup checks enabled and reports failure.

## Validation

The fork's **Cube app** GitHub workflow runs the complete installer, focused
wrapper tests, and a real repository/worktree/PTY round trip through the public
gateway. It checks browser pairing, reload, and runtime restart with isolated
state. Browser screenshots are uploaded as workflow artifacts. The fork disables
upstream PR workflows that depend on upstream infrastructure; the Cube workflow
is the integration gate, not a claim that every upstream desktop test ran.

After installation, run these checks from the checkout:

```sh
cube/tools/node/bin/node --test cube/*.test.mjs
cube/tools/node/bin/node cube/smoke.mjs
```

The smoke test uses a disposable home and repository. If cleanup fails, it
retains that fixture's state for recovery instead of deleting session ownership
information. CI additionally runs `cube/smoke.mjs --browser` with Playwright.

## License

Orca is MIT licensed. The upstream [license](../LICENSE) and copyright notice
remain intact. Dependency licenses continue to apply. This is a Cube integration
fork, not an official Orca distribution or endorsement by Stably.
