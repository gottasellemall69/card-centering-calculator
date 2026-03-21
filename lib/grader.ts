/*
  Photo-based front-only grading pipeline.
  This is heuristic by design; the overlay is intended for user audit.
*/

import {
  centeringCapFromWorstSidePct,
  finalGradeFromCaps,
  pointsToCondition,
  severityToPoints,
  type GradeCap,
  type Severity
} from './rubric';

export type UnscorableReason = {
  code:
    | 'CARD_NOT_FOUND'
    | 'CARD_PARTIAL'
    | 'BLURRY'
    | 'EXTREME_SKEW'
    | 'GLARE'
    | 'BORDER_NOT_DETECTABLE';
  message: string;
};

export type CenteringAxis = {
  leftPx: number;
  rightPx: number;
  topPx: number;
  bottomPx: number;
  leftPct: number;
  rightPct: number;
  topPct: number;
  bottomPct: number;
};

export type CenteringResult = {
  lr: { ratio: string; worstSidePct: number };
  tb: { ratio: string; worstSidePct: number };
  worst: { axis: 'LR' | 'TB'; ratio: string; worstSidePct: number };
  gradeCap: GradeCap;
  debug: {
    rectifiedSize: { w: number; h: number };
    border: CenteringAxis;
    cardRect: { x: number; y: number; w: number; h: number };
    innerRect: { x: number; y: number; w: number; h: number };
  };
};

export type FlawItem = {
  category:
    | 'Scratch'
    | 'Scuffing'
    | 'Edgewear'
    | 'Indentation'
    | 'Grime'
    | 'Bend'
    | 'Surface Wear'
    | 'Fault'
    | 'Defect'
    | 'Damage'
    | 'Corner Rounding';
  severity: Exclude<Severity, 'NONE'>;
  points: number;
  metric: string;
  debug?: Record<string, unknown>;
};

export type FlawResult = {
  totalPoints: number;
  condition: string;
  gradeCap: GradeCap;
  items: FlawItem[];
};

export type GradeResult = {
  centering?: CenteringResult;
  flaws?: FlawResult;
  final: {
    unscorable: boolean;
    unscorableReasons?: UnscorableReason[];
    gradeLabel: string;
    psaNumeric: number;
    confidence: number; // 0..1
  };
  debug?: Record<string, unknown>;
};

// =========================
// Tunable constants
// =========================
export const TUNING = {
  // Downscale large photos before processing to keep the UI responsive.
  maxInputLongEdgePx: 1800,

  // Rectified output size (px). Keep aspect ratio close to 6.4 x 8.9.
  rectifiedWidthPx: 640,
  rectifiedHeightPx: 890,

  // Card detection
  minCardAreaFrac: 0.18, // fraction of image area
  canny1: 40,
  canny2: 120,
  approxPolyEpsFrac: 0.02,
  maxSkewAngleDeg: 25,

  // Quality gates
  blurVarianceThreshold: 90, // Laplacian variance
  glareSaturationThreshold: 245,
  glareMaxFrac: 0.08,

  // Border detection (inner content extraction)
  borderSearchInsetFrac: 0.03, // ignore extreme outer pixels during search
  edgeEnergySmoothing: 9,
  innerEdgeMinProminence: 0.18,

  // Metric conversion
  cardWidthCm: 6.4,
  cardHeightCm: 8.9,

  // Scratch detection
  scratchMinLenCmSlight: 2,
  scratchMinLenCmMinor: 4,
  scratchMinLenCmModerate: 4.0001, // > 4 is moderate; using epsilon

  // Scuffing area thresholds (cm^2)
  scuffSlightCm2: 2,
  scuffMinorCm2: 27.72,
  scuffModerateCm2: 55.44,
  scuffMajorCm2: 110.88,

  // Edgewear (sum length in cm)
  edgewearSlightCm: 2,
  edgewearMinorCm: 8,
  edgewearModerateCm: 16,

  // Indentation thresholds: using area in mm^2 from table
  indentationSlightMm2: 4,
  indentationModerateMm2: 25,

  // Grime thresholds: 2.5mm^2 slight, then cm^2
  grimeSlightMm2: 2.5,
  grimeMinorCm2: 13.75,
  grimeModerateCm2: 27.5,

  // Bend/crease length thresholds (cm)
  bendMinorCm: 1,
  bendModerateCm: 2,
  bendMajorCm: 2.0001,

  // Surface wear & fault thresholds (cm^2)
  surfaceWearSlightCm2: 0.25,
  surfaceWearMinorCm2: 1,
  surfaceWearModerateCm2: 4,
  surfaceWearMajorCm2: 16,

  // Defect thresholds (cm^2)
  defectSlightCm2: 0.25,
  defectMinorCm2: 0.5,
  defectModerateCm2: 1,

  // Corner rounding heuristic thresholds (radius in px on rectified image)
  cornerRadiusSlightPx: 5,
  cornerRadiusMinorPx: 10,
  cornerRadiusModeratePx: 18,
  cornerRadiusMajorPx: 28
};

let cvPromise: Promise<any> | null = null;
async function getCV(): Promise<any> {
  if (!cvPromise) {
    cvPromise = import('@techstark/opencv-js')
      .then((mod: any) => Promise.resolve(mod.default ?? mod))
      .catch((error) => {
        cvPromise = null;
        throw error;
      });
  }
  return cvPromise;
}

const PERSPECTIVE_NORMALIZATION_TIMEOUT_MS = 5000;
let perspectiveNormalizationDisabled = false;
const ENABLE_PERSPECTIVE_NORMALIZATION = false;
const CROPSCALE_PADDING_FRAC = 0;

// =========================
// Public API
// =========================
export async function gradeCardFront(file: File): Promise<{ result: GradeResult; overlayPNG: string; rectifiedPNG: string }> {
  const graded = await analyzeCardFrontCanvasFallback(file, 'Defaulted to canvas grading pipeline', 'grade');
  return ensureCanvasGradeArtifacts(graded);
}

export async function prepareCardFrontCanvasOnly(file: File): Promise<{ result: GradeResult }> {
  const prepared = await analyzeCardFrontCanvasFallback(file, 'Prepared manual measurement guides', 'prepare');
  return { result: prepared.result };
}

export async function gradeCardFrontCanvasOnly(file: File): Promise<{ result: GradeResult; overlayPNG: string; rectifiedPNG: string }> {
  const graded = await analyzeCardFrontCanvasFallback(file, 'Forced canvas fallback', 'grade');
  return ensureCanvasGradeArtifacts(graded);
}

async function gradeCardFrontOpenCV(file: File): Promise<{ result: GradeResult; overlayPNG: string; rectifiedPNG: string }> {
  const cv = await getCV();
  const img = await fileToMat(cv, file);

  // Quality gates on original (before rectification)
  const reasons: UnscorableReason[] = [];
  const blurVar = laplacianVariance(cv, img);
  if (blurVar < TUNING.blurVarianceThreshold) {
    reasons.push({ code: 'BLURRY', message: `Image is blurry (Laplacian variance ${blurVar.toFixed(1)} < ${TUNING.blurVarianceThreshold}).` });
  }
  const glare = estimateGlare(cv, img);
  if (glare.frac > TUNING.glareMaxFrac) {
    reasons.push({ code: 'GLARE', message: `Glare detected (bright-saturated pixels ${(glare.frac * 100).toFixed(1)}% > ${(TUNING.glareMaxFrac * 100).toFixed(1)}%).` });
  }

  // Detect card quadrilateral
  const quad = detectCardQuadrilateral(cv, img);
  if (!quad) {
    const result: GradeResult = {
      final: {
        unscorable: true,
        unscorableReasons: [{ code: 'CARD_NOT_FOUND', message: 'Could not find a 4-corner card contour.' }],
        gradeLabel: 'UNSCORABLE',
        psaNumeric: 0,
        confidence: 0.1
      }
    };
    // Minimal overlay = show original
    const rectifiedPNG = await matToDataUrl(cv, img);
    const overlayPNG = rectifiedPNG;
    img.delete();
    return { result, overlayPNG, rectifiedPNG };
  }

  // Rectify
  const { rectified, skewAngleDeg } = rectifyCard(cv, img, quad);
  if (Math.abs(skewAngleDeg) > TUNING.maxSkewAngleDeg) {
    reasons.push({ code: 'EXTREME_SKEW', message: `Perspective skew too extreme (≈${skewAngleDeg.toFixed(1)}°).` });
  }

  // Compute centering (front only)
  const centering = computeCentering(cv, rectified);
  if (!centering) {
    reasons.push({ code: 'BORDER_NOT_DETECTABLE', message: 'Could not reliably detect the inner content boundary to measure borders.' });
  }

  // Flaw detection on rectified
  const flawRes = detectFlaws(cv, rectified);

  // Combine caps
  const centeringCap = centering?.gradeCap ?? { gradeLabel: 'PR', psaNumeric: 1 };
  const flawCap = flawRes.gradeCap;
  const finalCap = finalGradeFromCaps(centeringCap, flawCap);

  const unscorable = reasons.length > 0 || !centering;
  const confidence = computeConfidence({ blurVar, glareFrac: glare.frac, skewAngleDeg, centeringOk: !!centering, reasonsCount: reasons.length });

  const result: GradeResult = {
    centering: centering ?? undefined,
    flaws: flawRes,
    final: {
      unscorable,
      unscorableReasons: unscorable ? reasons : undefined,
      gradeLabel: unscorable ? 'UNSCORABLE' : finalCap.gradeLabel,
      psaNumeric: unscorable ? 0 : finalCap.psaNumeric,
      confidence
    },
    debug: {
      blurVar,
      glare,
      skewAngleDeg,
      quad
    }
  };

  // Overlays
  const overlay = drawOverlay(cv, rectified, centering, flawRes);

  const rectifiedPNG = await matToDataUrl(cv, rectified);
  const overlayPNG = await matToDataUrl(cv, overlay);

  img.delete();
  rectified.delete();
  overlay.delete();

  return { result, overlayPNG, rectifiedPNG };
}

