# ZCode tool renderer sources

The copied renderer and helper sources are from the local ZCode checkout at
`D:/liuzhe/Desktop/code/ZCode`. Their original paths, SHA-256 hashes and Mona
adaptations are recorded in `upstream-sources.json`. ZCode's Apache-2.0 license
is retained in the parent `zcode/LICENSE` file.

`assets/material-icons/` contains the 1,146 SVG files copied from
`packages/desktop/src/renderer/public/material-icons/`. The local ZCode
`THIRD-PARTY-NOTICES.md` identifies these assets as Material Icon Theme under
the MIT License and points to revision
`cb1dfb6d9cb73b15681a93939983d75dbba7bf5b`. That notice says the original
import revision was not recorded. This task used only the local copy; no remote
source was queried. `assets/material-icons-sources.json` records each asset's
source path and SHA-256 hash.

Mona-specific changes are limited to import paths, structural host types,
canonical Mona tool-name mapping at the Activity boundary, recursive renderer
callbacks, and Vite URL imports for the copied icons. Tool rendering logic,
status mapping, summaries, output handling and diff behavior follow the copied
ZCode implementations.
