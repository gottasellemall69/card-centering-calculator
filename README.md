# Card Front Grader (Next.js + OpenCV.js)

Front-only trading-card grading assistant that:
- detects the card and rectifies it into a standardized analysis view
- measures front centering with exact `63.5mm x 88.9mm` card dimensions
- uses the conditioning standards PDFs in `standards/` as the source of truth for measurement geometry
- evaluates visible flaws inside standardized border, corner, and surface review zones
- supports manual guide adjustment with the same overlay geometry used by the grader
- can run an optional server-side AI review after deterministic grading completes
- batch-processes multiple images and exports `results.json` and `results.csv`

> This is a conservative assistant tool, not an official PSA grader. Photo quality and front-only visibility still limit what can be proven from an image.

---

## Source Of Truth

The conditioning reference lives in these PDFs:
- `standards/Card-Conditioning-Standards.pdf`
- `standards/Conditioning Overlays.pdf`

The shared implementation layer is:
- `lib/conditioningStandards.ts`

That file now defines the exact card dimensions, centering caps, measurement thresholds, and standardized overlay geometry used by:
- `lib/grader.ts`
- `components/OverlayViewer.tsx`
- `app/page.tsx`

This means the generated grading overlay, the manual guide overlay, and the mm-based centering readout all use the same geometry instead of separate approximations.

---

## Install

```bash
npm install
```

## Run In Dev

```bash
npm run dev
```

Open the local dev server in your browser.

## Verify Production Build

```bash
npm run build
```

---

## Hosted AI Review

The AI reviewer is optional and runs only through the Next.js server route:
- `POST /api/grade-ai`

Configure the server-side environment in `.env.local`:

```bash
OPENAI_API_KEY="sk-..."
OPENAI_GRADER_MODEL="gpt-5-nano"
```

Important behavior:
- The browser never receives the API key directly.
- The route sends the rectified analysis image at high detail and the original source image at low detail for context.
- AI review does not replace deterministic centering, grade ceilings, or standards-based measurements.
- Static hosting, plain HTML export, or any deployment without `/api/grade-ai` will not support AI review.
- If the app is hosted without `OPENAI_API_KEY`, the UI now reports that clearly instead of failing silently.

If you want AI review in production, deploy the app to a real Next.js server environment such as `next start` on Node or a platform that supports App Router route handlers.

---

## How The Grader Works

### 1) Card Detection + Rectification
- The app detects the front card contour.
- If OpenCV finds a stable quadrilateral, it perspective-rectifies the image.
- The working analysis view is normalized to a fixed card-shaped canvas so measurements stay consistent.

### 2) Standards Geometry
The standards module defines the review geometry used throughout the app:
- exact card size: `63.5mm x 88.9mm`
- default inner-frame inset used for fallback centering
- standardized corner review windows
- standardized surface review window
- standardized border segment span for perimeter scanning

Those zones are rendered in both:
- the generated analysis overlay
- the manual overlay viewer used before re-estimating a grade

### 3) Centering
- The grader detects the outer card bounds and inner frame bounds.
- Border thickness is measured on all four sides.
- Percentages are converted into L/R and T/B ratios.
- Exact mm values are derived from the standard card dimensions.
- The worse centering axis sets the deterministic front-centering ceiling.

### 4) Visible Condition Review
The app reviews visible evidence in standardized regions:
- border bands for perimeter wear and hotspot segmentation
- corner windows for corner wear and hotspot detection
- the interior surface-review window for scratches, scuffing, and disturbance signals

Measurements are mapped into project scoring and condition ceilings using the standards-aligned thresholds in `lib/conditioningStandards.ts` and the rubric logic in `lib/rubric.ts`.

### 5) Final Estimate
The final front-image estimate is capped conservatively by the worse of:
- centering ceiling
- visible-defect ceiling
- image observability / confidence ceiling

Severe quality failures return `UNSCORABLE` instead of forcing an artificially low grade.

---

## Manual Review Workflow

1. Upload a front image.
2. Let the app prepare the detection overlay.
3. Use the manual viewer to drag the card and inner-frame guides if needed.
4. Use Auto straighten or manual rotate/skew if the image is tilted.
5. Re-estimate the grade so the deterministic engine uses the updated guides.
6. Optionally run AI review after deterministic grading completes.

The dashed standards windows in the viewer mirror the overlay PDF so the measurement area stays consistent during manual correction.

---

## Tuning

Standards-backed reference values live in:
- `lib/conditioningStandards.ts`

Core detection and scoring engine logic lives in:
- `lib/grader.ts`
- `lib/rubric.ts`

Use `lib/conditioningStandards.ts` when changing:
- physical card dimensions
- standards-based overlay windows
- measurement thresholds derived from the PDFs
- centering caps and measurement guide text

Use `lib/grader.ts` when changing:
- contour detection
- rectification behavior
- border/content extraction heuristics
- hotspot detection behavior
- confidence and observability calculations

---

## Troubleshooting

### AI Review Does Not Respond On A Hosted Page
Check these first:
- Is the app running as a real Next.js server deployment, not a static export?
- Does the deployment expose `/api/grade-ai`?
- Is `OPENAI_API_KEY` configured on the server?
- Did the deployment restart after adding the env var?

### Overlay Looks Misaligned
- Use Auto straighten first, then small manual rotate/skew adjustments.
- Drag the outer card guides onto the true card edges.
- Drag the inner guides onto the true frame-to-art transition.
- Re-estimate after guide or normalization changes so the engine uses the corrected geometry.

### When A Result Is Still Not Reliable
- Glare, blur, shadows, textured foils, and missing borders can still reduce certainty.
- Front-only images cannot prove back-surface defects, micro-indents, or some gloss issues.

---

## Limitations

- The additive flaw-point model is project-specific and must not be treated as an official PSA scoring formula.
- Borderless designs or cards with weak frame-to-art transitions can still be difficult to center reliably.
- Micro-scratches, faint gloss loss, and subtle print-registration defects remain hard to prove from a single front image.
- Textured, holographic, embossed, etched, or glitter finishes can still produce false positives unless reviewed carefully.
- This project evaluates front images only; it is not a substitute for full physical authentication or grading.

---

## License

MIT (you can replace this).