async function analyzeCardFrontCanvasFallback(
  file: File,
  cause: unknown,
  mode: 'prepare' | 'grade'
): Promise<{ result: GradeResult; overlayPNG?: string; rectifiedPNG?: string }> {
  const bmp = await createImageBitmap(file);
  const longEdge = Math.max(bmp.width, bmp.height);
  const scale = longEdge > TUNING.maxInputLongEdgePx ? TUNING.maxInputLongEdgePx / longEdge : 1;
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));

  const baseCanvas = createProcessingCanvas(width, height);
  const baseCtx = baseCanvas.getContext('2d');
  if (!baseCtx) throw new Error('Canvas 2D not available');

  baseCtx.drawImage(bmp, 0, 0, width, height);
  if ('close' in bmp) bmp.close();

  const sourceImageData = baseCtx.getImageData(0, 0, width, height);
  const sourcePx = sourceImageData.data;

  const borderColor = estimateBorderColor(sourcePx, width, height);
  const colorBounds = estimateContentBounds(sourcePx, width, height, borderColor);
  const profileBounds = detectOuterCardBounds(sourcePx, width, height);
  const cardBounds = chooseBestCardBounds(colorBounds, profileBounds, width, height);
  const sourceCardBounds = cardBounds ?? { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  const paddedSourceCardBounds = expandBounds(sourceCardBounds, width, height, CROPSCALE_PADDING_FRAC);
  const aspectAlignedSourceCardBounds = fitBoundsToAspect(
    paddedSourceCardBounds,
    width,
    height,
    TUNING.cardWidthCm / TUNING.cardHeightCm
  );

  const normalizedWidth = TUNING.rectifiedWidthPx;
  const normalizedHeight = TUNING.rectifiedHeightPx;
  const normalizedCanvas = createProcessingCanvas(normalizedWidth, normalizedHeight);
  const normalizedCtx = normalizedCanvas.getContext('2d');
  if (!normalizedCtx) throw new Error('Canvas 2D not available');

  let normalizationMethod: 'opencv_perspective' | 'crop_scale' = 'crop_scale';
  let perspectiveQuad: Point[] | null = null;
  let selectedSourceCardBounds: ContentBounds = aspectAlignedSourceCardBounds;
  let perspectiveError: string | null = null;

  if (ENABLE_PERSPECTIVE_NORMALIZATION && !perspectiveNormalizationDisabled) {
    try {
      const perspectiveNormalized = await withTimeout(
        tryPerspectiveNormalizeWithOpenCV(sourceImageData),
        PERSPECTIVE_NORMALIZATION_TIMEOUT_MS,
        'Perspective normalization timed out.'
      );
      if (perspectiveNormalized) {
        normalizationMethod = 'opencv_perspective';
        perspectiveQuad = perspectiveNormalized.quad;
        selectedSourceCardBounds = perspectiveNormalized.sourceCardBounds;
        normalizedCtx.putImageData(perspectiveNormalized.imageData, 0, 0);
      }
    } catch (error) {
      perspectiveError = error instanceof Error ? error.message : String(error);
      if (perspectiveError !== 'Perspective normalization timed out.') {
        perspectiveNormalizationDisabled = true;
      }
    }
  }

  if (normalizationMethod !== 'opencv_perspective') {
    const sourceCardWidth = Math.max(1, aspectAlignedSourceCardBounds.maxX - aspectAlignedSourceCardBounds.minX + 1);
    const sourceCardHeight = Math.max(1, aspectAlignedSourceCardBounds.maxY - aspectAlignedSourceCardBounds.minY + 1);
    normalizedCtx.drawImage(
      baseCanvas as CanvasImageSource,
      aspectAlignedSourceCardBounds.minX,
      aspectAlignedSourceCardBounds.minY,
      sourceCardWidth,
      sourceCardHeight,
      0,
      0,
      normalizedWidth,
      normalizedHeight
    );
  }

  const normalizedImageData = normalizedCtx.getImageData(0, 0, normalizedWidth, normalizedHeight);
  const normalizedPx = normalizedImageData.data;
  const normalizedCardBounds: ContentBounds = normalizationMethod === 'opencv_perspective'
    ? {
      minX: 0,
      minY: 0,
      maxX: normalizedWidth - 1,
      maxY: normalizedHeight - 1
    }
    : mapBoundsToNormalizedSpace(
      sourceCardBounds,
      aspectAlignedSourceCardBounds,
      normalizedWidth,
      normalizedHeight
    );
  const innerBounds = detectInnerContentBounds(normalizedPx, normalizedWidth, normalizedHeight, normalizedCardBounds);
  const centering = buildCanvasCentering(normalizedCardBounds, innerBounds, normalizedWidth, normalizedHeight);

  const baseDebug = {
    fallback: true,
    fallbackReason: cause instanceof Error ? cause.message : String(cause ?? 'OpenCV unavailable'),
    previewOnly: mode === 'prepare',
    normalizationMethod,
    perspectiveNormalizationDisabled,
    perspectiveError,
    sourceSize: { w: width, h: height },
    normalizedSize: { w: normalizedWidth, h: normalizedHeight },
    colorBounds,
    profileBounds,
    cardBounds: sourceCardBounds,
    cropBounds: selectedSourceCardBounds,
    perspectiveQuad,
    normalizedCardBounds,
    innerBounds,
    psaStyle: {
      centering: {
        lr: centering.lr.ratio,
        tb: centering.tb.ratio,
        centeringCap: centering.gradeCap
      }
    }
  };

  if (mode === 'prepare') {
    const result: GradeResult = {
      centering,
      final: {
        unscorable: false,
        gradeLabel: centering.gradeCap.gradeLabel,
        psaNumeric: centering.gradeCap.psaNumeric,
        confidence: 0
      },
      debug: baseDebug
    };
    return { result };
  }

  const flaws = detectCanvasPsaStyleFlaws(normalizedPx, normalizedWidth, normalizedHeight, normalizedCardBounds);
  const finalCap = finalGradeFromCaps(centering.gradeCap, flaws.gradeCap);
  const confidence = computeCanvasConfidence(
    flaws.debug.blurVariance,
    flaws.debug.meanLuma,
    flaws.debug.stdLuma,
    !!innerBounds
  );

  const result: GradeResult = {
    centering,
    flaws: {
      totalPoints: flaws.totalPoints,
      condition: flaws.condition,
      gradeCap: flaws.gradeCap,
      items: flaws.items
    },
    final: {
      unscorable: false,
      gradeLabel: finalCap.gradeLabel,
      psaNumeric: finalCap.psaNumeric,
      confidence
    },
    debug: {
      ...baseDebug,
      psaStyle: {
        ...baseDebug.psaStyle,
        flawItems: flaws.items.map((item) => ({
          category: item.category,
          severity: item.severity,
          points: item.points,
          metric: item.metric
        })),
        flawDebug: flaws.debug
      }
    }
  };

  const overlayCanvas = createProcessingCanvas(normalizedWidth, normalizedHeight);
  const overlayCtx = overlayCanvas.getContext('2d');
  if (!overlayCtx) throw new Error('Canvas 2D not available');

  renderMeasurementOverlay(
    overlayCtx,
    normalizedWidth,
    normalizedHeight,
    normalizedCardBounds,
    innerBounds,
    centering,
    result.final.gradeLabel,
    flaws.totalPoints,
    normalizationMethod
  );

  const rectifiedPNG = await Promise.resolve(canvasToPngDataUrl(normalizedCanvas));
  const overlayPNG = await Promise.resolve(canvasToPngDataUrl(overlayCanvas));
  return { result, overlayPNG, rectifiedPNG };
}

function ensureCanvasGradeArtifacts(analysis: { result: GradeResult; overlayPNG?: string; rectifiedPNG?: string }): {
  result: GradeResult;
  overlayPNG: string;
  rectifiedPNG: string;
} {
  if (!analysis.overlayPNG || !analysis.rectifiedPNG) {
    throw new Error('Canvas grading did not return image artifacts.');
  }
  return {
    result: analysis.result,
    overlayPNG: analysis.overlayPNG,
    rectifiedPNG: analysis.rectifiedPNG
  };
}

type ContentBounds = { minX: number; minY: number; maxX: number; maxY: number; };

async function tryPerspectiveNormalizeWithOpenCV(
  sourceImageData: ImageData
): Promise<{ imageData: ImageData; quad: Point[]; sourceCardBounds: ContentBounds } | null> {
  try {
    const cv = await getCV();
    const src = cv.matFromImageData(sourceImageData);
    let rectified: any | null = null;
    try {
      const quad = detectCardQuadrilateral(cv, src);
      if (!quad) return null;

      const result = rectifyCard(cv, src, quad);
      rectified = result.rectified;
      const imageData = matToImageDataRGBA(cv, rectified);
      const sourceCardBounds = quadToBounds(quad, sourceImageData.width, sourceImageData.height);
      return { imageData, quad, sourceCardBounds };
    } finally {
      if (rectified) rectified.delete();
      src.delete();
    }
  } catch {
    return null;
  }
}

function expandBounds(bounds: ContentBounds, width: number, height: number, frac: number): ContentBounds {
  if (frac <= 0) return bounds;
  const w = Math.max(1, bounds.maxX - bounds.minX + 1);
  const h = Math.max(1, bounds.maxY - bounds.minY + 1);
  const padX = Math.max(2, Math.round(w * frac));
  const padY = Math.max(2, Math.round(h * frac));
  const minX = clampInt(bounds.minX - padX, 0, width - 1);
  const minY = clampInt(bounds.minY - padY, 0, height - 1);
  const maxX = clampInt(bounds.maxX + padX, minX, width - 1);
  const maxY = clampInt(bounds.maxY + padY, minY, height - 1);
  return { minX, minY, maxX, maxY };
}

function mapBoundsToNormalizedSpace(
  innerBounds: ContentBounds,
  outerBounds: ContentBounds,
  normalizedWidth: number,
  normalizedHeight: number
): ContentBounds {
  const outerWidth = Math.max(1, outerBounds.maxX - outerBounds.minX + 1);
  const outerHeight = Math.max(1, outerBounds.maxY - outerBounds.minY + 1);
  const minX = clampInt(
    ((innerBounds.minX - outerBounds.minX) / outerWidth) * normalizedWidth,
    0,
    Math.max(0, normalizedWidth - 2)
  );
  const minY = clampInt(
    ((innerBounds.minY - outerBounds.minY) / outerHeight) * normalizedHeight,
    0,
    Math.max(0, normalizedHeight - 2)
  );
  const maxX = clampInt(
    (((innerBounds.maxX - outerBounds.minX) + 1) / outerWidth) * normalizedWidth - 1,
    minX + 1,
    Math.max(1, normalizedWidth - 1)
  );
  const maxY = clampInt(
    (((innerBounds.maxY - outerBounds.minY) + 1) / outerHeight) * normalizedHeight - 1,
    minY + 1,
    Math.max(1, normalizedHeight - 1)
  );
  return { minX, minY, maxX, maxY };
}

type OverlayContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function renderMeasurementOverlay(
  ctx: OverlayContext2D,
  width: number,
  height: number,
  cardBounds: ContentBounds,
  innerBounds: ContentBounds | null,
  centering: CenteringResult,
  gradeLabel: string,
  flawPoints: number,
  normalizationMethod: 'opencv_perspective' | 'crop_scale'
): void {
  ctx.clearRect(0, 0, width, height);

  drawOutsideCardShade(ctx, width, height, cardBounds);

  if (innerBounds) {
    drawMeasurementBand(ctx, cardBounds.minX, cardBounds.minY, innerBounds.minX - cardBounds.minX, cardBounds.maxY - cardBounds.minY + 1, 'rgba(153, 246, 96, 0.10)');
    drawMeasurementBand(ctx, innerBounds.maxX + 1, cardBounds.minY, cardBounds.maxX - innerBounds.maxX, cardBounds.maxY - cardBounds.minY + 1, 'rgba(103, 232, 249, 0.10)');
    drawMeasurementBand(ctx, cardBounds.minX, cardBounds.minY, cardBounds.maxX - cardBounds.minX + 1, innerBounds.minY - cardBounds.minY, 'rgba(244, 114, 182, 0.10)');
    drawMeasurementBand(ctx, cardBounds.minX, innerBounds.maxY + 1, cardBounds.maxX - cardBounds.minX + 1, cardBounds.maxY - innerBounds.maxY, 'rgba(251, 191, 36, 0.10)');
  }

  drawGuidePair(ctx, width, height, {
    axis: 'x',
    outerPos: cardBounds.minX,
    innerPos: innerBounds?.minX ?? cardBounds.minX,
    outerColor: 'rgba(153, 246, 96, 0.90)',
    innerColor: 'rgba(190, 242, 100, 1)',
    handleOffset: -28
  });
  drawGuidePair(ctx, width, height, {
    axis: 'x',
    outerPos: cardBounds.maxX,
    innerPos: innerBounds?.maxX ?? cardBounds.maxX,
    outerColor: 'rgba(103, 232, 249, 0.90)',
    innerColor: 'rgba(34, 211, 238, 1)',
    handleOffset: 28
  });
  drawGuidePair(ctx, width, height, {
    axis: 'y',
    outerPos: cardBounds.minY,
    innerPos: innerBounds?.minY ?? cardBounds.minY,
    outerColor: 'rgba(244, 114, 182, 0.90)',
    innerColor: 'rgba(236, 72, 153, 1)',
    handleOffset: -28
  });
  drawGuidePair(ctx, width, height, {
    axis: 'y',
    outerPos: cardBounds.maxY,
    innerPos: innerBounds?.maxY ?? cardBounds.maxY,
    outerColor: 'rgba(251, 191, 36, 0.90)',
    innerColor: 'rgba(249, 115, 22, 1)',
    handleOffset: 28
  });

  drawCenterCrosshair(ctx, cardBounds);
  drawCenteringSummary(ctx, cardBounds, centering, gradeLabel, flawPoints, normalizationMethod);
}

