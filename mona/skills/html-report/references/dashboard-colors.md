# Dashboard color system

Use this reference for dashboards and reports with quantitative charts. Define the palette in CSS variables first, then let every chart consume those variables.

## Separate three color layers

1. **Shell and content:** background, surface, text, muted text, borders, and grid lines establish hierarchy.
2. **Brand and state:** brand accent identifies the product or current entry. Success, warning, danger, and active-agent colors describe actual states only.
3. **Data:** `--data-1` through `--data-6` encode categories and series. They remain separate from brand and state semantics.

Do not turn a restrained brand palette into monochrome charts. Do not fill the whole dashboard with brand red, or use success green and warning orange as arbitrary categories. Data needs distinguishable hue as well as labels, values, markers, or line styles.

## Palette rules

- Define at most six categorical data colors and keep their order stable.
- Adjacent categories must differ in hue and lightness. Opacity variants of one hue are not a categorical palette.
- One metric keeps the same data token across charts and pages.
- Axes, grid lines, legends, and explanatory text use shell tokens.
- A single-series chart usually uses `--data-1`; comparison charts use one colored current series and a neutral or dashed prior series.
- Sequential heatmaps use the surface plus transparent-to-solid steps of one data hue.
- Diverging scales use two explicit data hues. Status colors apply only when the data actually carries that status meaning.
- Color is never the only differentiator: preserve labels and values; distinguish multiple lines with markers or dash patterns.

## Mona product dashboard

When the dashboard belongs to Mona, use Mona Paper / Mona Night for the shell and Mona Red only as a small identity signal.

| Role | Light | Dark | Usage |
| --- | --- | --- | --- |
| Paper / night surface | `#FFFEFA` | `#1F1F1F` | Main work surface |
| Ink | `#1A1A1A` | `#D4D4D4` | Main text and primary structure |
| Muted ink | `#6B6B67` | `#C1C1C1` | Secondary text |
| Rule | `#E4E4DF` | `#313131` | Axes, grids, separators |
| Mona Red | `#E51F2D` | `#E51F2D` | One 2px tab/section signal, current identity, rare key emphasis |
| Data 1 · blue | `#527CA8` | `#82ACD6` | Primary series |
| Data 2 · teal | `#438A7E` | `#70B7AA` | Second category / activity |
| Data 3 · ochre | `#BD873C` | `#D8AA6C` | Third category |
| Data 4 · violet | `#846D9C` | `#B29AC8` | Fourth category |
| Data 5 · rose | `#B8667E` | `#D594A7` | Fifth category |
| Data 6 · olive | `#7D8354` | `#AEB477` | Sixth category |

The data colors are deliberately softer than Mona Red. A chart can use several of them; the page still feels like Mona because its shell, typography, dividers, active-tab signal, and restrained red identity remain consistent.

For a Mona product implementation, consume global semantic tokens rather than copying these hex values into a business component. For a standalone HTML deliverable, declare the corresponding values once as `--data-1` … `--data-6` and use only those variables in chart code.
