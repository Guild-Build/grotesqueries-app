# Windows x64 package

The Windows release is a ZIP with one folder named
`grotesqueries-<version>-win32-x64`. It contains an embedded Node 24.14.1
executable, editable adjacent `grotesqueries.json`, source/build metadata,
licenses, instructions and `SHA256SUMS`. Node, npm and a compiler are not needed
to run it. Installed CLI tools and their provider accounts are separate.

Extract the ZIP into a writable local folder. Keep the executable and JSON
together, then run these commands in PowerShell:

```powershell
.\grotesqueries.exe --setup
.\grotesqueries.exe
```

Setup discovers installed programs without starting them. Existing configured
profiles are preserved. Open the local URL, choose **Start session**, and choose
**Take control** before typing. Closing a browser tab leaves its process running.
Ctrl+C in the host console requests shutdown and owned-session cleanup. Restart
does not restore live terminal processes. Keep the listener on loopback.

This native alpha is **unsigned**. Windows can show unknown-publisher or
SmartScreen warnings. Do not disable or bypass Windows protection. There is no
claim of an Authenticode identity. The copied Node executable's original
signature is removed before adding the application's SEA payload; the installed
Node binary is never changed.

The adapter needs Windows x64 with ConPTY, build 18309 or later. Qualification
reports identify the actual OS/kernel tested; a Windows Server 2022 runner pass
does not establish every Windows desktop version or enterprise configuration.

Windows Stop verifies process identities and tracked lineage. Primary exit
retains cleanup ownership until Stop succeeds, including for a later subscriber.
A failed cleanup remains retryable. An intermediate that exits before its
lineage is observed can leave an untracked descendant; this is not complete
arbitrary-process containment. The application displays the tracked-process
limit. Keep failure evidence when cleanup cannot be verified.

## Build and qualify

Use Windows x64 and exactly Node 24.14.1:

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run typecheck:test
npm run build
npm test -- windows-package windows-native
npm run package:windows
npm run check:package:windows
```

Packaging writes a versioned archive, its `.sha256` sidecar and a separate
bundled consumer checker under `dist/windows/`. It refuses existing output
archives and checksum files. Use a clean checkout for another candidate; do not
replace an already published asset. The ZIP has stable ordering/timestamps for
the same input bytes. `BUILD-METADATA.json` binds the source Git revision, dirty
state, original Node hash, final EXE hash, dependency ABI and native payload.
Release qualification requires a clean source revision.

`SHA256SUMS` checks original packaged files. An operator's later edit to
`grotesqueries.json` is expected to change that file's checksum. Check the
archive's sidecar before extraction and the original manifest before setup.

The Windows workflow tests source and builds the artifact, then a separate fresh
VM downloads only the ZIP, checksum and bundled checker. The checker uses Node
for its test client; the app runs its embedded runtime with a system-only PATH.
It verifies native input, Unicode, resize, observing reconnect, retained output,
controlled Stop, natural primary exit, detached child/grandchild cleanup, sibling
isolation, and real Ctrl+C shutdown in a dedicated hidden console. Reports are
separate from build metadata; a built archive alone is not qualification.

The SEA and frame helpers adapt the reviewed Grotesqueries implementation at
`792e0ee2641525c61e496f863b634976e8f0b419`. Private operator configuration,
internal history and local evidence are excluded.