function drawOutsideCardShade(ctx: OverlayContext2D, width: number, height: number, cardBounds: ContentBounds): void {
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
  ctx.fillRect(0, 0, width, Math.max(0, cardBounds.minY));
  ctx.fillRect(0, cardBounds.maxY + 1, width, Math.max(0, height - cardBounds.maxY - 1));
  ctx.fillRect(0, cardBounds.minY, Math.max(0, cardBounds.minX), Math.max(0, cardBounds.maxY - cardBounds.minY + 1));
  ctx.fillRect(cardBounds.maxX + 1, cardBounds.minY, Math.max(0, width - cardBounds.maxX - 1), Math.max(0, cardBounds.maxY - cardBounds.minY + 1));
  ctx.restore();
}

function drawMeasurementBand(ctx: OverlayContext2D, x: number, y: number, w: number, h: number, fill: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function drawGuidePair(
  ctx: OverlayContext2D,
  width: number,
  height: number,
  args: {
    axis: 'x' | 'y';
    outerPos: number;
    innerPos: number;
    outerColor: string;
    innerColor: string;
    handleOffset: number;
  }
): void {
  drawGuideLine(ctx, width, height, args.axis, args.outerPos, args.outerColor, [3, 3], 1.5);
  drawGuideLine(ctx, width, height, args.axis, args.innerPos, args.innerColor, [6, 4], 2);
  drawGuideHandle(ctx, width, height, args.axis, args.outerPos, args.outerColor, args.handleOffset);
  drawGuideHandle(ctx, width, height, args.axis, args.innerPos, args.innerColor, -args.handleOffset);
}

function drawGuideLine(
  ctx: OverlayContext2D,
  width: number,
  height: number,
  axis: 'x' | 'y',
  pos: number,
  color: string,
  dash: number[],
  lineWidth: number
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.beginPath();
  if (axis === 'x') {
    const x = clampInt(pos, 0, Math.max(0, width - 1)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  } else {
    const y = clampInt(pos, 0, Math.max(0, height - 1)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawGuideHandle(
  ctx: OverlayContext2D,
  width: number,
  height: number,
  axis: 'x' | 'y',
  pos: number,
  accent: string,
  offset: number
): void {
  const handleW = axis === 'x' ? 18 : 30;
  const handleH = axis === 'x' ? 30 : 18;
  const centerX = axis === 'x'
    ? clampInt(pos, 10, Math.max(10, width - 10))
    : clampInt(Math.floor(width / 2) + offset, 20, Math.max(20, width - 20));
  const centerY = axis === 'x'
    ? clampInt(Math.floor(height / 2) + offset, 20, Math.max(20, height - 20))
    : clampInt(pos, 10, Math.max(10, height - 10));
  const x = clampInt(centerX - Math.floor(handleW / 2), 2, Math.max(2, width - handleW - 2));
  const y = clampInt(centerY - Math.floor(handleH / 2), 2, Math.max(2, height - handleH - 2));

  ctx.save();
  ctx.fillStyle = 'rgba(39, 39, 42, 0.85)';
  ctx.fillRect(x, y, handleW, handleH);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, handleW - 1, handleH - 1);
  ctx.fillStyle = 'rgba(244, 244, 245, 0.88)';

  if (axis === 'x') {
    const guideX = x + Math.floor(handleW / 2) + 0.5;
    ctx.fillRect(guideX - 0.5, y + 5, 1, handleH - 10);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 2; col++) {
        ctx.fillRect(x + 12 + (col * 3), y + 7 + (row * 4), 1.6, 1.6);
      }
    }
  } else {
    const guideY = y + Math.floor(handleH / 2) + 0.5;
    ctx.fillRect(x + 6, guideY - 0.5, handleW - 12, 1);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        ctx.fillRect(x + 8 + (col * 4), y + 3 + (row * 5), 1.6, 1.6);
      }
    }
  }
  ctx.restore();
}

function drawCenterCrosshair(ctx: OverlayContext2D, cardBounds: ContentBounds): void {
  const midX = Math.floor((cardBounds.minX + cardBounds.maxX) / 2);
  const midY = Math.floor((cardBounds.minY + cardBounds.maxY) / 2);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 6]);
  ctx.beginPath();
  ctx.moveTo(midX + 0.5, cardBounds.minY);
  ctx.lineTo(midX + 0.5, cardBounds.maxY);
  ctx.moveTo(cardBounds.minX, midY + 0.5);
  ctx.lineTo(cardBounds.maxX, midY + 0.5);
  ctx.stroke();
  ctx.restore();
}

function drawCenteringSummary(
  ctx: OverlayContext2D,
  cardBounds: ContentBounds,
  centering: CenteringResult,
  gradeLabel: string,
  flawPoints: number,
  normalizationMethod: 'opencv_perspective' | 'crop_scale'
): void {
  const cardWidthPx = Math.max(1, cardBounds.maxX - cardBounds.minX + 1);
  const cardHeightPx = Math.max(1, cardBounds.maxY - cardBounds.minY + 1);
  const leftMm = pxToMillimeters(centering.debug.border.leftPx, cardWidthPx, TUNING.cardWidthCm * 10);
  const rightMm = pxToMillimeters(centering.debug.border.rightPx, cardWidthPx, TUNING.cardWidthCm * 10);
  const topMm = pxToMillimeters(centering.debug.border.topPx, cardHeightPx, TUNING.cardHeightCm * 10);
  const bottomMm = pxToMillimeters(centering.debug.border.bottomPx, cardHeightPx, TUNING.cardHeightCm * 10);

  const boxX = clampInt(cardBounds.minX + 12, 8, Math.max(8, cardBounds.maxX - 280));
  const boxY = clampInt(cardBounds.minY + 12, 8, Math.max(8, cardBounds.maxY - 82));
  const boxW = Math.min(272, Math.max(180, cardBounds.maxX - cardBounds.minX - 24));
  const boxH = 76;

  ctx.save();
  ctx.fillStyle = 'rgba(17, 24, 39, 0.72)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

  ctx.font = '600 12px sans-serif';
  ctx.fillStyle = '#f4f4f5';
  ctx.fillText(`Centering ${centering.lr.ratio} / ${centering.tb.ratio}`, boxX + 10, boxY + 18);

  ctx.font = '12px sans-serif';
  ctx.fillStyle = 'rgba(244, 244, 245, 0.92)';
  ctx.fillText(
    `L/R ${leftMm.toFixed(1)}mm / ${rightMm.toFixed(1)}mm  (${Math.round(centering.debug.border.leftPct)}% / ${Math.round(centering.debug.border.rightPct)}%)`,
    boxX + 10,
    boxY + 38
  );
  ctx.fillText(
    `T/B ${topMm.toFixed(1)}mm / ${bottomMm.toFixed(1)}mm  (${Math.round(centering.debug.border.topPct)}% / ${Math.round(centering.debug.border.bottomPct)}%)`,
    boxX + 10,
    boxY + 56
  );

  ctx.fillStyle = 'rgba(212, 212, 216, 0.85)';
  ctx.fillText(`Grade ${gradeLabel}  |  Flaw pts ${flawPoints}  |  ${normalizationMethod}`, boxX + 10, boxY + 72);
  ctx.restore();
}

function pxToMillimeters(px: number, axisPx: number, physicalMm: number): number {
  return (px / Math.max(1, axisPx)) * physicalMm;
}

function fitBoundsToAspect(
  bounds: ContentBounds,
  width: number,
  height: number,
  targetAspect: number
): ContentBounds {
  let minX = clampInt(bounds.minX, 0, Math.max(0, width - 1));
  let minY = clampInt(bounds.minY, 0, Math.max(0, height - 1));
  let maxX = clampInt(bounds.maxX, minX, Math.max(0, width - 1));
  let maxY = clampInt(bounds.maxY, minY, Math.max(0, height - 1));

  const currentWidth = Math.max(1, maxX - minX + 1);
  const currentHeight = Math.max(1, maxY - minY + 1);
  const currentAspect = currentWidth / currentHeight;

  if (!Number.isFinite(targetAspect) || targetAspect <= 0) {
    return { minX, minY, maxX, maxY };
  }

  if (currentAspect < targetAspect) {
    const targetWidth = Math.min(width, Math.max(currentWidth, Math.round(currentHeight * targetAspect)));
    const expansion = distributeExpansion(targetWidth - currentWidth, minX, (width - 1) - maxX);
    minX -= expansion.before;
    maxX += expansion.after;
  } else if (currentAspect > targetAspect) {
    const targetHeight = Math.min(height, Math.max(currentHeight, Math.round(currentWidth / targetAspect)));
    const expansion = distributeExpansion(targetHeight - currentHeight, minY, (height - 1) - maxY);
    minY -= expansion.before;
    maxY += expansion.after;
  }

  return {
    minX: clampInt(minX, 0, Math.max(0, width - 1)),
    minY: clampInt(minY, 0, Math.max(0, height - 1)),
    maxX: clampInt(maxX, minX, Math.max(0, width - 1)),
    maxY: clampInt(maxY, minY, Math.max(0, height - 1))
  };
}

function distributeExpansion(extra: number, beforeCapacity: number, afterCapacity: number): { before: number; after: number } {
  if (extra <= 0) return { before: 0, after: 0 };

  let before = Math.min(Math.floor(extra / 2), Math.max(0, beforeCapacity));
  let after = Math.min(extra - before, Math.max(0, afterCapacity));
  let remaining = extra - before - after;

  if (remaining > 0) {
    const moreBefore = Math.min(remaining, Math.max(0, beforeCapacity) - before);
    before += moreBefore;
    remaining -= moreBefore;
  }

  if (remaining > 0) {
    const moreAfter = Math.min(remaining, Math.max(0, afterCapacity) - after);
    after += moreAfter;
  }

  return { before, after };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]) as T;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function quadToBounds(quad: Point[], width: number, height: number): ContentBounds {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const minX = clampInt(Math.min(...xs), 0, Math.max(0, width - 1));
  const minY = clampInt(Math.min(...ys), 0, Math.max(0, height - 1));
  const maxX = clampInt(Math.max(...xs), minX, Math.max(0, width - 1));
  const maxY = clampInt(Math.max(...ys), minY, Math.max(0, height - 1));
  return { minX, minY, maxX, maxY };
}

function matToImageDataRGBA(cv: any, mat: any): ImageData {
  const out = new cv.Mat();
  try {
    switch (mat.type()) {
      case cv.CV_8UC4:
        mat.copyTo(out);
        break;
      case cv.CV_8UC3:
        cv.cvtColor(mat, out, cv.COLOR_RGB2RGBA);
        break;
      case cv.CV_8UC1:
        cv.cvtColor(mat, out, cv.COLOR_GRAY2RGBA);
        break;
      default:
        throw new Error('Unsupported Mat channel count for ImageData conversion.');
    }

    const copy = new Uint8ClampedArray(out.data.length);
    copy.set(out.data);
    return new ImageData(copy, out.cols, out.rows);
  } finally {
    out.delete();
  }
}

