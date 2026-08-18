# Accuracy review

Changes made to reduce systematic error and misleading conclusions:

- **Separated image uncertainty from card condition.** Blur, glare, resolution, and framing now affect confidence/scoreability rather than numerically lowering an otherwise measurable card grade. Severe failures remain `UNSCORABLE`.
- **Removed correlated double-counting.** The aggregate perimeter-damage finding is retained as evidence, but it no longer adds a second set of points on top of the edge/corner/surface findings from which it is derived.
- **Corrected physical dimensions.** Pixel-to-length/area conversion now uses 6.35 x 8.89 cm (2.5 x 3.5 in) for a standard trading card.
- **Removed false authority and systematic pessimism from AI review.** The prompt no longer claims the model is a PSA employee with 15 years of experience and no longer instructs it to lower borderline grades by default. Uncertainty is represented as uncertainty/manual review instead.
- **Clarified the scoring model.** The additive defect-point bands are explicitly project heuristics, not an official PSA points formula.
- **Removed `.env.local` from the deliverable.** Secrets/configuration files should not be distributed in source archives.

## Remaining calibration limits

The project still cannot establish an official PSA grade from a single front photograph. The defect thresholds and score-to-grade mapping need validation against a sufficiently large, independently labeled image set. Reverse-side condition, gloss, depth, alteration, authenticity, and defects requiring angle/magnification remain outside the reliable scope of a single front image.

For production accuracy, measure performance by grade (confusion matrix and mean absolute grade error), by defect type (precision/recall), and by scoreability decision. Calibrate thresholds on a training split and report final metrics only on a held-out test split.
