# Bug Report: SVG Generation Claims Validation Pass While Output Is Invalid XML

## Summary

AgInTiFlow generated SVG figures for a LaTeX publication task and reported that all SVG files had valid `<svg>` roots. However, one generated SVG was not well-formed XML and failed downstream conversion with `cairosvg`.

The immediate cause was an unescaped less-than character in SVG text:

```xml
<text ...>Latency < 50 ms, spike sorting accuracy ≥ 85%</text>
```

The corrected form is:

```xml
<text ...>Latency &lt; 50 ms, spike sorting accuracy ≥ 85%</text>
```

## Environment

- Project: `/home/lachlan/ProjectsLFS/brain-on-a-chip`
- AgInTiFlow command used from project root:

```bash
aginti -s normal --image --latex --no-web-search --routing complex --provider deepseek --main-model deepseek-v4-pro "<figure generation prompt>"
```

- Generated output directory:

```text
publications/figures/
```

## Generated Files

AgInTiFlow produced:

```text
biology_electronics_interface.svg
first_demo_loop.svg
phased_roadmap.svg
```

It also left an implementation helper:

```text
publications/figures/generate_svgs.py
```

## Observed Behavior

AgInTiFlow final summary said:

```text
Verification (all PASS)
- All files non-empty
- All have valid <svg> root with xmlns and viewBox attributes
```

But external validation showed:

```text
publications/figures/biology_electronics_interface.svg XML_OK
publications/figures/first_demo_loop.svg XML_OK
publications/figures/phased_roadmap.svg XML_BAD not well-formed (invalid token): line 82, column 64
```

`cairosvg` failed similarly:

```text
xml.etree.ElementTree.ParseError: not well-formed (invalid token): line 82, column 64
```

## Expected Behavior

For SVG-generation tasks, AgInTiFlow should validate the full XML document, not only check for an `<svg>` root.

A generated SVG should pass:

```bash
python -c 'import sys, xml.etree.ElementTree as ET; [ET.parse(f) for f in sys.argv[1:]]' publications/figures/*.svg
```

If the task involves LaTeX or publication assets, it should also verify conversion with one available renderer, for example:

```bash
cairosvg publications/figures/phased_roadmap.svg -o publications/figures/phased_roadmap.pdf
```

## Impact

- The agent reported success before the artifact was usable.
- The publication compile could not safely consume the generated SVG assets until the XML was manually repaired.
- The issue is easy to miss because the file opens as plain text and still contains an `<svg>` root.

## Recommended Fix

Add a stronger SVG validation step to the relevant image/LaTeX/publication workflow:

1. Parse every SVG with an XML parser.
2. Escape SVG text values using XML-safe entity encoding for `&`, `<`, `>`, quotes where needed.
3. If a renderer is available, convert SVG to PDF or PNG as part of verification.
4. Treat failed conversion as a task failure, not a warning.
5. Do not report "valid SVG" based only on root-tag grep.

## Suggested Regression Test

Use a prompt that asks for a roadmap figure containing text such as:

```text
Latency < 50 ms
Accuracy >= 85%
Signal & safety gate
```

Expected result:

- SVG text is escaped as XML.
- `xml.etree.ElementTree.parse` succeeds.
- `cairosvg` conversion succeeds when available.
- Final summary reports the actual validation commands used.

## Manual Workaround Applied

In the user project, the invalid line was patched from:

```xml
Latency < 50 ms, spike sorting accuracy ≥ 85%
```

to:

```xml
Latency &lt; 50 ms, spike sorting accuracy ≥ 85%
```

After this, all SVG files converted successfully to both PDF and PNG.