function estimateBorderColor(px: Uint8ClampedArray, width: number, height: number): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const step = Math.max(2, Math.floor(Math.min(width, height) / 240));

  for (let x = 0; x < width; x += step) {
    const top = (x * 4);
    const bottom = ((height - 1) * width + x) * 4;
    r += px[top];
    g += px[top + 1];
    b += px[top + 2];
    r += px[bottom];
    g += px[bottom + 1];
    b += px[bottom + 2];
    count += 2;
  }
  for (let y = 0; y < height; y += step) {
    const left = (y * width) * 4;
    const right = (y * width + (width - 1)) * 4;
    r += px[left];
    g += px[left + 1];
    b += px[left + 2];
    r += px[right];
    g += px[right + 1];
    b += px[right + 2];
    count += 2;
  }

  if (count === 0) return { r: 127, g: 127, b: 127 };
  return { r: r / count, g: g / count, b: b / count };
}

function estimateContentBounds(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  border: { r: number; g: number; b: number }
): ContentBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 500));
  const thresholdSq = 24 * 24;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const dr = px[i] - border.r;
      const dg = px[i + 1] - border.g;
      const db = px[i + 2] - border.b;
      const distSq = dr * dr + dg * dg + db * db;
      if (distSq > thresholdSq) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;
  return {
    minX: Math.max(0, minX - step),
    minY: Math.max(0, minY - step),
    maxX: Math.min(width - 1, maxX + step),
    maxY: Math.min(height - 1, maxY + step)
  };
}

function detectOuterCardBounds(
  px: Uint8ClampedArray,
  width: number,
  height: number
): ContentBounds | null {
  if (width < 64 || height < 64) return null;

  const step = Math.max(1, Math.floor(Math.min(width, height) / 480));
  const colGrad = new Array<number>(width).fill(0);
  const rowGrad = new Array<number>(height).fill(0);

  const lumaAt = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  };

  for (let x = 1; x < width; x += step) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y < height; y += step) {
      sum += Math.abs(lumaAt(x, y) - lumaAt(x - 1, y));
      count++;
    }
    colGrad[x] = count > 0 ? sum / count : 0;
  }

  for (let y = 1; y < height; y += step) {
    let sum = 0;
    let count = 0;
    for (let x = 0; x < width; x += step) {
      sum += Math.abs(lumaAt(x, y) - lumaAt(x, y - 1));
      count++;
    }
    rowGrad[y] = count > 0 ? sum / count : 0;
  }

  const smoothCols = smoothProfile(colGrad, Math.max(4, Math.floor(Math.min(width, height) / 220)));
  const smoothRows = smoothProfile(rowGrad, Math.max(4, Math.floor(Math.min(width, height) / 220)));

  const left = findProminentProfileEdge(smoothCols, 1, Math.floor(width * 0.45), 'left');
  const right = findProminentProfileEdge(smoothCols, Math.ceil(width * 0.55), width - 2, 'right');
  const top = findProminentProfileEdge(smoothRows, 1, Math.floor(height * 0.45), 'left');
  const bottom = findProminentProfileEdge(smoothRows, Math.ceil(height * 0.55), height - 2, 'right');

  if (left == null || right == null || top == null || bottom == null) return null;
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w < width * 0.35 || h < height * 0.35) return null;

  return { minX: left, minY: top, maxX: right, maxY: bottom };
}

function chooseBestCardBounds(
  colorBounds: ContentBounds | null,
  profileBounds: ContentBounds | null,
  width: number,
  height: number
): ContentBounds | null {
  const candidates = [colorBounds, profileBounds].filter((x): x is ContentBounds => !!x);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (colorBounds && profileBounds) {
    const containmentTolerance = Math.max(4, Math.round(Math.min(width, height) * 0.01));
    const colorContainsProfile = boundsContain(colorBounds, profileBounds, containmentTolerance);
    const profileContainsColor = boundsContain(profileBounds, colorBounds, containmentTolerance);
    const colorScore = scoreCardBounds(colorBounds, width, height);
    const profileScore = scoreCardBounds(profileBounds, width, height);

    // When the profile detector finds a strong interior print window inside a plausible
    // full-card box, prefer the outer color-based candidate to avoid zooming into the art.
    if (colorContainsProfile && isFinite(colorScore)) {
      return colorBounds;
    }
    if (profileContainsColor && isFinite(profileScore)) {
      return profileBounds;
    }

    const merged = mergeBounds(colorBounds, profileBounds, width, height);
    const mergedScore = scoreCardBounds(merged, width, height);
    if (overlapFraction(colorBounds, profileBounds) >= 0.72 && isFinite(mergedScore) && mergedScore >= Math.max(colorScore, profileScore) - 0.1) {
      return merged;
    }
  }

  const a = candidates[0];
  const b = candidates[1];
  const sa = scoreCardBounds(a, width, height);
  const sb = scoreCardBounds(b, width, height);
  if (!isFinite(sa) && !isFinite(sb)) return colorBounds ?? profileBounds;
  return sa >= sb ? a : b;
}

function scoreCardBounds(bounds: ContentBounds, width: number, height: number): number {
  const w = Math.max(1, bounds.maxX - bounds.minX + 1);
  const h = Math.max(1, bounds.maxY - bounds.minY + 1);
  const areaFrac = (w * h) / Math.max(1, width * height);
  if (areaFrac < 0.2 || areaFrac > 0.99) return Number.NEGATIVE_INFINITY;

  const targetAspect = TUNING.cardWidthCm / TUNING.cardHeightCm;
  const aspect = w / h;
  const aspectScore = 1 - Math.min(1, Math.abs(Math.log(aspect / targetAspect)));
  const areaScore = 1 - Math.min(1, Math.abs(areaFrac - 0.68) / 0.68);
  const edgePenalty =
    (bounds.minX <= 0 ? 0.08 : 0) +
    (bounds.minY <= 0 ? 0.08 : 0) +
    (bounds.maxX >= width - 1 ? 0.08 : 0) +
    (bounds.maxY >= height - 1 ? 0.08 : 0);
  return (aspectScore * 0.65) + (areaScore * 0.35) - edgePenalty;
}

function boundsContain(outer: ContentBounds, inner: ContentBounds, tolerance: number): boolean {
  return (
    outer.minX <= inner.minX + tolerance &&
    outer.minY <= inner.minY + tolerance &&
    outer.maxX >= inner.maxX - tolerance &&
    outer.maxY >= inner.maxY - tolerance
  );
}

function mergeBounds(a: ContentBounds, b: ContentBounds, width: number, height: number): ContentBounds {
  return {
    minX: clampInt(Math.min(a.minX, b.minX), 0, Math.max(0, width - 1)),
    minY: clampInt(Math.min(a.minY, b.minY), 0, Math.max(0, height - 1)),
    maxX: clampInt(Math.max(a.maxX, b.maxX), 0, Math.max(0, width - 1)),
    maxY: clampInt(Math.max(a.maxY, b.maxY), 0, Math.max(0, height - 1))
  };
}

function overlapFraction(a: ContentBounds, b: ContentBounds): number {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX < minX || maxY < minY) return 0;

  const intersection = (maxX - minX + 1) * (maxY - minY + 1);
  const minArea = Math.min(
    Math.max(1, (a.maxX - a.minX + 1) * (a.maxY - a.minY + 1)),
    Math.max(1, (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1))
  );
  return intersection / minArea;
}

function detectInnerContentBounds(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  cardBounds: ContentBounds | null
): ContentBounds | null {
  const base = cardBounds ?? { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  const regionW = base.maxX - base.minX + 1;
  const regionH = base.maxY - base.minY + 1;
  if (regionW < 64 || regionH < 64) return null;

  const xStart = base.minX + Math.round(regionW * 0.12);
  const xEnd = base.maxX - Math.round(regionW * 0.12);
  const yStart = base.minY + Math.round(regionH * 0.12);
  const yEnd = base.maxY - Math.round(regionH * 0.12);
  if (xEnd - xStart < 10 || yEnd - yStart < 10) return null;

  const ySamples = samplePositions(yStart, yEnd, 19);
  const xSamples = samplePositions(xStart, xEnd, 19);

  const maxBorderX = clampInt(Math.round(regionW * 0.32), 6, Math.max(8, Math.round(regionW * 0.48)));
  const maxBorderY = clampInt(Math.round(regionH * 0.32), 6, Math.max(8, Math.round(regionH * 0.48)));
  const minInsetX = clampInt(Math.round(regionW * 0.006), 1, 4);
  const minInsetY = clampInt(Math.round(regionH * 0.006), 1, 4);

  const leftBorders = ySamples
    .map((y) => scanBorderTransition(px, width, base, y, 'left', maxBorderX, minInsetX))
    .filter((v): v is number => v != null);
  const rightBorders = ySamples
    .map((y) => scanBorderTransition(px, width, base, y, 'right', maxBorderX, minInsetX))
    .filter((v): v is number => v != null);
  const topBorders = xSamples
    .map((x) => scanBorderTransition(px, width, base, x, 'top', maxBorderY, minInsetY))
    .filter((v): v is number => v != null);
  const bottomBorders = xSamples
    .map((x) => scanBorderTransition(px, width, base, x, 'bottom', maxBorderY, minInsetY))
    .filter((v): v is number => v != null);

  const leftBorder = dominantClusterMedian(leftBorders);
  const rightBorder = dominantClusterMedian(rightBorders);
  const topBorder = dominantClusterMedian(topBorders);
  const bottomBorder = dominantClusterMedian(bottomBorders);

  if (leftBorder == null || rightBorder == null || topBorder == null || bottomBorder == null) {
    return detectInnerContentBoundsByGradientProfiles(px, width, height, base);
  }

  const minX = clampInt(base.minX + leftBorder, base.minX, base.maxX - 1);
  const maxX = clampInt(base.maxX - rightBorder, minX + 1, base.maxX);
  const minY = clampInt(base.minY + topBorder, base.minY, base.maxY - 1);
  const maxY = clampInt(base.maxY - bottomBorder, minY + 1, base.maxY);

  if (maxX - minX < regionW * 0.3 || maxY - minY < regionH * 0.3) {
    return detectInnerContentBoundsByGradientProfiles(px, width, height, base);
  }

  return { minX, minY, maxX, maxY };
}

function detectInnerContentBoundsByGradientProfiles(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  base: ContentBounds
): ContentBounds | null {
  const regionW = base.maxX - base.minX + 1;
  const regionH = base.maxY - base.minY + 1;
  const insetX = Math.max(2, Math.round(regionW * 0.02));
  const insetY = Math.max(2, Math.round(regionH * 0.02));
  const scanMinX = base.minX + insetX;
  const scanMaxX = base.maxX - insetX;
  const scanMinY = base.minY + insetY;
  const scanMaxY = base.maxY - insetY;
  if (scanMaxX - scanMinX < 24 || scanMaxY - scanMinY < 24) return null;

  const step = Math.max(1, Math.floor(Math.min(width, height) / 500));
  const colGrad = new Array<number>(width).fill(0);
  const rowGrad = new Array<number>(height).fill(0);

  const lumaAt = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  };

  for (let x = scanMinX + 1; x <= scanMaxX; x += step) {
    let sum = 0;
    let count = 0;
    for (let y = scanMinY; y <= scanMaxY; y += step) {
      sum += Math.abs(lumaAt(x, y) - lumaAt(x - 1, y));
      count++;
    }
    colGrad[x] = count > 0 ? sum / count : 0;
  }

  for (let y = scanMinY + 1; y <= scanMaxY; y += step) {
    let sum = 0;
    let count = 0;
    for (let x = scanMinX; x <= scanMaxX; x += step) {
      sum += Math.abs(lumaAt(x, y) - lumaAt(x, y - 1));
      count++;
    }
    rowGrad[y] = count > 0 ? sum / count : 0;
  }

  const smoothCols = smoothProfile(colGrad, 4);
  const smoothRows = smoothProfile(rowGrad, 4);

  const left = findProminentProfileEdge(smoothCols, scanMinX, base.minX + Math.floor(regionW * 0.42), 'left');
  const right = findProminentProfileEdge(smoothCols, base.maxX - Math.floor(regionW * 0.42), scanMaxX, 'right');
  const top = findProminentProfileEdge(smoothRows, scanMinY, base.minY + Math.floor(regionH * 0.42), 'left');
  const bottom = findProminentProfileEdge(smoothRows, base.maxY - Math.floor(regionH * 0.42), scanMaxY, 'right');

  if (left == null || right == null || top == null || bottom == null) return null;
  if (right - left < regionW * 0.3 || bottom - top < regionH * 0.3) return null;
  return { minX: left, minY: top, maxX: right, maxY: bottom };
}

