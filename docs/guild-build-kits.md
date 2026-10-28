# Preconfigured Guild Build archives

A kit is one platform archive containing the complete Grotesqueries runtime and
one complete, version-pinned Guild Build. Extract it into a new writable folder.
Its original runtime files, executable permissions and `SHA256SUMS` stay intact.

The supported bundle catalog is `config/guild-builds.json`. It pins the public
Build repository revision, bundle version, download URL, byte count and SHA-256,
plus each bundle file's path, SHA-256 and permission mode. These file pins let
the final consumer check extracted contents without recompressing the source ZIP.
The five published choices are Lean Start, Measured Delivery, Measured Writing
Desk, Evidence-First Review and Trial Runner. They target Claude Code. The trial
baseline, unreleased tools and third-party tools are not kit payload choices.

Each kit additionally contains:

- `guild-builds/SLUG/`: the selected bundle's exact files, including its Claude
  plugin manifest, skills, agents, hooks when present, README and license.
- `GUILD-BUILD.json`: a version-1 receipt binding the runtime version, platform,
  processor, source revision and original archive hash to the selected bundle,
  catalog revision and every bundle file hash.
- `README-GUILD-BUILD.txt`: local setup, CLI prerequisites and source links.
- `KIT-SHA256SUMS`: checksums of the combined payload, excluding this checksum
  file itself. The original runtime checksum file is included unchanged.

The receipt supplies no executable command, environment variable, credential,
project path or arbitrary URL. The application constructs its launch profile
from the installed CLI and the selected bundle. CLI installation and sign-in
remain separate. Setup does not start a session; choose **Start session**, then
**Take control** in the browser. Hook-bearing builds also require Bash and Git,
including Git Bash on Windows. Evidence-First Review additionally needs a JSON
parser: jq, Python 3 or Node on the child PATH. The Linux profile can use its
verified bundled Node. Existing operator and project files must be preserved.

## Assemble a candidate

Use Node 24.14.1 and a clean, reviewed runtime artifact with its `.sha256` sidecar:

```sh
node bin/package-guild-kit.mjs dist/posix/grotesqueries-VERSION-linux-x64.tar.gz lean-start
node bin/package-guild-kit.mjs dist/windows/grotesqueries-VERSION-win32-x64.zip lean-start
```

The assembler downloads only the selected catalog archive from its pinned
BuildGuild URL. To supply already downloaded, checksum-matching bytes:

```sh
node bin/package-guild-kit.mjs RUNTIME_ARCHIVE measured-delivery \
  --bundle measured-delivery-1.0.0.zip --output dist/guild-kits
```

Output filenames include the application version, platform, processor, build slug
and build version. Each has a `.sha256` sidecar and `.assembly.json` report. The
report binds both input archive hashes and revisions to the final kit hash and
size. Repeating identical inputs produces identical bytes. An existing differing
output is refused; existing outputs are never replaced.

The runtime must have a complete valid `SHA256SUMS`, matching
`BUILD-METADATA.json`, `sourceDirty: false`, `guildBuildPresetVersion: 1`, licenses
and the expected launcher. Earlier runtimes without preset support are refused.
Only Linux ARM64/x64 tar-gzip and Windows x64 ZIP runtimes are accepted. Mac binary
kits remain deferred with signed Mac distribution.

Both archive readers enforce bounded compressed and expanded sizes, one contained
root, regular files/directories, portable member names and unique case-insensitive
paths. They reject links, traversal, device names, conflicting paths, bad content
checksums and unsupported archive extensions. Parsing and repacking never execute
archive contents. ZIP inputs use ZIP32 store/deflate without descriptors, extra
fields or comments. Tar inputs use regular USTAR/GNU entries without extended
metadata or long-name records. These are the formats emitted by the supported
first-party packagers.

## Qualification and publication

Assembly checks input integrity; it does not qualify the application, an installed
CLI, an agent workflow or the final kit. The report therefore records
`qualification: "not-run-by-assembler"`. Run native artifact consumer checks and
the selected build's CLI/plugin checks on the final archive before advertising
that platform/build combination as available. Check Bash hooks on each advertised
platform. Retain the runtime's actual signing status and platform limits.

Run the final kit consumer on its native Linux/Windows target using Node 24.14.1,
the original base archive/sidecar and an installed native Claude Code executable:

```sh
node bin/check-guild-kit.mjs KIT_ARCHIVE --runtime BASE_ARCHIVE \
  --claude /path/to/claude --output dist/guild-kits
```

The checker creates an owned disposable extraction with a relocated Unicode path.
It checks unchanged runtime bytes/modes and complete preset integrity against the
embedded pinned catalog. A harmless local Claude-named fixture proves zero
automatic sessions, setup preservation, the generated `--plugin-dir` and workspace,
explicit Start/Take control, native input, Stop and host shutdown. On Windows the
test controller compiles that fixture with the installed .NET tooling; the
downloaded application itself needs no compiler. Host shutdown uses a dedicated
owned console and identity-checked Ctrl+C.

It then invokes the real Claude CLI's strict plugin validation and session-only
plugin list; it creates no model session. Only the selected plugin match and CLI
version enter the report. An isolated Claude configuration and empty Git config
and template keep unrelated settings and credentials out of the test. Actual
hook execution verifies the clean/dirty-worktree advisory or ordinary-command
allow plus force-push/author-merge blocks as applicable. No force push or merge is
performed: these are JSON command fixtures passed to the guard script.

A successful `.qualification.json` binds the final archive SHA-256, baseline
archive SHA-256, source/catalog revisions, selected build, actual OS/CPU/runtime,
CLI version and named checks. It records `modelCalls: 0`. An existing differing
report is preserved. Failure retains the disposable fixture when cleanup is not
established and produces no successful qualification report.

Publish the exact final archive, sidecar and relevant test report through the
normal reviewed release process. The website must link to those tested bytes and
their matching source. Do not replace an existing published version when inputs
change; publish a new version and update the checksum record through review.
