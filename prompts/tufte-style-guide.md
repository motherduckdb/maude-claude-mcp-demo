# Tufte Style Guide for HTML Generation

## Core Philosophy
1. Maximize data-ink ratio — Every pixel should convey information. Remove chartjunk and decorative elements.
2. Small multiples — Use consistent visual encoding across repeated elements for easy comparison.
3. Integrate text and data — Weave narrative prose with inline statistics.
4. High information density — Pack maximum insight into minimum space.

## Typography
- Use Google Fonts: Source Sans Pro for numbers, system serif (Palatino, Georgia) for text
- Big numbers: 42px, letter-spacing: -1px
- Section headers: 11px uppercase, letter-spacing: 1.5px
- Body: 14px, line-height: 1.6
- Tables: 12px body, 10px headers

## Color Palette
- Background: #fffff8 (warm cream, Tufte signature)
- Text: #111 (primary), #666 (secondary), #999 (tertiary)
- Accent: #a00 (burgundy - use sparingly for emphasis)
- Lines/borders: #ccc
- Bars: #888 (grayscale)

## Layout
- padding: 40px 60px, max-width: 1200px
- Use CSS Grid: 4-col for KPIs, 2-col for main content, 3-col for details
- Section spacing: 28px between major sections

## Components to Use
- Big numbers with small labels for KPIs
- Inline bar charts in tables (div with percentage width)
- SVG sparklines with area fill and accent dot on final point
- Horizontal bar rows for year-over-year comparisons
- Tables with right-aligned numeric columns using tabular-nums

## Anti-patterns (Avoid)
- No pie charts (use tables with inline bars)
- No 3D effects, gradients for decoration
- No colored section backgrounds
- No chart borders/frames
- No excessive gridlines