function samplePositions(start: number, end: number, count: number): number[] {
  if (count <= 1 || end <= start) return [clampInt(start, start, Math.max(start, end))];
  const out: number[] = [];
  const span = end - start;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push(clampInt(start + (span * t), start, end));
  }
  return out;
}

type ScanSample = {
  distanceFromEdge: number;
  r: number;
  g: number;
  b: number;
  luma: number;
};

function scanBorderTransition(
  px: Uint8ClampedArray,
  width: number,
  bounds: ContentBounds,
  fixedCoord: number,
  side: 'left' | 'right' | 'top' | 'bottom',
  maxBorder: number,
  minInset: number
): number | null {
  const samples = collectEdgeScanSamples(px, width, bounds, fixedCoord, side, maxBorder, minInset);
  if (samples.length < 8) return null;

  const referenceCount = clampInt(Math.round(samples.length * 0.18), 4, Math.max(4, Math.min(12, samples.length - 3)));
  if (referenceCount >= samples.length - 2) return null;

  const ref = averageScanColor(samples.slice(0, referenceCount));
  const colorDelta = samples.map((sample) => averageAbsoluteColorDelta(sample, ref));
  const stepColorDelta = samples.map((sample, index) => (
    index === 0 ? 0 : averageAbsoluteColorDelta(sample, samples[index - 1])
  ));
  const stepLumaDelta = samples.map((sample, index) => (
    index === 0 ? 0 : Math.abs(sample.luma - samples[index - 1].luma)
  ));

  const baseColorNoise = averageNumber(colorDelta.slice(0, referenceCount));
  const baseStepColorNoise = averageNumber(stepColorDelta.slice(1, referenceCount));
  const baseStepLumaNoise = averageNumber(stepLumaDelta.slice(1, referenceCount));

  const colorThreshold = Math.max(12, baseColorNoise * 2.8 + 7);
  const edgeThreshold = Math.max(10, baseStepColorNoise * 2.4 + 6);
  const lumaThreshold = Math.max(10, baseStepLumaNoise * 2.4 + 6);
  const textureThreshold = Math.max(8, baseStepLumaNoise * 1.9 + 4);
  const requiredRun = clampInt(Math.round(samples.length * 0.08), 3, 6);

  let fallbackDistance: number | null = null;
  for (let start = referenceCount; start <= samples.length - requiredRun; start++) {
    let strongColorCount = 0;
    let edgeSeen = false;
    let meanColorDelta = 0;
    let meanTexture = 0;

    for (let offset = 0; offset < requiredRun; offset++) {
      const index = start + offset;
      meanColorDelta += colorDelta[index];
      meanTexture += stepLumaDelta[index];
      if (colorDelta[index] >= colorThreshold) strongColorCount++;
      if (stepColorDelta[index] >= edgeThreshold || stepLumaDelta[index] >= lumaThreshold) edgeSeen = true;
    }

    meanColorDelta /= requiredRun;
    meanTexture /= requiredRun;

    const candidateDistance = samples[start].distanceFromEdge;
    const sustainedBorderExit = strongColorCount >= Math.max(2, requiredRun - 1);
    const transitionLooksReal =
      (meanColorDelta >= colorThreshold && (edgeSeen || meanTexture >= textureThreshold)) ||
      (edgeSeen && meanColorDelta >= colorThreshold * 0.72) ||
      (meanTexture >= textureThreshold * 1.4 && meanColorDelta >= colorThreshold * 0.8);

    if (fallbackDistance == null && meanColorDelta >= colorThreshold * 1.4) {
      fallbackDistance = candidateDistance;
    }
    if (sustainedBorderExit && transitionLooksReal) {
      return candidateDistance;
    }
  }

  return fallbackDistance;
}

function dominantClusterMedian(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const windowSize = Math.max(3, Math.ceil(sorted.length * 0.6));
  if (sorted.length <= windowSize) {
    return medianOfSorted(sorted);
  }

  let bestStart = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (let start = 0; start <= sorted.length - windowSize; start++) {
    const end = start + windowSize - 1;
    const span = sorted[end] - sorted[start];
    if (span < bestSpan) {
      bestSpan = span;
      bestStart = start;
    }
  }

  const data = sorted.slice(bestStart, bestStart + windowSize);
  return medianOfSorted(data);
}

function medianOfSorted(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function collectEdgeScanSamples(
  px: Uint8ClampedArray,
  width: number,
  bounds: ContentBounds,
  fixedCoord: number,
  side: 'left' | 'right' | 'top' | 'bottom',
  maxBorder: number,
  minInset: number
): ScanSample[] {
  const horizontal = side === 'left' || side === 'right';
  const scanLength = horizontal
    ? Math.max(1, bounds.maxX - bounds.minX + 1)
    : Math.max(1, bounds.maxY - bounds.minY + 1);
  const maxDepth = Math.min(maxBorder, Math.max(0, scanLength - minInset - 1));
  if (maxDepth <= 0) return [];

  const samples: ScanSample[] = [];
  for (let offset = minInset; offset <= maxDepth; offset++) {
    const { x, y } = edgeScanPoint(bounds, fixedCoord, side, offset);
    const i = (y * width + x) * 4;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    samples.push({
      distanceFromEdge: offset,
      r,
      g,
      b,
      luma: (r * 0.299) + (g * 0.587) + (b * 0.114)
    });
  }
  return samples;
}

function edgeScanPoint(
  bounds: ContentBounds,
  fixedCoord: number,
  side: 'left' | 'right' | 'top' | 'bottom',
  offset: number
): { x: number; y: number } {
  if (side === 'left') {
    return {
      x: clampInt(bounds.minX + offset, bounds.minX, bounds.maxX),
      y: clampInt(fixedCoord, bounds.minY, bounds.maxY)
    };
  }
  if (side === 'right') {
    return {
      x: clampInt(bounds.maxX - offset, bounds.minX, bounds.maxX),
      y: clampInt(fixedCoord, bounds.minY, bounds.maxY)
    };
  }
  if (side === 'top') {
    return {
      x: clampInt(fixedCoord, bounds.minX, bounds.maxX),
      y: clampInt(bounds.minY + offset, bounds.minY, bounds.maxY)
    };
  }
  return {
    x: clampInt(fixedCoord, bounds.minX, bounds.maxX),
    y: clampInt(bounds.maxY - offset, bounds.minY, bounds.maxY)
  };
}

function averageScanColor(samples: ScanSample[]): { r: number; g: number; b: number } {
  if (samples.length === 0) return { r: 127, g: 127, b: 127 };
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const sample of samples) {
    sumR += sample.r;
    sumG += sample.g;
    sumB += sample.b;
  }
  return {
    r: sumR / samples.length,
    g: sumG / samples.length,
    b: sumB / samples.length
  };
}

function averageAbsoluteColorDelta(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  return (
    Math.abs(a.r - b.r) +
    Math.abs(a.g - b.g) +
    Math.abs(a.b - b.b)
  ) / 3;
}

