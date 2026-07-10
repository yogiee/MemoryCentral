# MemoryCentral — brand assets

Standalone icon + wordmark package. Drop into a repo (`/assets/brand/`, `/public/brand/`, wherever) and reference directly. Everything is plain SVG with baked-in colors — no font dependencies, no theme coordination required.

---

## Files

| File                       | Use                                                                            | viewBox  |
|----------------------------|--------------------------------------------------------------------------------|----------|
| `mark.svg`                 | Primary icon. Toolbar, in-product chrome, app icon, favicon source.            | 24 × 24  |
| `mark-live.svg`            | Variant with dashed scanline. Splash, launch tile, README hero only.           | 24 × 24  |
| `favicon.svg`              | Same bytes as `mark.svg`, named for clarity when wiring `<link rel="icon">`.    | 24 × 24  |
| `wordmark.svg`             | Dot-matrix LED panel — `MEMORY` over `CENTRAL`. Wordmark on its own.            | 82 × 30  |
| `lockup-horizontal.svg`    | Icon + dot-matrix wordmark, side by side. For headers, README, document chrome. | 118 × 30 |
| `lockup-stacked.svg`       | Icon over dot-matrix wordmark, centered. For splash and centered hero moments.  | 82 × 78  |
| `tokens.css`               | The two brand colors as CSS custom properties.                                  | —        |
| `MemoryCentral Icon.html`  | Full hi-fi spec page — anatomy, scale strip, on-color contexts, all variants.   | —        |

---

## Colors

Only two. They never change between light and dark — they're chosen to read on both.

```
gray  #818487   brackets + unlit dot-matrix cells
cyan  #2ab1c0   diagonal connector, filled center cell, CENTRAL row
```

For the unlit dot-matrix cells: same gray at **22% opacity** (`rgba(129, 132, 135, 0.22)`).

See `tokens.css` for ready-to-paste CSS custom properties.

---

## Anatomy of the mark

Sharp geometry on a strict 24-unit grid. Every measurement falls on a half-unit so it pixel-snaps clean at 16, 24, 32.

| Element                | Spec                                                                     |
|------------------------|--------------------------------------------------------------------------|
| Artboard               | 24 × 24                                                                  |
| Corner brackets        | 5-unit legs, inset 2 from each edge, 1.8 stroke, square linecap          |
| Diagonal connector     | (3, 3) → (9.5, 9.5), 1.5 stroke, cyan                                    |
| Center cell            | 5 × 5 filled cyan, positioned at (9.5, 9.5)                              |
| Z-order                | connector → cell → brackets (brackets always on top)                     |
| Minimum size           | 16 × 16 px (favicon)                                                     |
| Clear space            | ≥ one bracket leg length (5 units) on all sides                          |

---

## Anatomy of the wordmark

5×7 LED-style dot font. Two stacked lines, left-aligned, separated by one empty row.

| Element                | Spec                                                                     |
|------------------------|--------------------------------------------------------------------------|
| Character cell         | 5 cols × 7 rows                                                          |
| Character gap          | 1 col                                                                    |
| Line gap               | 1 row                                                                    |
| Dot pitch              | 2 units                                                                  |
| Lit dot radius         | 0.78 units                                                               |
| Unlit dot radius       | 0.72 units                                                               |
| Unlit color            | brand gray at 22% opacity                                                |
| `MEMORY` (line 1)      | 6 characters · 35 cols wide · gray                                       |
| `CENTRAL` (line 2)     | 7 characters · 41 cols wide · cyan                                       |
| Panel size             | 41 cols × 15 rows → 82 × 30 viewBox                                      |

---

## Usage

### Favicon

```html
<link rel="icon" type="image/svg+xml" href="/brand/favicon.svg" />
```

The mark reads on both light and dark browser chrome — no separate dark variant needed.

### Inline icon (toolbar, button, chrome)

```html
<img src="/brand/mark.svg" alt="MemoryCentral" width="24" height="24" />
```

Or inline the SVG directly for finer control. The colors are baked in, so it works on any background.

### Wordmark in a header

```html
<a href="/" class="brand">
  <img src="/brand/lockup-horizontal.svg" alt="MemoryCentral" height="30" />
</a>
```

For a clean text-based wordmark (instead of dot-matrix), use plain HTML + Geist:

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap" />

<a href="/" class="brand">
  <img src="/brand/mark.svg" width="24" height="24" alt="" />
  <span style="
    font: 600 18px/1 Geist, system-ui, sans-serif;
    letter-spacing: -0.025em;
    color: currentColor;
  ">MemoryCentral</span>
</a>
```

### Splash / hero

Use `lockup-stacked.svg` (icon over wordmark) or `mark-live.svg` (with scanline) at large size:

```html
<img src="/brand/lockup-stacked.svg" alt="MemoryCentral" height="180" />
```

### README hero (GitHub)

Drop into the top of `README.md`:

```markdown
<p align="center">
  <img src="./brand/lockup-stacked.svg" alt="MemoryCentral" height="160" />
</p>
```

Both the icon and dot-matrix wordmark are pure geometry, so GitHub's image proxy can't blur or alter them.

---

## Do / don't

**Do**
- Use `mark.svg` everywhere by default. One file, every context.
- Keep the gray + cyan exactly as specified.
- Honor the clear-space rule when placing the mark next to other elements.

**Don't**
- Don't recolor the cyan to match a specific theme — its job is to stay constant.
- Don't add stroke effects, shadows, glows, or rotations.
- Don't use `mark-live.svg` below ~64px — the scanline disappears.
- Don't typeset MEMORY/CENTRAL in a regular font — if you need text, use `MemoryCentral` (single word, mixed case) in Geist 600. Only the dot-matrix renders the all-caps split form.

---

## Spec reference

Open `MemoryCentral Icon.html` in a browser for the full visual spec: anatomy with measurements, size scale (512 → 16), on-color demonstration across eight backgrounds, platform tile compositions (macOS, iOS, Windows, Linux, favicon strip), and live SVG export with copy/download buttons.
