# Card Front Grader (Next.js + OpenCV.js)

Front-only trading card photo grading assistant that:
- detects the card, perspective-rectifies it
- estimates **front centering** (L/R and T/B) and applies the PSA-style centering caps from your rubric
- runs **heuristic flaw detection** and converts measurements into the **severity/points** table you provided
- renders a **visual overlay** (inner border box, border bands, midlines, flaw summary text)
- batch-processes multiple images in one session and exports `results.json` and `results.csv`

> This is an *assistant tool*, not an official PSA grader. Photo quality heavily affects outputs.

---

## Requirements
- Node.js 18+

## Install
```bash
npm install
```

## Run (dev)
```bash
npm run dev
```
Open the local dev server in your browser.

## How it works
### 1) Card detection + rectification
- Canny edges + contour search for the largest 4-point polygon
- Perspective warp to a fixed size close to a standard card (default **640x890**) for consistent pixel-to-cm conversion

### 2) Centering
- On the rectified image, compute edge-energy per row/column
- Find prominent **inner edges** (border → artwork boundary) to estimate an inner content rectangle
- Borders in pixels:
  - `leftPx = innerLeft`
  - `rightPx = width - innerRight`
  - `topPx = innerTop`
  - `bottomPx = height - innerBottom`
- Convert to percentages:
  - `leftPct = leftPx / (leftPx + rightPx)` and similarly for others
- Report **L/R** ratio and **T/B** ratio
- Use the **worse** of the two as the front centering score, then apply the rubric caps:
  - worst side <= 55% → PSA 10 cap
  - <= 65% → PSA 9 cap
  - <= 70% → PSA 8 cap
  - <= 75% → PSA 7 cap
  - <= 80% → PSA 6 cap
  - <= 85% → PSA 5/4 cap (your text repeats 85/15 for both)
  - <= 90% → PSA 3/2/1.5 cap

### 3) Flaws (heuristics)
Measured in the rectified image using px→cm conversion (6.4cm x 8.9cm assumed).
- **Scratch**: Hough line segments in the interior; sum lengths → severity by your cm cutoffs
- **Scuffing**: local texture anomaly area (|gray - blur|) → cm² thresholds
- **Edgewear**: edge energy within a perimeter strip → approximate perimeter wear length
- **Indentation**: small high-contrast blobs (Laplacian) → mm² thresholds
- **Grime**: low-saturation + dark blobs in perimeter strip → mm² / cm² thresholds
- **Bend**: long crease-like lines (Hough, large minLineLength) → cm thresholds
- **Corner rounding**: corner patch distance transform → average corner radius (px) thresholds

Total points are mapped to a condition and a **grade cap**.
Final grade = *worse* of:
- centering cap
- flaw cap

### 4) UNSCORABLE
The app returns **UNSCORABLE** with reasons and a lower confidence when:
- card cannot be found
- border/inner content boundary cannot be detected
- image is too blurry, too glary, or too skewed

---

## Tuning
All thresholds live in `lib/grader.ts` under `export const TUNING = { ... }`.
This includes:
- Canny thresholds
- blur/glare cutoffs
- border detection parameters
- flaw severities and measurement thresholds
- card physical size used for px→cm conversion

---

## Optional server persistence
By default, everything runs locally in the browser.
If you want to persist results to a temp folder on the Node server (dev/Node runtime), POST to:
- `POST /api/save`
- `GET /api/results`
- `GET /api/results/:id`

Files go to:
- `/tmp/card-grader-results/<id>/`

---

## Limitations / known gaps
- Cannot reliably detect: micro-scratches, gloss loss, subtle print registration issues, extremely faint stains.
- Border-based centering assumes there is a detectable border-to-art boundary; borderless designs will often be UNSCORABLE.
- Glare and strong shadows can create false positives for scuffs/grime.

---

## License
MIT (you can replace this).