function averageNumber(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function smoothProfile(values: number[], radius: number): number[] {
  const out = new Array<number>(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j < 0 || j >= values.length) continue;
      sum += values[j];
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

function findProminentProfileEdge(
  profile: number[],
  start: number,
  end: number,
  mode: 'left' | 'right'
): number | null {
  const lo = clampInt(start, 0, profile.length - 1);
  const hi = clampInt(end, lo, profile.length - 1);
  const slice = profile.slice(lo, hi + 1);
  if (slice.length === 0) return null;
  const max = Math.max(...slice);
  if (!isFinite(max) || max <= 0) return null;
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const threshold = mean + (max - mean) * 0.32;

  if (mode === 'left') {
    for (let i = lo; i <= hi; i++) {
      if (profile[i] >= threshold) return i;
    }
    return null;
  }

  for (let i = hi; i >= lo; i--) {
    if (profile[i] >= threshold) return i;
  }
  return null;
}

function buildCanvasCentering(
  cardBounds: ContentBounds | null,
  innerBounds: ContentBounds | null,
  width: number,
  height: number
): CenteringResult {
  const card = cardBounds ?? { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  const cardW = Math.max(1, card.maxX - card.minX + 1);
  const cardH = Math.max(1, card.maxY - card.minY + 1);
  const defaultInsetX = Math.max(1, Math.round(cardW * 0.08));
  const defaultInsetY = Math.max(1, Math.round(cardH * 0.08));

  const rawInner = innerBounds ?? {
    minX: card.minX + defaultInsetX,
    minY: card.minY + defaultInsetY,
    maxX: card.maxX - defaultInsetX,
    maxY: card.maxY - defaultInsetY
  };

  const minX = clampInt(rawInner.minX, card.minX, card.maxX - 1);
  const minY = clampInt(rawInner.minY, card.minY, card.maxY - 1);
  const maxX = clampInt(rawInner.maxX, minX + 1, card.maxX);
  const maxY = clampInt(rawInner.maxY, minY + 1, card.maxY);

  const leftPx = Math.max(1, minX - card.minX);
  const rightPx = Math.max(1, card.maxX - maxX);
  const topPx = Math.max(1, minY - card.minY);
  const bottomPx = Math.max(1, card.maxY - maxY);

  const lrTotal = leftPx + rightPx;
  const tbTotal = topPx + bottomPx;
  const leftPct = (leftPx / lrTotal) * 100;
  const rightPct = (rightPx / lrTotal) * 100;
  const topPct = (topPx / tbTotal) * 100;
  const bottomPct = (bottomPx / tbTotal) * 100;
  const lrWorst = Math.max(leftPct, rightPct);
  const tbWorst = Math.max(topPct, bottomPct);

  const lrRatio = `${Math.round(lrWorst)}/${Math.round(Math.min(leftPct, rightPct))}`;
  const tbRatio = `${Math.round(tbWorst)}/${Math.round(Math.min(topPct, bottomPct))}`;
  const worst = lrWorst >= tbWorst
    ? { axis: 'LR' as const, ratio: lrRatio, worstSidePct: lrWorst }
    : { axis: 'TB' as const, ratio: tbRatio, worstSidePct: tbWorst };

  const gradeCap = centeringCapFromWorstSidePct(worst.worstSidePct);
  return {
    lr: { ratio: lrRatio, worstSidePct: lrWorst },
    tb: { ratio: tbRatio, worstSidePct: tbWorst },
    worst,
    gradeCap,
    debug: {
      rectifiedSize: { w: width, h: height },
      border: { leftPx, rightPx, topPx, bottomPx, leftPct, rightPct, topPct, bottomPct },
      cardRect: { x: card.minX, y: card.minY, w: cardW, h: cardH },
      innerRect: { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
    }
  };
}

function detectCanvasPsaStyleFlaws(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null
): {
  totalPoints: number;
  condition: string;
  gradeCap: GradeCap;
  items: FlawItem[];
  debug: { blurVariance: number; meanLuma: number; stdLuma: number; borderRoughness: number; exposureOffset: number; };
} {
  const stats = computeLumaStats(px, width, height);
  const items: FlawItem[] = [];
  const borderRoughness = estimateBorderRoughness(px, width, height, bounds);

  // Surface wear: calibrated for front-photo grading where slight softness/noise is common.
  const surfaceWearSeverity: Severity =
    stats.blurVariance < 35 ? 'Moderate'
      : stats.blurVariance < 60 ? 'Minor'
        : stats.blurVariance < 95 ? 'Slight'
          : 'NONE';
  if (surfaceWearSeverity !== 'NONE') {
    items.push({
      category: 'Surface Wear',
      severity: surfaceWearSeverity,
      points: severityToPoints(surfaceWearSeverity),
      metric: `Blur variance ${stats.blurVariance.toFixed(1)}`
    });
  }

  // Edgewear: perimeter roughness around the detected outer-card boundary.
  const edgewearSeverity: Severity =
    borderRoughness > 52 ? 'Minor'
      : borderRoughness > 30 ? 'Slight'
        : 'NONE';
  if (edgewearSeverity !== 'NONE') {
    items.push({
      category: 'Edgewear',
      severity: edgewearSeverity,
      points: severityToPoints(edgewearSeverity),
      metric: `Perimeter roughness ${borderRoughness.toFixed(1)}`
    });
  }

  const exposureOffset = Math.abs(stats.meanLuma - 128);
  const exposureSeverity: Severity =
    exposureOffset > 70 ? 'Moderate'
      : exposureOffset > 52 ? 'Minor'
        : exposureOffset > 38 ? 'Slight'
          : 'NONE';
  if (exposureSeverity !== 'NONE') {
    items.push({
      category: 'Defect',
      severity: exposureSeverity,
      points: severityToPoints(exposureSeverity),
      metric: `Exposure offset ${exposureOffset.toFixed(1)}`
    });
  }

  const totalPoints = items.reduce((sum, item) => sum + item.points, 0);
  const mapped = pointsToCondition(totalPoints);
  return {
    totalPoints,
    condition: mapped.condition,
    gradeCap: mapped.gradeCap,
    items,
    debug: {
      blurVariance: stats.blurVariance,
      meanLuma: stats.meanLuma,
      stdLuma: stats.stdLuma,
      borderRoughness,
      exposureOffset
    }
  };
}

function estimateBorderRoughness(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null
): number {
  if (!bounds) return 0;

  const minX = clampInt(bounds.minX, 0, width - 1);
  const minY = clampInt(bounds.minY, 0, height - 1);
  const maxX = clampInt(bounds.maxX, minX, width - 1);
  const maxY = clampInt(bounds.maxY, minY, height - 1);
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.008));
  const step = Math.max(1, Math.floor(Math.min(width, height) / 480));

  const lumaAt = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return px[idx] * 0.299 + px[idx + 1] * 0.587 + px[idx + 2] * 0.114;
  };

  let sum = 0;
  let count = 0;
  const pad = Math.max(4, ring + 1);

  for (let x = minX + pad; x <= maxX - pad; x += step) {
    const topOuter = lumaAt(x, minY);
    const topInner = lumaAt(x, Math.min(maxY, minY + ring));
    const botOuter = lumaAt(x, maxY);
    const botInner = lumaAt(x, Math.max(minY, maxY - ring));
    sum += Math.abs(topOuter - topInner) + Math.abs(botOuter - botInner);
    count += 2;
  }

  for (let y = minY + pad; y <= maxY - pad; y += step) {
    const leftOuter = lumaAt(minX, y);
    const leftInner = lumaAt(Math.min(maxX, minX + ring), y);
    const rightOuter = lumaAt(maxX, y);
    const rightInner = lumaAt(Math.max(minX, maxX - ring), y);
    sum += Math.abs(leftOuter - leftInner) + Math.abs(rightOuter - rightInner);
    count += 2;
  }

  if (!count) return 0;
  return sum / count;
}

function computeLumaStats(px: Uint8ClampedArray, width: number, height: number): { meanLuma: number; stdLuma: number; blurVariance: number } {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 320));
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let lapCount = 0;
  let lapSum = 0;
  let lapSumSq = 0;

  const lumaAt = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  };

  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const c = lumaAt(x, y);
      sum += c;
      sumSq += c * c;
      count++;

      const lap = (4 * c) - lumaAt(x - 1, y) - lumaAt(x + 1, y) - lumaAt(x, y - 1) - lumaAt(x, y + 1);
      lapSum += lap;
      lapSumSq += lap * lap;
      lapCount++;
    }
  }

  const meanLuma = count ? sum / count : 127;
  const varLuma = count ? Math.max(0, (sumSq / count) - (meanLuma * meanLuma)) : 0;
  const stdLuma = Math.sqrt(varLuma);
  const meanLap = lapCount ? lapSum / lapCount : 0;
  const blurVariance = lapCount ? Math.max(0, (lapSumSq / lapCount) - (meanLap * meanLap)) : 0;
  return { meanLuma, stdLuma, blurVariance };
}

function computeCanvasConfidence(blurVariance: number, meanLuma: number, stdLuma: number, hasBounds: boolean): number {
  const blurScore = clamp01((blurVariance - 18) / 160);
  const exposureScore = clamp01(1 - Math.abs(meanLuma - 128) / 128);
  const contrastScore = clamp01(stdLuma / 64);
  const boundsScore = hasBounds ? 1 : 0.65;
  return clamp01(0.25 + 0.35 * blurScore + 0.2 * exposureScore + 0.12 * contrastScore + 0.08 * boundsScore);
}

// =========================
// Helpers: IO
// =========================
type ProcessingCanvas = HTMLCanvasElement | OffscreenCanvas;

function createProcessingCanvas(width: number, height: number): ProcessingCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('No canvas implementation is available in this environment.');
}

function canvasToPngDataUrl(canvas: ProcessingCanvas): Promise<string> | string {
  if ('toDataURL' in canvas) {
    return canvas.toDataURL('image/png');
  }
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/png' }).then(blobToDataUrl);
  }
  throw new Error('Canvas cannot be serialized to PNG.');
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function fileToMat(cv: any, file: File): Promise<any> {
  const bmp = await createImageBitmap(file);
  const longEdge = Math.max(bmp.width, bmp.height);
  const scale = longEdge > TUNING.maxInputLongEdgePx ? TUNING.maxInputLongEdgePx / longEdge : 1;
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));

  const canvas = createProcessingCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  ctx.drawImage(bmp, 0, 0, width, height);
  if ('close' in bmp) bmp.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const mat = cv.matFromImageData(imageData);
  return mat;
}

async function matToDataUrl(cv: any, mat: any): Promise<string> {
  const canvas = createProcessingCanvas(mat.cols, mat.rows);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');

  const out = new cv.Mat();
  const depth = mat.type() % 8;
  const scale = depth <= cv.CV_8S ? 1 : depth <= cv.CV_32S ? 1 / 256 : 255;
  const shift = depth === cv.CV_8S || depth === cv.CV_16S ? 128 : 0;
  mat.convertTo(out, cv.CV_8U, scale, shift);

  switch (out.type()) {
    case cv.CV_8UC1:
      cv.cvtColor(out, out, cv.COLOR_GRAY2RGBA);
      break;
    case cv.CV_8UC3:
      cv.cvtColor(out, out, cv.COLOR_RGB2RGBA);
      break;
    case cv.CV_8UC4:
      break;
    default:
      out.delete();
      throw new Error('Unsupported Mat channel count for PNG export.');
  }

  const imageData = new ImageData(new Uint8ClampedArray(out.data), out.cols, out.rows);
  ctx.putImageData(imageData, 0, 0);
  out.delete();
  return await canvasToPngDataUrl(canvas);
}

// =========================
// Quality gates
// =========================
function laplacianVariance(cv: any, bgr: any): number {
  const gray = new cv.Mat();
  cv.cvtColor(bgr, gray, cv.COLOR_RGBA2GRAY, 0);
  const lap = new cv.Mat();
  cv.Laplacian(gray, lap, cv.CV_64F);
  const mean = new cv.Mat();
  const std = new cv.Mat();
  cv.meanStdDev(lap, mean, std);
  const v = std.data64F[0] * std.data64F[0];
  gray.delete();
  lap.delete();
  mean.delete();
  std.delete();
  return v;
}

function estimateGlare(cv: any, rgba: any): { frac: number } {
  const hsv = new cv.Mat();
  cv.cvtColor(rgba, hsv, cv.COLOR_RGBA2HSV, 0);
  const channels = new cv.MatVector();
  cv.split(hsv, channels);
  const s = channels.get(1);
  const v = channels.get(2);

  const bright = new cv.Mat();
  cv.threshold(v, bright, TUNING.glareSaturationThreshold, 255, cv.THRESH_BINARY);
  const lowSat = new cv.Mat();
  cv.threshold(s, lowSat, 40, 255, cv.THRESH_BINARY_INV);

  const glare = new cv.Mat();
  cv.bitwise_and(bright, lowSat, glare);
  const glareCount = cv.countNonZero(glare);
  const total = rgba.rows * rgba.cols;

  hsv.delete();
  channels.delete();
  s.delete();
  v.delete();
  bright.delete();
  lowSat.delete();
  glare.delete();

  return { frac: glareCount / total };
}

// =========================
// Card detection + rectification
// =========================
type Point = { x: number; y: number };

function detectCardQuadrilateral(cv: any, rgba: any): Point[] | null {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY, 0);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  const edges = new cv.Mat();
  cv.Canny(blur, edges, TUNING.canny1, TUNING.canny2);

  // Close gaps
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const closed = new cv.Mat();
  cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const imgArea = rgba.rows * rgba.cols;
  let best: { area: number; approx: any } | null = null;

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < imgArea * TUNING.minCardAreaFrac) {
      cnt.delete();
      continue;
    }
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, TUNING.approxPolyEpsFrac * peri, true);

    if (approx.rows === 4) {
      if (!best || area > best.area) {
        if (best) best.approx.delete();
        best = { area, approx };
      } else {
        approx.delete();
      }
    } else {
      approx.delete();
    }
    cnt.delete();
  }

  gray.delete();
  blur.delete();
  edges.delete();
  kernel.delete();
  closed.delete();
  contours.delete();
  hierarchy.delete();

  if (!best) return null;
  const pts = matToPoints(best.approx);
  best.approx.delete();
  return orderQuadPoints(pts);
}

function matToPoints(mat: any): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < mat.data32S.length; i += 2) {
    pts.push({ x: mat.data32S[i], y: mat.data32S[i + 1] });
  }
  return pts;
}

function orderQuadPoints(pts: Point[]): Point[] {
  // Order: top-left, top-right, bottom-right, bottom-left
  const sum = pts.map(p => p.x + p.y);
  const diff = pts.map(p => p.x - p.y);
  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.max(...diff))];
  const bl = pts[diff.indexOf(Math.min(...diff))];
  return [tl, tr, br, bl];
}

