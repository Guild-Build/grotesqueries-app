# Mac signing and notarization

Mac releases use a signed, notarized and stapled DMG. The disk image contains
the self-contained application folder. Users copy that entire folder to a
writable location before running `./grotesqueries --setup` and
`./grotesqueries`; the mounted image is read-only. The application does not need
a separately installed Node, npm or compiler.

The unsigned POSIX tarball is a separate developer artifact. It is not a
substitute for the final Mac download or its notarization ticket.

## Existing credentials

The release command requires an existing, valid **Developer ID Application**
identity with its private key available in the current Keychain, and an existing
`notarytool` Keychain profile. This pipeline creates no certificate, profile,
account, password or credential. It does not change Keychain access rules or
disable operating-system protections.

Find the identity's SHA-1 selector with:

```sh
security find-identity -v -p codesigning
```

Use only the identity selector and approved profile name as command arguments.
Never pass Apple passwords or private-key material in command lines, repository
files or logs. If the existing Keychain needs unlocking or the identity is not
available, resolve that through the approved operator setup before release.

## Build and qualify a release

Use Node **24.14.1** and a clean, reviewed source checkout with installed locked
dependencies. The command rebuilds the host, frame and native helper itself:

```sh
node bin/package-macos.mjs \
  --identity "$GROTESQUERIES_SIGNING_IDENTITY" \
  --keychain-profile "$GROTESQUERIES_NOTARY_PROFILE"
```

These two variables contain non-secret identity/profile selectors. The Keychain
holds the private key and notarization credentials.

The pipeline:

1. Compiles the helper with deployment target **macOS 15.0**. It inspects every
   bundled Mach-O: Node, node-pty's addon and spawn helper, and the process helper.
   A foreign architecture, unexpected binary or newer minimum OS blocks packaging.
2. Signs each Mach-O individually with a secure timestamp and hardened runtime.
   Node receives only `com.apple.security.cs.allow-jit`; other binaries receive
   no entitlements. Debugging, unsigned-executable-memory and library-validation
   exceptions are not inherited from the upstream Node signature.
3. Verifies each signature against Apple's Developer ID Application certificate
   chain, requires one team across the payload, and checks exact entitlements.
4. Runs the existing native Mac tests using the re-signed bundled Node and helper.
   Their real children therefore lack debugging entitlements. This includes
   bootstrap ownership, generation-bound signals, sibling isolation and cleanup.
   It also runs the relocated package's real terminal/reconnect/Stop checks.
5. Creates and signs a DMG. Before upload, it records the original image hash,
   source revision and owned staging path in `dist/macos/*.submission.json`.
6. Submits once through the existing Keychain profile and records the returned
   submission ID before waiting. Only Apple's `Accepted` status with no log
   issues proceeds.
7. Staples a fresh copy of the uploaded image, preserving the original submitted
   bytes for recovery. It validates the ticket and Gatekeeper assessment, mounts
   the image read-only, checks the nested files, and runs the artifact-only
   consumer check directly with the copied bundled Node and preserved extended
   attributes. It does not re-archive away quarantine for this check.
   Only then does it place the final `.dmg`, `.sha256` and
   `.notarization.json` together at the top level of `dist/macos/`.

The final SHA-256 is computed **after stapling**. Signing changes the Node binary;
metadata retains the original Node input hash and records its signed hash.
The source revision is a real Git commit; dirty source and invented revision
fallbacks are refused.

The deployment target is a binary load requirement, not evidence that every
Mac version or architecture has been tested. Qualify each advertised target on
its oldest claimed OS. Mac Stop still covers tracked descendants only; rapidly
detached unobserved daemons can escape discovery.

## Recovery

A wait timeout does not start another submission. Resume the recorded one:

```sh
node bin/package-macos.mjs \
  --identity "$GROTESQUERIES_SIGNING_IDENTITY" \
  --keychain-profile "$GROTESQUERIES_NOTARY_PROFILE" \
  --resume dist/macos/RELEASE-NAME.submission.json
```

Resume requires the original uploaded image hash and a contained, regular
candidate file. Unknown, rejected or changed bytes remain blocked. If the upload
response was lost before its ID was saved, inspect `notarytool history` and the
matching Apple log, then associate the verified submission ID with that receipt.
Do not upload another copy to work around an unknown outcome. Staging and Apple
logs remain in ignored output for inspection; no credential is stored there.

After final DMG verification, a durable promotion checkpoint records the exact
staged DMG, checksum and notarization-receipt paths and their hashes. All three
staged files are flushed before this checkpoint is saved. Final filenames are
placed atomically without overwriting existing files; an existing regular file
is reused only when its bytes match the checkpoint. A symlink or conflicting
file is left untouched and stops promotion.

If a copy, placement or final receipt write is interrupted, use the same
`--resume` command. It detects the saved checkpoint, completes missing placements,
and rechecks the final DMG without another upload or stapling operation. The full
verified staging set remains available throughout recovery and after the final
receipt is durable. Do not discard it while a promotion is unfinished.

## Download verification

The final verifier needs Apple's verification tools on the qualification host:

```sh
node bin/check-macos-release.mjs path/to/RELEASE.dmg --require-quarantine
```

Use the exact image obtained through a browser on a fresh Mac. The quarantine
requirement checks that the download mark is still present; the script never
removes it or changes Gatekeeper. It verifies the image hash, Developer ID,
stapled ticket, Gatekeeper, nested signatures and actual bundled runtime.
An unquarantined local build can be checked without the flag, but that does not
replace the browser-download qualification.

Apple documents the supported containers, standalone-binary ticket limit and
stapling workflow in [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
Its [notarization troubleshooting](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
explains why debugging entitlements cannot ship.

No Developer ID signing or notarization acceptance is claimed until those
operations actually succeed with the approved credentials and final bytes.
