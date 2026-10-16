# Source and extraction notes

The nine reference files contain the complete static return strings from WorkBuddy 5.3.14's `VisualizerGuidelines` methods in the supplied source archive (`workbuddy-visualizer/original/main/initialize.js`). The archive SHA-256 supplied with the source is `466c8a91a5ff2665d94f0506e66015bfa31a40996dc6780bac5d1f00bbc1d640`.

Extraction was textual: each method's template literal was located and checked for termination and `${...}` interpolation; no target JavaScript was executed. Static JavaScript escapes for backticks and forward slashes were decoded to their returned string values.

`mona/templates/agent/visualizer.md` is a byte-for-byte extraction of the `<instructions_for_visualizer>` and `<visualizer_examples>` sections of the same archive's `resources/templates/workbuddy-prompt.tpl` (lines 167-219). Its SHA-256 is `7b7806dc391017dda8d6d9687ffad945bbacdf48125a85ac321d2f4f87b3cd66`. Only the existing `productName` template variable is rendered as Mona. Mona's theme-field mapping, implemented color classes, and dedicated artifact/prototype routes are handled outside this source template.

| Reference | Source method | Source lines |
| --- | --- | --- |
| `core.md` | `getCoreDesignSystem` | 63127-63173 |
| `colors.md` | `getColorPalette` | 63175-63194 |
| `svg.md` | `getSvgSetup` | 63196-63241 |
| `diagram.md` | `getDiagramTypes` | 63243-63301 |
| `ui.md` | `getUIComponents` | 63303-63350 |
| `interactive.md` | `getInteractiveGuidance` | 63352-63358 |
| `chart.md` | `getChartJsRules` | 63360-63403 |
| `maps.md` | `getD3ChoroplethRules` | 63405-63437 |
| `art.md` | `getArtGuidance` | 63439-63450 |

No license conclusion is made here.
