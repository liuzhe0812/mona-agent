# Academic research acceptance fixtures

These fixtures are synthetic, public-domain, or generated specifically for
Mona's deterministic tests.  They are not copies of copyrighted papers.

The fixture manifest records the expected identifiers, hashes, and results.
Provider responses model the shape of official APIs but use `example.invalid`
URLs and synthetic records so offline tests never depend on network state.

The paper fixture is a two-page Markdown document with explicit page markers;
the papers directory also contains three generated PDFs covering text, table,
and figure/page-boundary extraction. The data files contain the same four-row
table in CSV, JSON, and XLSX form.
The algorithm fixture is a tiny deterministic Python program whose baseline
metric is `0.75`.