function rectifyCard(cv: any, rgba: any, quad: Point[]): { rectified: any; skewAngleDeg: number } {
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap(p => [p.x, p.y]));
  const dstPts: Point[] = [
    { x: 0, y: 0 },
    { x: TUNING.rectifiedWidthPx - 1, y: 0 },
    { x: TUNING.rectifiedWidthPx - 1, y: TUNING.rectifiedHeightPx - 1 },
    { x: 0, y: TUNING.rectifiedHeightPx - 1 }
  ];
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, dstPts.flatMap(p => [p.x, p.y]));
  const M = cv.getPerspectiveTransform(src, dst);
  const rectified = new cv.Mat();
  cv.warpPerspective(rgba, rectified, M, new cv.Size(TUNING.rectifiedWidthPx, TUNING.rectifiedHeightPx));

  // Estimate skew angle from top edge
  const dx = quad[1].x - quad[0].x;
  const dy = quad[1].y - quad[0].y;
  const skewAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  src.delete();
  dst.delete();
  M.delete();

  return { rectified, skewAngleDeg };
}

// =========================
// Centering
// =========================
function computeCentering(cv: any, rectifiedRGBA: any): CenteringResult | null {
  // Idea:
  // 1) Convert to gray, compute edge energy map.
  // 2) For each scanline band near borders, find strongest inner edge (border->art boundary).
  // 3) Construct inner rectangle; borders are distances from outer rect.

  const w = rectifiedRGBA.cols;
  const h = rectifiedRGBA.rows;
  const insetX = Math.round(w * TUNING.borderSearchInsetFrac);
  const insetY = Math.round(h * TUNING.borderSearchInsetFrac);

  const gray = new cv.Mat();
  cv.cvtColor(rectifiedRGBA, gray, cv.COLOR_RGBA2GRAY, 0);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(TUNING.edgeEnergySmoothing, TUNING.edgeEnergySmoothing), 0);

  const edges = new cv.Mat();
  cv.Canny(blur, edges, 30, 90);

  // Summed edge energy per column/row
  const colSum = new Array<number>(w).fill(0);
  const rowSum = new Array<number>(h).fill(0);
  for (let y = insetY; y < h - insetY; y++) {
    for (let x = insetX; x < w - insetX; x++) {
      const v = edges.ucharPtr(y, x)[0] / 255;
      colSum[x] += v;
      rowSum[y] += v;
    }
  }

  // Find inner edges: left boundary is a prominent edge peak away from the very left.
  const left = findProminentEdge(colSum, insetX, Math.floor(w * 0.45), 'left');
  const right = findProminentEdge(colSum, Math.ceil(w * 0.55), w - insetX - 1, 'right');
  const top = findProminentEdge(rowSum, insetY, Math.floor(h * 0.45), 'left');
  const bottom = findProminentEdge(rowSum, Math.ceil(h * 0.55), h - insetY - 1, 'right');

  gray.delete();
  blur.delete();
  edges.delete();

  if (left == null || right == null || top == null || bottom == null) return null;
  if (right - left < w * 0.4 || bottom - top < h * 0.4) return null;

  const leftPx = left;
  const rightPx = w - 1 - right;
  const topPx = top;
  const bottomPx = h - 1 - bottom;

  const lrTotal = leftPx + rightPx;
  const tbTotal = topPx + bottomPx;
  if (lrTotal <= 0 || tbTotal <= 0) return null;

  const leftPct = (leftPx / lrTotal) * 100;
  const rightPct = (rightPx / lrTotal) * 100;
  const topPct = (topPx / tbTotal) * 100;
  const bottomPct = (bottomPx / tbTotal) * 100;

  const lrWorst = Math.max(leftPct, rightPct);
  const tbWorst = Math.max(topPct, bottomPct);

  const lrRatio = `${Math.round(Math.max(leftPct, rightPct))}/${Math.round(Math.min(leftPct, rightPct))}`;
  const tbRatio = `${Math.round(Math.max(topPct, bottomPct))}/${Math.round(Math.min(topPct, bottomPct))}`;

  const worst = lrWorst >= tbWorst
    ? { axis: 'LR' as const, ratio: lrRatio, worstSidePct: lrWorst }
    : { axis: 'TB' as const, ratio: tbRatio, worstSidePct: tbWorst };

  const cap = centeringCapFromWorstSidePct(worst.worstSidePct);

  return {
    lr: { ratio: lrRatio, worstSidePct: lrWorst },
    tb: { ratio: tbRatio, worstSidePct: tbWorst },
    worst,
    gradeCap: cap,
    debug: {
      rectifiedSize: { w, h },
      border: { leftPx, rightPx, topPx, bottomPx, leftPct, rightPct, topPct, bottomPct },
      cardRect: { x: 0, y: 0, w, h },
      innerRect: { x: left, y: top, w: right - left, h: bottom - top }
    }
  };
}

function findProminentEdge(arr: number[], start: number, end: number, mode: 'left' | 'right'): number | null {
  const slice = arr.slice(start, end + 1);
  const max = Math.max(...slice);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const minProm = mean + (max - mean) * TUNING.innerEdgeMinProminence;

  if (!isFinite(max) || max <= 0) return null;

  // Choose the first strong peak moving inward
  if (mode === 'left') {
    for (let i = start; i <= end; i++) {
      if (arr[i] >= minProm) return i;
    }
  } else {
    for (let i = end; i >= start; i--) {
      if (arr[i] >= minProm) return i;
    }
  }
  return null;
}

// =========================
// Flaw detection (heuristics)
// =========================
function detectFlaws(cv: any, rectifiedRGBA: any): FlawResult {
  const pxPerCmX = rectifiedRGBA.cols / TUNING.cardWidthCm;
  const pxPerCmY = rectifiedRGBA.rows / TUNING.cardHeightCm;
  const pxPerCm = (pxPerCmX + pxPerCmY) / 2;
  const pxPerMm = pxPerCm / 10;

  const items: FlawItem[] = [];

  // 1) Scratches: detect thin long bright/dark lines using Canny + HoughLinesP
  const scratch = detectScratches(cv, rectifiedRGBA, pxPerCm);
  if (scratch) items.push(scratch);

  // 2) Scuffing / surface wear: high-frequency texture anomalies in border + art combined
  const scuff = detectScuffing(cv, rectifiedRGBA, pxPerCm);
  if (scuff) items.push(scuff);

  // 3) Edgewear: strong edge irregularities along perimeter
  const edge = detectEdgewear(cv, rectifiedRGBA, pxPerCm);
  if (edge) items.push(edge);

  // 4) Indentation: blob-like small specular/dark patches; heuristic via LoG blobs
  const indent = detectIndentation(cv, rectifiedRGBA, pxPerMm);
  if (indent) items.push(indent);

  // 5) Grime/stains: color outliers vs local neighborhood (LAB deltaE-ish)
  const grime = detectGrime(cv, rectifiedRGBA, pxPerCm, pxPerMm);
  if (grime) items.push(grime);

  // 6) Bend/crease: long low-frequency line + gradient discontinuity
  const bend = detectBends(cv, rectifiedRGBA, pxPerCm);
  if (bend) items.push(bend);

  // 7) Corner rounding: measure corner curvature radius
  const corner = detectCornerRounding(cv, rectifiedRGBA);
  if (corner) items.push(corner);

  // Aggregate points
  const totalPoints = items.reduce((s, it) => s + it.points, 0);
  const { condition, gradeCap } = pointsToCondition(totalPoints);

  return { totalPoints, condition, gradeCap, items };
}

function detectScratches(cv: any, rgba: any, pxPerCm: number): FlawItem | null {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY, 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 40, 120);

  const lines = new cv.Mat();
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 80, 40, 8);

  let totalLenPx = 0;
  for (let i = 0; i < lines.rows; i++) {
    const x1 = lines.data32S[i * 4 + 0];
    const y1 = lines.data32S[i * 4 + 1];
    const x2 = lines.data32S[i * 4 + 2];
    const y2 = lines.data32S[i * 4 + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    // Filter to mostly straight lines; ignore border edges by requiring interior placement
    const midx = (x1 + x2) / 2;
    const midy = (y1 + y2) / 2;
    if (midx < 40 || midx > rgba.cols - 40 || midy < 40 || midy > rgba.rows - 40) continue;
    if (len >= 25) totalLenPx += len;
  }

  const totalLenCm = totalLenPx / pxPerCm;
  const sev = scratchSeverity(totalLenCm);

  gray.delete();
  edges.delete();
  lines.delete();

  if (sev === 'NONE') return null;
  return {
    category: 'Scratch',
    severity: sev,
    points: severityToPoints(sev),
    metric: `Sum length ≈ ${totalLenCm.toFixed(2)} cm`
  };
}

function scratchSeverity(totalLenCm: number): Severity {
  if (totalLenCm <= 0) return 'NONE';
  if (totalLenCm <= TUNING.scratchMinLenCmSlight) return 'Slight';
  if (totalLenCm <= TUNING.scratchMinLenCmMinor) return 'Minor';
  if (totalLenCm > 4) return 'Moderate';
  return 'Minor';
}

function detectScuffing(cv: any, rgba: any, pxPerCm: number): FlawItem | null {
  // Heuristic: compare local variance map, threshold to blobs, measure area.
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY, 0);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(9, 9), 0);
  const diff = new cv.Mat();
  cv.absdiff(gray, blur, diff);
  const thr = new cv.Mat();
  cv.threshold(diff, thr, 18, 255, cv.THRESH_BINARY);

  // remove thin lines (scratches) by opening
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
  const opened = new cv.Mat();
  cv.morphologyEx(thr, opened, cv.MORPH_OPEN, kernel);

  const areaPx = cv.countNonZero(opened);
  const areaCm2 = areaPx / (pxPerCm * pxPerCm);

  const sev = areaToSeverity(areaCm2, {
    slight: TUNING.scuffSlightCm2,
    minor: TUNING.scuffMinorCm2,
    moderate: TUNING.scuffModerateCm2,
    major: TUNING.scuffMajorCm2
  });

  gray.delete();
  blur.delete();
  diff.delete();
  thr.delete();
  kernel.delete();
  opened.delete();

  if (sev === 'NONE') return null;
  return {
    category: 'Scuffing',
    severity: sev,
    points: severityToPoints(sev),
    metric: `Area ≈ ${areaCm2.toFixed(2)} cm²`
  };
}

function detectEdgewear(cv: any, rgba: any, pxPerCm: number): FlawItem | null {
  // Heuristic: look at perimeter strip; count edge irregularities / high gradient pixels.
  const strip = perimeterStripMask(cv, rgba.cols, rgba.rows, 18);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY, 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);

  const masked = new cv.Mat();
  cv.bitwise_and(edges, strip, masked);

  // Convert edge pixel count to an approximate "length" by dividing by strip thickness.
  const count = cv.countNonZero(masked);
  const approxLenPx = count / 6; // heuristic scale
  const lenCm = approxLenPx / pxPerCm;

  const sev: Severity =
    lenCm <= 0 ? 'NONE' :
    lenCm <= TUNING.edgewearSlightCm ? 'Slight' :
    lenCm <= TUNING.edgewearMinorCm ? 'Minor' :
    lenCm <= TUNING.edgewearModerateCm ? 'Moderate' :
    'Major';

  strip.delete();
  gray.delete();
  edges.delete();
  masked.delete();

  if (sev === 'NONE') return null;
  return {
    category: 'Edgewear',
    severity: sev,
    points: severityToPoints(sev),
    metric: `Perimeter wear length ≈ ${lenCm.toFixed(2)} cm`
  };
}

