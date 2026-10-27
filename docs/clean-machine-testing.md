# Artifact consumer qualification

Run the consumer check on a new extracted copy of the exact release artifact.
It refuses an existing operator configuration or runtime directory. The explicit
`--disposable` argument identifies the folder as test data. The check creates
configuration and harmless shell sessions there; do not use an installed copy.

```sh
"$PACKAGE_FOLDER/bin/node" /isolated/consumer-smoke.mjs "$PACKAGE_FOLDER" --disposable
```

`bin/consumer-smoke.mjs` imports only Node built-ins. It requires that its running
executable is this package's bundled Node. Its WebSocket client must resolve
inside the package's own `node_modules/ws`; it cannot silently use a development
checkout's dependency. It does not install packages or call provider services.

The result is one JSON record with `consumerChecked: true`, source revision,
signing status, actual CPU, kernel, user ID, Node and glibc versions, and the
checks performed. It verifies shipped-file checksums, configuration preservation,
HTTP assets and license notices, origin rejection, authenticated native PTY
startup, Unicode input, resize, disconnect survival, observation on reconnect,
Stop, retained output, sibling survival and host shutdown. On Linux it also
verifies cleanup of an adopted child after the primary process has exited.
Failure retains the original error and attempts bounded host cleanup.

## Minimal Linux root filesystems

Use the archive, its `.sha256` sidecar, Docker and Node on the test controller:

```sh
node bin/check-clean-linux.mjs dist/posix/grotesqueries-VERSION-linux-arm64.tar.gz
```

The controller validates the archive checksum, contained paths and regular file
types before extraction. It pulls official Debian Bookworm Slim, Ubuntu 22.04
and Ubuntu 24.04 images, records their immutable registry digests, and uses those
digests to create the test containers. Each container starts with no installed
Node, npm, npx, compiler or make. The controller refuses CPU emulation.

Each consumer runs as user `65534`, with all Linux capabilities dropped,
`no-new-privileges`, no external network and a read-only base filesystem. Its only
host mounts are the archive and consumer script, both read-only. A new writable
tmpfs contains the extracted application and test data. The source repository,
Docker socket, host credentials and development dependencies are not mounted.
Loopback remains available for the application's authenticated browser protocol.

The controller continues other images if one image fails, records every outcome,
and removes only its named, ownership-labelled test containers. The durable
report is `.runtime/verification/clean-linux/ARCHIVE_SHA256.json`. It records the
actual archive hash, image digest and ID, runtime versions, isolation settings,
tool-absence proof and consumer checks. A nonzero exit leaves that report for
diagnosis.

Containers share the Docker engine's kernel. These results establish clean
root-filesystem compatibility on that kernel; they do not claim three separate
kernel or physical-machine qualifications. Hosted native Linux jobs provide
additional kernel evidence when they run this artifact-only consumer.

## Fresh Mac jobs

A Mac consumer job must download the candidate artifact without installing the
application's source dependencies. Extract or mount/copy the payload into a new
writable location, then invoke its bundled Node with the consumer script. Keep
the consumer script outside the application folder, and use the same command
above. A fresh hosted runner can include developer tools; the check proves that
the application uses its own runtime and modules, not that every system tool is
absent from that runner.

Run the Mac signature, hardened-runtime, notarization, staple and Gatekeeper
checks on the final signed artifact separately. Preserve browser-added download
quarantine. An unsigned artifact passing this consumer test is not evidence of
successful notarization or clean-machine Gatekeeper acceptance.
