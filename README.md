# Grotesqueries

A local browser terminal for CLI sessions. The host owns each session; browser
tabs are views. Start a shell or an installed CLI, take control to type, and
reconnect to its retained output. Closing a tab leaves the session running.

Grotesqueries is free, open source software under Apache-2.0. Bring your own
installed tools and provider accounts. Provider credits and paid services are
not included. Third-party components retain their own licenses.

## Native alpha

Mac and Linux packages include Node and native terminal support. Public downloads,
their tested operating systems and SHA-256 checksums are listed at
[buildguild.gg/downloads/](https://buildguild.gg/downloads/). A platform shown as
pending has no qualified public package yet.

Mac Stop verifies the primary process and descendants that the host has tracked.
A rapidly detached, unobserved daemon can escape that tracking. This limit is
also displayed in the application. Linux uses a per-session supervisor to adopt
and stop descendants. Unknown cleanup remains a visible failure and retains
ownership for a retry. See [platform behavior](docs/platform-support.md).

## Build from source

Use Node **24.14.1**, npm, and the platform C compiler: Apple's Command Line Tools
on Mac or a C compiler and libc development headers on Linux. Mac builds target
macOS 15 or later. This build target alone does not establish release qualification.

```sh
npm ci --ignore-scripts
npm run build
npm run setup:posix
npm run start:posix
```

Setup creates `.runtime/posix/grotesqueries.json`, discovers installed shells and
optional CLIs without running them, and preserves an existing configuration.
Open the local URL printed by the host. Sessions start only when you choose Start.
Each attachment begins in observing mode; choose Take control before input or Stop.

Keep the host on loopback. Its existing fleet code is not qualified as a public
remote-access service. Host restart does not restore live terminal processes.

## Verify and package

```sh
npm run typecheck
npm run typecheck:test
npm test
npm run package:posix
npm run check:package:posix
```

The tar package is an unsigned development artifact. Mac public distribution
requires [Developer ID signing and notarization](docs/macos-signing.md).
Test the actual package using [clean consumer environments](docs/clean-machine-testing.md).
Never remove quarantine or disable Gatekeeper to qualify a Mac release.

`SOURCE-PROVENANCE.json` identifies the reviewed initial source import. Git history
in this repository records subsequent changes. The binary manifest records the
source Git revision, dependency versions and file hashes used for that build.

See [reuse and attribution](docs/reuse.md), [third-party notices](THIRD_PARTY_NOTICES.md),
and the [Apache-2.0 license](LICENSE).
