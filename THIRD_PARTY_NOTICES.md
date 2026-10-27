# Third-party notices

## CloudCLI Web Terminal plugin

Source: https://github.com/cloudcli-ai/cloudcli-plugin-terminal

Inspected revision: `6757ed0ef067cf7d8e1bf20fa0dd64b97e61889d`.

Retained palette from `src/ui/themes.ts`: `frame/src/terminal/palette.ts`
(previously `app/javascript/terminal/palette.ts`).
The unused theme catalog and preference helpers were removed; Grotesqueries
uses one palette with the same terminal colors as its previous default.
The build setup in `bin/build.mjs` was adapted from the upstream build script.
Other integration references are recorded in [docs/reuse.md](docs/reuse.md).

The upstream package retains this declaration:

```json
{
  "name": "cloudcli-plugin-terminal",
  "version": "1.1.0",
  "license": "MIT"
}
```

The inspected repository does not contain a standalone LICENSE file or a
copyright notice in the copied theme file. No ownership attribution has been
invented or removed. The standard MIT permission terms are included below for
the material declared MIT by that package.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

The npm lockfile records exact dependency versions. The build assembles original
runtime license texts, these copied-source notices and the official Node 24.14.1
distribution LICENSE into the executable-accessible `/licenses` content.
The official Node license is retained unchanged in
`vendor/licenses/node-v24.14.1-LICENSE.txt`; its checked SHA-256 is
`4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18`.

## node-pty 1.2.0-beta.14

Source: https://github.com/microsoft/node-pty. npm version and integrity are
pinned in package-lock.json. Native runtime files and their MIT copyright
headers/license are retained in the embedded/extracted payload. Exact files and
the reproducible windowsPtyAgent.js, windowsTerminal.js and conoutSocketWorker.js adaptations are
recorded in docs/reuse.md. They apply to a project copy, preserving originals.
This exact upstream release replaces 1.1.0 to include the mutex-protected
Windows native handle table from Microsoft/node-pty PR #922. The copied runtime
also adapts asynchronous startup and silent-process readiness; original MIT
source/license headers remain intact.

Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde.
Copyright (c) 2016, Daniel Imms.
Copyright (c) 2018-2020, Microsoft Corporation.

The MIT permission and warranty terms above apply; the original node-pty
LICENSE is also included unchanged in the package's native payload.
# S05 xterm state and serialization

`@xterm/headless` 5.5.0, `@xterm/addon-serialize` 0.13.0,
`@xterm/addon-unicode11` 0.8.0 and the pinned
`@xterm/xterm` 5.5.0 parser/InputHandler adapters: Copyright (c) 2014-2024
The xterm.js authors. MIT License. The xterm MIT terms retained above apply to
these runtime dependencies and confined private-state/mixed-color adaptations.
Installed upstream files are unchanged. Their original package LICENSE notices
are included in the generated executable-accessible notice bundle.

Playwright core 1.63.0 is project-local verification tooling only, not shipped
runtime code. Copyright Microsoft Corporation. Apache License 2.0; the original
LICENSE and NOTICE remain in its installed project-local npm package.