function detectIndentation(cv: any, rgba: any, pxPerMm: number): FlawItem | null {
  // Heuristic: small, high-contrast blobs.
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY, 0);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

  const lap = new cv.Mat();
  cv.Laplacian(blur, lap, cv.CV_8U);
  const thr = new cv.Mat();
  cv.threshold(lap, thr, 30, 255, cv.THRESH_BINARY);

  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  const opened = new cv.Mat();
  cv.morphologyEx(thr, opened, cv.MORPH_OPEN, kernel);

  const areaPx = cv.countNonZero(opened);
  const areaMm2 = areaPx / (pxPerMm * pxPerMm);

  let sev: Severity = 'NONE';
  if (areaMm2 > 0) {
    if (areaMm2 <= TUNING.indentationSlightMm2) sev = 'Slight';
    else if (areaMm2 <= TUNING.indentationModerateMm2) sev = 'Moderate';
    else sev = 'Major';
  }

  gray.delete();
  blur.delete();
  lap.delete();
  thr.delete();
  kernel.delete();
  opened.delete();

  if (sev === 'NONE') return null;
  return {
    category: 'Indentation',
    severity: sev === 'Moderate' ? 'Moderate' : sev,
    points: severityToPoints(sev === 'Major' ? 'Major' : sev),
    metric: `Indentation area ≈ ${areaMm2.toFixed(2)} mm²`
  };
}

function detectGrime(cv: any, rgba: any, pxPerCm: number, pxPerMm: number): FlawItem | null {
  // Heuristic: detect low-saturation dark patches in border strip.
  const hsv = new cv.Mat();
  cv.cvtColor(rgba, hsv, cv.COLOR_RGBA2HSV, 0);
  const channels = new cv.MatVector();
  cv.split(hsv, channels);
  const s = channels.get(1);
  const v = channels.get(2);

  const lowSat = new cv.Mat();
  cv.threshold(s, lowSat, 60, 255, cv.THRESH_BINARY_INV);
  const dark = new cv.Mat();
  cv.threshold(v, dark, 80, 255, cv.THRESH_BINARY_INV);

  const grimeMask = new cv.Mat();
  cv.bitwise_and(lowSat, dark, grimeMask);

  // Restrict to perimeter strip where grime/stain is more visible
  const strip = perimeterStripMask(cv, rgba.cols, rgba.rows, 40);
  const masked = new cv.Mat();
  cv.bitwise_and(grimeMask, strip, masked);

  const areaPx = cv.countNonZero(masked);
  const areaCm2 = areaPx / (pxPerCm * pxPerCm);
  const areaMm2 = areaPx / (pxPerMm * pxPerMm);

  let sev: Severity = 'NONE';
  if (areaMm2 > 0 && areaMm2 <= TUNING.grimeSlightMm2) {
    sev = 'Slight';
  } else if (areaCm2 > 0 && areaCm2 <= TUNING.grimeMinorCm2) {
    sev = 'Minor';
  } else if (areaCm2 > TUNING.grimeMinorCm2 && areaCm2 <= TUNING.grimeModerateCm2) {
    sev = 'Moderate';
  } else if (areaCm2 > TUNING.grimeModerateCm2) {
    sev = 'Major';
  }

  hsv.delete();
  channels.delete();
  s.delete();
  v.delete();
  lowSat.delete();
  dark.delete();
  grimeMask.delete();
  strip.delete();
  masked.delete();

  if (sev === 'NONE') return null;
  return {
    category: 'Grime',
    severity: sev,
    points: severityToPoints(sev),
    metric: `Area ≈ ${sev === 'Slight' ? areaMm2.toFixed(2) + ' mm²' : areaCm2.toFixed(2) + ' cm²'}`
  };
}

function detectBends(cv: any, rgba: any, pxPerCm: number): FlawItem | null {
  // Heuristic: large-scale crease lines: use Scharr gradients + Hough.
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY, 0);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(11, 11), 0);

  const edges = new cv.Mat();
  cv.Canny(blur, edges, 20, 60);

  const lines = new cv.Mat();
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 120, 120, 15);

  let longestPx = 0;
  for (let i = 0; i < lines.rows; i++) {
    const x1 = lines.data32S[i * 4 + 0];
    const y1 = lines.data32S[i * 4 + 1];
    const x2 = lines.data32S[i * 4 + 2];
    const y2 = lines.data32S[i * 4 + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len > longestPx) longestPx = len;
  }

  const lenCm = longestPx / pxPerCm;
  let sev: Severity = 'NONE';
  if (lenCm > 0) {
    if (lenCm <= TUNING.bendMinorCm) sev = 'Minor';
    else if (lenCm <= TUNING.bendModerateCm) sev = 'Moderate';
    else sev = 'Major';
  }

  gray.delete();
  blur.delete();
  edges.delete();
  lines.delete();

  if (sev === 'NONE') return null;
  return {
    category: 'Bend',
    severity: sev === 'Minor' ? 'Minor' : sev,
    points: severityToPoints(sev),
    metric: `Longest crease-like line ≈ ${lenCm.toFixed(2)} cm`
  };
}

function detectCornerRounding(cv: any, rgba: any): FlawItem | null {
  // Heuristic: measure corner radius by fitting circle to corner edge pixels.
  // We approximate by sampling a small patch and estimating curvature via distance transform.
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY, 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);

  const patchSize = 90;
  const corners = [
    { name: 'TL', x: 0, y: 0 },
    { name: 'TR', x: rgba.cols - patchSize, y: 0 },
    { name: 'BR', x: rgba.cols - patchSize, y: rgba.rows - patchSize },
    { name: 'BL', x: 0, y: rgba.rows - patchSize }
  ];

  const radii: number[] = [];
  for (const c of corners) {
    const roi = edges.roi(new cv.Rect(c.x, c.y, patchSize, patchSize));
    const inv = new cv.Mat();
    cv.threshold(roi, inv, 1, 255, cv.THRESH_BINARY_INV);
    const dist = new cv.Mat();
    cv.distanceTransform(inv, dist, cv.DIST_L2, 3);
    // radius proxy: max distance in patch
    const mm = cv.minMaxLoc(dist);
    radii.push(mm.maxVal);
    roi.delete();
    inv.delete();
    dist.delete();
  }

  const radiusPx = radii.reduce((a, b) => a + b, 0) / radii.length;

  let sev: Severity = 'NONE';
  if (radiusPx >= TUNING.cornerRadiusMajorPx) sev = 'Major';
  else if (radiusPx >= TUNING.cornerRadiusModeratePx) sev = 'Moderate';
  else if (radiusPx >= TUNING.cornerRadiusMinorPx) sev = 'Minor';
  else if (radiusPx >= TUNING.cornerRadiusSlightPx) sev = 'Slight';

  gray.delete();
  edges.delete();

  if (sev === 'NONE') return null;
  return {
    category: 'Corner Rounding',
    severity: sev,
    points: severityToPoints(sev),
    metric: `Avg corner radius ≈ ${radiusPx.toFixed(1)} px`
  };
}

function areaToSeverity(areaCm2: number, t: { slight: number; minor: number; moderate: number; major: number }): Severity {
  if (areaCm2 <= 0) return 'NONE';
  if (areaCm2 <= t.slight) return 'Slight';
  if (areaCm2 <= t.minor) return 'Minor';
  if (areaCm2 <= t.moderate) return 'Moderate';
  if (areaCm2 <= t.major) return 'Major';
  return 'Major';
}

function perimeterStripMask(cv: any, w: number, h: number, thickness: number): any {
  const mask = new cv.Mat.zeros(h, w, cv.CV_8UC1);
  // top
  cv.rectangle(mask, new cv.Point(0, 0), new cv.Point(w - 1, thickness), new cv.Scalar(255), -1);
  // bottom
  cv.rectangle(mask, new cv.Point(0, h - thickness - 1), new cv.Point(w - 1, h - 1), new cv.Scalar(255), -1);
  // left
  cv.rectangle(mask, new cv.Point(0, 0), new cv.Point(thickness, h - 1), new cv.Scalar(255), -1);
  // right
  cv.rectangle(mask, new cv.Point(w - thickness - 1, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(255), -1);
  return mask;
}

// =========================
// Overlay rendering
// =========================
function drawOverlay(cv: any, rectifiedRGBA: any, centering: CenteringResult | null, flaws: FlawResult): any {
  const overlay = rectifiedRGBA.clone();

  // Draw inner content rectangle and border measurements
  if (centering) {
    const { innerRect, border } = centering.debug;
    const rect = new cv.Rect(innerRect.x, innerRect.y, innerRect.w, innerRect.h);
    cv.rectangle(overlay, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), new cv.Scalar(125, 211, 252, 255), 2);

    // Midlines
    cv.line(overlay, new cv.Point(Math.floor(overlay.cols / 2), 0), new cv.Point(Math.floor(overlay.cols / 2), overlay.rows), new cv.Scalar(255, 255, 255, 80), 1);
    cv.line(overlay, new cv.Point(0, Math.floor(overlay.rows / 2)), new cv.Point(overlay.cols, Math.floor(overlay.rows / 2)), new cv.Scalar(255, 255, 255, 80), 1);

    // Border bands
    cv.rectangle(overlay, new cv.Point(0, 0), new cv.Point(border.leftPx, overlay.rows), new cv.Scalar(134, 239, 172, 50), -1);
    cv.rectangle(overlay, new cv.Point(overlay.cols - border.rightPx, 0), new cv.Point(overlay.cols, overlay.rows), new cv.Scalar(134, 239, 172, 50), -1);
    cv.rectangle(overlay, new cv.Point(0, 0), new cv.Point(overlay.cols, border.topPx), new cv.Scalar(134, 239, 172, 50), -1);
    cv.rectangle(overlay, new cv.Point(0, overlay.rows - border.bottomPx), new cv.Point(overlay.cols, overlay.rows), new cv.Scalar(134, 239, 172, 50), -1);

    // Text
    cv.putText(
      overlay,
      `LR ${centering.lr.ratio}  TB ${centering.tb.ratio}  Worst ${centering.worst.ratio}  Cap ${centering.gradeCap.gradeLabel}`,
      new cv.Point(12, 24),
      cv.FONT_HERSHEY_SIMPLEX,
      0.55,
      new cv.Scalar(231, 231, 234, 255),
      2
    );
  } else {
    cv.putText(
      overlay,
      'UNSCORABLE: Border detection failed',
      new cv.Point(12, 24),
      cv.FONT_HERSHEY_SIMPLEX,
      0.65,
      new cv.Scalar(253, 224, 71, 255),
      2
    );
  }

  // Flaw summary text
  cv.putText(
    overlay,
    `Flaw points: ${flaws.totalPoints} (${flaws.condition}) cap ${flaws.gradeCap.gradeLabel}`,
    new cv.Point(12, 48),
    cv.FONT_HERSHEY_SIMPLEX,
    0.55,
    new cv.Scalar(231, 231, 234, 255),
    2
  );

  return overlay;
}

// =========================
// Confidence
// =========================
function computeConfidence(args: { blurVar: number; glareFrac: number; skewAngleDeg: number; centeringOk: boolean; reasonsCount: number }): number {
  const blurScore = clamp01((args.blurVar - TUNING.blurVarianceThreshold) / (TUNING.blurVarianceThreshold * 2));
  const glareScore = clamp01(1 - args.glareFrac / (TUNING.glareMaxFrac * 1.5));
  const skewScore = clamp01(1 - Math.abs(args.skewAngleDeg) / (TUNING.maxSkewAngleDeg * 1.5));
  const centeringScore = args.centeringOk ? 1 : 0.2;
  const penalty = Math.min(0.6, args.reasonsCount * 0.12);
  const base = 0.15 + 0.35 * blurScore + 0.25 * glareScore + 0.15 * skewScore + 0.10 * centeringScore;
  return clamp01(base - penalty);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
