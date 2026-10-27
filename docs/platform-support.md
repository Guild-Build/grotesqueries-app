# Native alpha platform behavior

The host and browser use a shared protocol. Start is explicit, reconnect begins
in observing mode, and only the current controller can send input, resize or Stop.
Closing the browser does not stop the host's session. Final output is retained.

Linux sessions use a dedicated subreaper supervisor and generation-bound pidfd
signals. When a primary process exits, descendant ownership is retained until
cleanup is verified. Linux requires glibc, a kernel with pidfd support, and the
exact operating system/CPU combination listed for the download. Alpine/musl
packages are not supplied.

Mac uses a bootstrap handshake, kernel birth identities, and audit-token signals.
Its cleanup guarantee covers tracked processes only. A rapid double-fork/setsid
daemon can leave the tracked tree before observation. Do not interpret a successful
Stop as complete arbitrary-daemon cleanup. The application keeps this scope visible.

Windows x64 uses ConPTY and generation-bound owned-tree signaling. Primary exit
retains cleanup ownership until Stop verifies the known lineage. Its scope is
tracked descendants: a detached descendant behind an unobserved exited parent
can escape that lineage. The executable is unsigned; release checks do not
establish publisher trust or acceptance by every device's download policy.

All platforms retain failed or unknown cleanup and allow a cleanup-only retry.
No platform recovers live PTYs after host loss. Native tests use harmless
owned fixtures and verify that unrelated sibling processes survive Stop.

The Mac build target is macOS 15. A release becomes supported on a platform only
after its final downloadable bytes pass that platform's qualification. Signing,
notarization and clean consumer tests are separate gates. Read the download page
and release evidence for actual qualified targets; build success is insufficient.

Windows ZIPs and Linux archives use their own native artifact-consumer gates.
Read their release reports for the actual operating systems and runner limits.
Preset kits additionally verify the selected Guild build, passive setup,
fixed launch profile, plugin loading and hook dependencies. Fleet, provider integrations, load limits and
enterprise deployment have not been qualified by these native package checks.
