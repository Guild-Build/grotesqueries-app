# Reuse and attribution

First-party Grotesqueries code is Apache-2.0 with the rights holder's authorization.
Third-party code keeps its original license. See `THIRD_PARTY_NOTICES.md` and the
generated `/licenses` route for full runtime license text.

- CloudCLI Web Terminal, revision `6757ed0ef067cf7d8e1bf20fa0dd64b97e61889d`:
  the terminal palette now in `frame/src/terminal/palette.ts` and the esbuild
  host/browser build structure were adapted from its MIT-declared package.
  Its session lifecycle, plugin loader and automatic process behavior are not used.
- Microsoft node-pty `1.2.0-beta.14`: the npm lockfile pins its integrity. POSIX
  packages copy unchanged runtime JavaScript and only the target's native prebuild.
  Mac packages set spawn-helper's executable mode and re-sign the native files.
  Windows' `app/services/native-payload.ts` makes version-checked, copied-runtime
  adaptations to `windowsPtyAgent.js`, `windowsTerminal.js` and
  `worker/conoutSocketWorker.js` for readiness, owned helpers and final-output drain.
  Installed upstream files and original MIT notices remain intact.
- xterm.js `5.5.0`, headless `5.5.0`, serialize `0.13.0` and Unicode11 `0.8.0`:
  confined version-specific adapters in `lib/protocol/src/terminal-state-adapter.ts`
  and `frame/src/terminal/replies.ts` preserve state and suppress replay replies.
  Only the authoritative host answers terminal queries. Original MIT notices remain.
- Node `24.14.1`: the official runtime is bundled with its unchanged complete
  distribution license in `vendor/licenses/node-v24.14.1-LICENSE.txt`, SHA-256
  `4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18`.
  Mac release signing changes its code signature and applies explicit runtime
  entitlements; package manifests record the resulting bytes.
- The previous first-party Mac port at revision
  `41ac9ce00791cc769121e693cd491f00565af181` supplied bootstrap/tracked-process
  structure and test ideas. Current modules are `app/services/mac-pty.ts`,
  `app/services/mac-processes.ts` and `app/native/macos-processes.c`. Numeric-PID
  signaling was replaced with captured kernel identities. The tracked-only
  cleanup limit remains explicit.

Linux supervision and pidfd cleanup are first-party implementation. No Apple or
Linux kernel code was copied. Dependencies not listed above remain pinned in
`package-lock.json` and retain the licenses packaged from their npm distributions.
