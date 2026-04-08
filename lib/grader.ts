/*
  Photo-based front-only grading pipeline.
  This is heuristic by design; the overlay is intended for user audit.
*/

import {
  assessConditionFromFlaws,
  centeringCapFromWorstSidePct,
  finalGradeFromCaps,
  severityToPoints,
  type FlawCategory,
  type GradeCap,
  type Severity,
  type TcgCondition
} from './rubric';
import {
  buildFittedImageTransform,
  clampFloat,
  clampManualImageNormalization,
  isIdentityNormalization,
  type ManualImageNormalization
} from './manualAlignment';

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

export type EvidenceStrength = 'high' | 'medium' | 'low';

export type Observability = 'observed' | 'inferred' | 'assumed' | 'not_observable';

export type FindingSeverity = 'none' | 'slight' | 'minor' | 'moderate' | 'major';

export type FindingCategory = 'corners' | 'edges' | 'surface' | 'shape' | 'quality';

export type FindingMeasurement = {
  kind: 'length_cm' | 'area_cm2' | 'area_mm2' | 'count' | 'ratio' | 'index' | 'pixels';
  value: number;
  display: string;
  approximate: boolean;
  normalized?: number;
};

export type FindingRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
  normalized: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
};

export type DetectedFinding = {
  id: string;
  category: FindingCategory;
  flawType: string;
  location: string;
  severity: FindingSeverity;
  evidenceStrength: EvidenceStrength;
  observability: Observability;
  metric: string;
  notes: string[];
  measurement?: FindingMeasurement;
  count?: number;
  region?: FindingRegion;
};

export type QualityCheck = {
  key: 'blur' | 'glare' | 'low_resolution' | 'occlusion' | 'cropping' | 'perspective' | 'full_front_border';
  label: string;
  observed: boolean;
  severity: 'none' | 'low' | 'moderate' | 'high';
  metric?: string;
  note: string;
  impactsObservability: boolean;
};

export type QualityAssessment = {
  readable: boolean;
  imageQualityScore: number; // 0..1
  blurVariance: number;
  meanLuma: number;
  stdLuma: number;
  resolution: { width: number; height: number; longEdgePx: number };
  cardDetected: boolean;
  fullFrontVisible: boolean;
  checks: QualityCheck[];
};

export type GradeCeilingAssessment = {
  source: 'centering' | 'visible_defect' | 'confidence';
  cap: GradeCap;
  reason: string;
};

export type FlawItem = {
  category: FlawCategory;
  severity: Exclude<Severity, 'NONE'>;
  points: number;
  metric: string;
  location?: string;
  evidenceStrength?: EvidenceStrength;
  observability?: Exclude<Observability, 'not_observable'>;
  measurement?: FindingMeasurement;
  region?: FindingRegion;
  debug?: Record<string, unknown>;
};

export type FlawResult = {
  totalPoints: number;
  effectivePoints?: number;
  condition: string;
  pointCondition?: TcgCondition;
  matrixCondition?: TcgCondition;
  psaProfile?: string;
  limitingFlaws?: Array<{
    category: FlawCategory;
    severity: Exclude<Severity, 'NONE'>;
    condition: TcgCondition;
  }>;
  gradeCap: GradeCap;
  items: FlawItem[];
  detectedFindings?: DetectedFinding[];
  cornerFindings?: DetectedFinding[];
  edgeFindings?: DetectedFinding[];
  surfaceFindings?: DetectedFinding[];
  shapeFindings?: DetectedFinding[];
  notReliablyObservable?: string[];
};

export type StructuredGradeReport = {
  imageName?: string;
  cardDetected: boolean;
  fullFrontVisible: boolean;
  imageQuality: QualityAssessment;
  frontCenteringLR?: string;
  frontCenteringTB?: string;
  effectiveFrontCentering?: string;
  cornerFindings: DetectedFinding[];
  edgeFindings: DetectedFinding[];
  surfaceFindings: DetectedFinding[];
  shapeFindings: DetectedFinding[];
  detectedDefects: DetectedFinding[];
  defectPointsTotal: number;
  centeringGradeCeiling: GradeCeilingAssessment;
  visibleDefectGradeCeiling: GradeCeilingAssessment;
  confidenceGradeCeiling: GradeCeilingAssessment;
  finalGradeLabel: string;
  finalGradeNumeric: number;
  confidenceBand: 'low' | 'medium' | 'high';
  manualReviewRequired: boolean;
  assumptions: string[];
  limitations: string[];
  topReasons: string[];
  topChangeDrivers: string[];
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
  report?: StructuredGradeReport;
  debug?: Record<string, unknown>;
};

export type SurfaceFinishMode = 'standard' | 'textured';

export type GuideRect = { x: number; y: number; w: number; h: number };

export type ManualGuideOverride = {
  sourceSize: { w: number; h: number };
  cardRect: GuideRect;
  innerRect: GuideRect;
  normalization?: ManualImageNormalization | null;
  surfaceFinishMode?: SurfaceFinishMode | null;
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
  lowResolutionLongEdgePx: 900,
  moderateResolutionLongEdgePx: 1200,

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
  // Modern cards, especially Yu-Gi-Oh, often have visibly rounded factory corners.
  // Treat a baseline radius as normal before escalating to a flaw.
  cornerNaturalRadiusAllowancePx: 8,
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
const CROPSCALE_PADDING_FRAC = 0.04;

// =========================
// Public API
// =========================
export async function gradeCardFront(
  file: File,
  manualGuideOverride?: ManualGuideOverride | null
): Promise<{ result: GradeResult; overlayPNG: string; rectifiedPNG: string }> {
  const graded = await analyzeCardFrontCanvasFallback(file, 'Defaulted to canvas grading pipeline', 'grade', manualGuideOverride ?? null);
  return ensureCanvasGradeArtifacts(graded);
}

export async function prepareCardFrontCanvasOnly(file: File): Promise<{ result: GradeResult }> {
  const prepared = await analyzeCardFrontCanvasFallback(file, 'Prepared manual measurement guides', 'prepare');
  return { result: prepared.result };
}

export async function gradeCardFrontCanvasOnly(
  file: File,
  manualGuideOverride?: ManualGuideOverride | null
): Promise<{ result: GradeResult; overlayPNG: string; rectifiedPNG: string }> {
  const graded = await analyzeCardFrontCanvasFallback(file, 'Forced canvas fallback', 'grade', manualGuideOverride ?? null);
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
  const centeringCap = centering?.gradeCap ?? { gradeLabel: 'PR 1', psaNumeric: 1 };
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
  mode: 'prepare' | 'grade',
  manualGuideOverride: ManualGuideOverride | null = null
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

  const manualGuideBounds = mode === 'grade'
    ? resolveManualGuideOverrideBounds(manualGuideOverride, width, height)
    : null;
  const surfaceFinishMode: SurfaceFinishMode = manualGuideOverride?.surfaceFinishMode === 'textured' ? 'textured' : 'standard';
  if (manualGuideBounds?.normalization && !isIdentityNormalization(manualGuideBounds.normalization)) {
    applyManualImageNormalizationToCanvas(baseCanvas, width, height, manualGuideBounds.normalization);
  }
  const sourceImageData = baseCtx.getImageData(0, 0, width, height);
  const sourcePx = sourceImageData.data;
  const borderColor = estimateBorderColor(sourcePx, width, height);
  const colorBounds = estimateContentBounds(sourcePx, width, height, borderColor);
  const profileBounds = detectOuterCardBounds(sourcePx, width, height);
  const autoCardBounds = chooseBestCardBounds(colorBounds, profileBounds, width, height);
  const cardBounds = manualGuideBounds?.cardBounds ?? autoCardBounds;
  const sourceCardBounds = cardBounds ?? { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  const paddedSourceCardBounds = manualGuideBounds
    ? sourceCardBounds
    : expandBounds(sourceCardBounds, width, height, CROPSCALE_PADDING_FRAC);
  const aspectAlignedSourceCardBounds = manualGuideBounds
    ? sourceCardBounds
    : fitBoundsToAspect(
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

  if (!manualGuideBounds && ENABLE_PERSPECTIVE_NORMALIZATION && !perspectiveNormalizationDisabled) {
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
  const normalizedMappedCardBounds: ContentBounds = normalizationMethod === 'opencv_perspective'
    ? {
      minX: 0,
      minY: 0,
      maxX: normalizedWidth - 1,
      maxY: normalizedHeight - 1
    }
    : mapBoundsToNormalizedSpace(
      sourceCardBounds,
      selectedSourceCardBounds,
      normalizedWidth,
      normalizedHeight
    );
  const normalizedBorderColor = estimateBorderColor(normalizedPx, normalizedWidth, normalizedHeight);
  const normalizedColorBounds = estimateContentBounds(normalizedPx, normalizedWidth, normalizedHeight, normalizedBorderColor);
  const normalizedProfileBounds = detectOuterCardBounds(normalizedPx, normalizedWidth, normalizedHeight);
  const normalizedDetectedCardBounds = chooseBestCardBounds(
    normalizedColorBounds,
    normalizedProfileBounds,
    normalizedWidth,
    normalizedHeight
  );
  const normalizedBorderConfidence = manualGuideBounds
    ? manualGuideBorderConfidence(normalizedMappedCardBounds, normalizedWidth, normalizedHeight)
    : assessNormalizedBorderConfidence({
      normalizationMethod,
      width: normalizedWidth,
      height: normalizedHeight,
      expectedBounds: normalizedMappedCardBounds,
      detectedBounds: normalizedDetectedCardBounds
    });
  const normalizedCardBounds = manualGuideBounds
    ? normalizedMappedCardBounds
    : chooseBestCardBounds(
      normalizedMappedCardBounds,
      normalizedDetectedCardBounds,
      normalizedWidth,
      normalizedHeight
    ) ?? normalizedMappedCardBounds;
  const manualNormalizedInnerBounds = manualGuideBounds
    ? mapBoundsToNormalizedSpace(
      manualGuideBounds.innerBounds,
      selectedSourceCardBounds,
      normalizedWidth,
      normalizedHeight
    )
    : null;
  const autoInnerBounds = detectInnerContentBounds(normalizedPx, normalizedWidth, normalizedHeight, normalizedCardBounds);
  const innerBounds = manualNormalizedInnerBounds
    ? clampInnerBoundsToCardBounds(manualNormalizedInnerBounds, normalizedCardBounds)
    : autoInnerBounds;
  const centeringPreview = buildCanvasCentering(normalizedCardBounds, innerBounds, normalizedWidth, normalizedHeight);
  const centering = innerBounds ? centeringPreview : undefined;
  const sourceStats = computeLumaStats(sourcePx, width, height);
  const qualityAssessment = buildCanvasQualityAssessment({
    stats: sourceStats,
    sourceWidth: width,
    sourceHeight: height,
    cardBounds,
    innerBounds,
    borderConfidence: normalizedBorderConfidence
  });
  const confidenceCeiling = observabilityCeilingFromQuality(qualityAssessment);
  const unscorableReasons = buildCanvasUnscorableReasons(qualityAssessment, innerBounds);

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
    normalizedColorBounds,
    normalizedProfileBounds,
    autoCardBounds,
    manualGuideOverride,
    manualGuideBounds,
    manualGuideOverrideApplied: !!manualGuideBounds,
    cardBounds: sourceCardBounds,
    cropBounds: selectedSourceCardBounds,
    perspectiveQuad,
    normalizedMappedCardBounds,
    normalizedDetectedCardBounds,
    normalizedCardBounds,
    normalizedBorderConfidence,
    innerBounds,
    surfaceFinishMode,
    qualityAssessment,
    confidenceCeiling,
    unscorableReasons,
    psaStyle: {
      centering: centering
        ? {
          lr: centering.lr.ratio,
          tb: centering.tb.ratio,
          centeringCap: centering.gradeCap
        }
        : {
          unavailable: true,
          reason: 'Inner border-to-art transition was not detected reliably for scoring.'
        },
      centeringPreview: {
        lr: centeringPreview.lr.ratio,
        tb: centeringPreview.tb.ratio,
        centeringCap: centeringPreview.gradeCap
      }
    }
  };

  if (mode === 'prepare') {
    const previewCenteringCap = centering?.gradeCap ?? { gradeLabel: 'PR 1', psaNumeric: 1 };
    const previewCap = finalGradeFromCaps(previewCenteringCap, confidenceCeiling.cap);
    const previewCentering = centering ?? centeringPreview;
    const result: GradeResult = {
      centering: previewCentering,
      final: {
        unscorable: false,
        gradeLabel: previewCap.gradeLabel,
        psaNumeric: previewCap.psaNumeric,
        confidence: qualityAssessment.imageQualityScore
      },
      report: buildStructuredGradeReport({
        imageName: file.name,
        quality: qualityAssessment,
        centering: previewCentering,
        flaws: undefined,
        confidenceCeiling,
        finalGradeLabel: previewCap.gradeLabel,
        finalGradeNumeric: previewCap.psaNumeric,
        confidence: qualityAssessment.imageQualityScore,
        assumptions: [
          'Front image only.',
          'Standard card size assumed as 6.4cm x 8.9cm when converting normalized pixel distances.',
          'Preview mode estimates centering and observability only; visible defect scoring is deferred until grading.'
        ],
        limitations: [
          'Back-side defects are intentionally excluded.',
          'Manual guide adjustment may still be needed before grading.',
          ...(centering ? [] : ['Inner border detection is currently low confidence; preview centering uses a conservative fallback guide.'])
        ]
      }),
      debug: baseDebug
    };
    return { result };
  }

  const flaws = detectCanvasPsaStyleFlaws(
    normalizedPx,
    normalizedWidth,
    normalizedHeight,
    normalizedCardBounds,
    innerBounds,
    surfaceFinishMode
  );
  const centeringCap = centering?.gradeCap ?? { gradeLabel: 'PR 1', psaNumeric: 1 };
  const centeringAndFlawCap = finalGradeFromCaps(centeringCap, flaws.gradeCap);
  const finalCap = finalGradeFromCaps(centeringAndFlawCap, confidenceCeiling.cap);
  const confidence = clamp01((computeCanvasConfidence(
    flaws.debug.blurVariance,
    flaws.debug.meanLuma,
    flaws.debug.stdLuma,
    !!innerBounds
  ) * 0.55) + (qualityAssessment.imageQualityScore * 0.45));
  const unscorable = unscorableReasons.length > 0;
  const gradedLabel = unscorable ? 'UNSCORABLE' : finalCap.gradeLabel;
  const gradedNumeric = unscorable ? 0 : finalCap.psaNumeric;

  const result: GradeResult = {
    centering,
    flaws: {
      totalPoints: flaws.totalPoints,
      effectivePoints: flaws.effectivePoints,
      condition: flaws.condition,
      pointCondition: flaws.pointCondition,
      matrixCondition: flaws.matrixCondition,
      psaProfile: flaws.psaProfile,
      limitingFlaws: flaws.limitingFlaws,
      gradeCap: flaws.gradeCap,
      items: flaws.items,
      detectedFindings: flaws.detectedFindings,
      cornerFindings: flaws.cornerFindings,
      edgeFindings: flaws.edgeFindings,
      surfaceFindings: flaws.surfaceFindings,
      shapeFindings: flaws.shapeFindings,
      notReliablyObservable: flaws.notReliablyObservable
    },
    final: {
      unscorable,
      unscorableReasons: unscorable ? unscorableReasons : undefined,
      gradeLabel: gradedLabel,
      psaNumeric: gradedNumeric,
      confidence
    },
    report: buildStructuredGradeReport({
      imageName: file.name,
      quality: qualityAssessment,
      centering,
      flaws: {
        totalPoints: flaws.totalPoints,
        effectivePoints: flaws.effectivePoints,
        condition: flaws.condition,
        pointCondition: flaws.pointCondition,
        matrixCondition: flaws.matrixCondition,
        psaProfile: flaws.psaProfile,
        limitingFlaws: flaws.limitingFlaws,
        gradeCap: flaws.gradeCap,
        items: flaws.items,
        detectedFindings: flaws.detectedFindings,
        cornerFindings: flaws.cornerFindings,
        edgeFindings: flaws.edgeFindings,
        surfaceFindings: flaws.surfaceFindings,
        shapeFindings: flaws.shapeFindings,
        notReliablyObservable: flaws.notReliablyObservable
      },
      confidenceCeiling,
      finalGradeLabel: gradedLabel,
      finalGradeNumeric: gradedNumeric,
      confidence,
      assumptions: [
        'Front image only.',
        'Standard card size assumed as 6.4cm x 8.9cm for normalized conversions.',
        'Visible defect thresholds are heuristic proxies derived from the supplied rubric.'
      ],
      limitations: [
        'This is a conservative automated pre-grade, not an official grading outcome.',
        'Glare, blur, and crop quality can materially change the estimate.',
        ...(unscorable ? ['One or more required front-image grading prerequisites were not met.'] : [])
      ]
    }),
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
        flawDebug: flaws.debug,
        finalCaps: {
          centering: centeringCap,
          visibleDefect: flaws.gradeCap,
          confidence: confidenceCeiling.cap,
          final: finalCap
        }
      }
    }
  };

  const overlayCanvas = createProcessingCanvas(normalizedWidth, normalizedHeight);
  const overlayCtx = overlayCanvas.getContext('2d');
  if (!overlayCtx) throw new Error('Canvas 2D not available');
  const overlayCentering = centering ?? centeringPreview;

  renderMeasurementOverlay(
    overlayCtx,
    normalizedWidth,
    normalizedHeight,
    normalizedCardBounds,
    innerBounds,
    overlayCentering,
    result,
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

export type ContentBounds = { minX: number; minY: number; maxX: number; maxY: number; };

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

function resolveManualGuideOverrideBounds(
  override: ManualGuideOverride | null | undefined,
  targetWidth: number,
  targetHeight: number
): {
  cardBounds: ContentBounds;
  innerBounds: ContentBounds;
  sourceSize: { w: number; h: number };
  normalization: ManualImageNormalization | null;
} | null {
  if (!override) return null;
  const sourceW = Number(override.sourceSize?.w);
  const sourceH = Number(override.sourceSize?.h);
  if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW <= 2 || sourceH <= 2) return null;

  const cardBounds = scaleGuideRectToBounds(override.cardRect, sourceW, sourceH, targetWidth, targetHeight);
  const innerBoundsRaw = scaleGuideRectToBounds(override.innerRect, sourceW, sourceH, targetWidth, targetHeight);
  if (!cardBounds || !innerBoundsRaw) return null;

  return {
    cardBounds,
    innerBounds: clampInnerBoundsToCardBounds(innerBoundsRaw, cardBounds),
    sourceSize: { w: sourceW, h: sourceH },
    normalization: scaleManualImageNormalization(override.normalization, sourceW, sourceH, targetWidth, targetHeight)
  };
}

function scaleGuideRectToBounds(
  rect: GuideRect | null | undefined,
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number
): ContentBounds | null {
  if (!rect) return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return null;
  if (w <= 1 || h <= 1) return null;

  const minX = clampInt((x / Math.max(1, sourceW)) * targetW, 0, Math.max(0, targetW - 2));
  const minY = clampInt((y / Math.max(1, sourceH)) * targetH, 0, Math.max(0, targetH - 2));
  const maxX = clampInt((((x + w) / Math.max(1, sourceW)) * targetW) - 1, minX + 1, Math.max(1, targetW - 1));
  const maxY = clampInt((((y + h) / Math.max(1, sourceH)) * targetH) - 1, minY + 1, Math.max(1, targetH - 1));
  return { minX, minY, maxX, maxY };
}

function scaleManualImageNormalization(
  normalization: ManualImageNormalization | null | undefined,
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number
): ManualImageNormalization | null {
  if (!normalization) return null;
  const clamped = clampManualImageNormalization(normalization);
  const anchor = clamped.anchor
    ? {
      x: clampFloat((clamped.anchor.x / Math.max(1, sourceW)) * targetW, 0, Math.max(0, targetW)),
      y: clampFloat((clamped.anchor.y / Math.max(1, sourceH)) * targetH, 0, Math.max(0, targetH))
    }
    : null;
  return {
    ...clamped,
    anchor
  };
}

function clampInnerBoundsToCardBounds(innerBounds: ContentBounds, cardBounds: ContentBounds): ContentBounds {
  const minX = clampInt(innerBounds.minX, cardBounds.minX, Math.max(cardBounds.minX, cardBounds.maxX - 1));
  const minY = clampInt(innerBounds.minY, cardBounds.minY, Math.max(cardBounds.minY, cardBounds.maxY - 1));
  const maxX = clampInt(innerBounds.maxX, minX + 1, cardBounds.maxX);
  const maxY = clampInt(innerBounds.maxY, minY + 1, cardBounds.maxY);
  return { minX, minY, maxX, maxY };
}

function applyManualImageNormalizationToCanvas(
  canvas: ProcessingCanvas,
  width: number,
  height: number,
  normalization: ManualImageNormalization
): void {
  if (isIdentityNormalization(normalization)) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');

  const transform = buildFittedImageTransform({ w: width, h: height }, normalization);
  const anchor = normalization.anchor ?? { x: width / 2, y: height / 2 };
  const snapshot = createProcessingCanvas(width, height);
  const snapshotCtx = snapshot.getContext('2d');
  if (!snapshotCtx) throw new Error('Canvas 2D not available');
  snapshotCtx.drawImage(canvas as CanvasImageSource, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.translate(anchor.x, anchor.y);
  ctx.transform(transform.a, transform.b, transform.c, transform.d, 0, 0);
  ctx.translate(-anchor.x, -anchor.y);
  ctx.drawImage(snapshot as CanvasImageSource, 0, 0);
  ctx.restore();
}

type OverlayContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function renderMeasurementOverlay(
  ctx: OverlayContext2D,
  width: number,
  height: number,
  cardBounds: ContentBounds,
  innerBounds: ContentBounds | null,
  centering: CenteringResult,
  result: GradeResult,
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
  drawFindingHighlights(ctx, result);
  drawCenteringSummary(ctx, cardBounds, centering, result, normalizationMethod);
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
  result: GradeResult,
  normalizationMethod: 'opencv_perspective' | 'crop_scale'
): void {
  const cardWidthPx = Math.max(1, cardBounds.maxX - cardBounds.minX + 1);
  const cardHeightPx = Math.max(1, cardBounds.maxY - cardBounds.minY + 1);
  const leftMm = pxToMillimeters(centering.debug.border.leftPx, cardWidthPx, TUNING.cardWidthCm * 10);
  const rightMm = pxToMillimeters(centering.debug.border.rightPx, cardWidthPx, TUNING.cardWidthCm * 10);
  const topMm = pxToMillimeters(centering.debug.border.topPx, cardHeightPx, TUNING.cardHeightCm * 10);
  const bottomMm = pxToMillimeters(centering.debug.border.bottomPx, cardHeightPx, TUNING.cardHeightCm * 10);

  const boxX = clampInt(cardBounds.minX + 12, 8, Math.max(8, cardBounds.maxX - 280));
  const boxY = clampInt(cardBounds.minY + 12, 8, Math.max(8, cardBounds.maxY - 128));
  const boxW = Math.min(272, Math.max(180, cardBounds.maxX - cardBounds.minX - 24));
  const boxH = 120;
  const flawPoints = result.flaws?.effectivePoints ?? result.flaws?.totalPoints ?? 0;
  const confidence = result.final.confidence;
  const majorIssues = result.report?.topReasons?.slice(0, 2)?.join(' | ') ?? 'No major issues above threshold.';

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
  ctx.fillText(`Grade ${result.final.gradeLabel}  |  Flaw pts ${flawPoints}  |  ${normalizationMethod}`, boxX + 10, boxY + 74);
  ctx.fillText(`Confidence ${confidence.toFixed(2)}  |  Review ${result.report?.manualReviewRequired ? 'YES' : 'NO'}`, boxX + 10, boxY + 92);
  ctx.font = '11px sans-serif';
  wrapOverlayText(ctx, `Issues: ${majorIssues}`, boxX + 10, boxY + 108, boxW - 18, 12, 2);
  ctx.restore();
}

function drawFindingHighlights(ctx: OverlayContext2D, result: GradeResult): void {
  const findings = (result.report?.detectedDefects ?? [])
    .filter((finding) => finding.observability === 'observed' && finding.region)
    .sort((a, b) => findingSeverityRank(b.severity) - findingSeverityRank(a.severity))
    .slice(0, 6);

  findings.forEach((finding) => {
    if (!finding.region) return;
    const color = finding.severity === 'major'
      ? 'rgba(239, 68, 68, 0.95)'
      : finding.severity === 'moderate'
        ? 'rgba(249, 115, 22, 0.95)'
        : finding.severity === 'minor'
          ? 'rgba(245, 158, 11, 0.95)'
          : 'rgba(250, 204, 21, 0.95)';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color.replace('0.95', '0.12');
    ctx.lineWidth = 2;
    ctx.fillRect(finding.region.x, finding.region.y, finding.region.w, finding.region.h);
    ctx.strokeRect(finding.region.x + 0.5, finding.region.y + 0.5, finding.region.w - 1, finding.region.h - 1);
    ctx.font = '600 11px sans-serif';
    const label = `${finding.flawType} (${finding.severity})`;
    const labelWidth = Math.min(Math.max(76, ctx.measureText(label).width + 10), 180);
    const labelX = clampInt(finding.region.x, 2, Math.max(2, finding.region.x + finding.region.w - labelWidth));
    const labelY = clampInt(finding.region.y - 16, 2, Math.max(2, finding.region.y));
    ctx.fillStyle = 'rgba(17, 24, 39, 0.82)';
    ctx.fillRect(labelX, labelY, labelWidth, 14);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(label, labelX + 5, labelY + 10);
    ctx.restore();
  });
}

function wrapOverlayText(
  ctx: OverlayContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
): void {
  const words = text.split(/\s+/);
  let line = '';
  let lineIndex = 0;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
      continue;
    }

    ctx.fillText(line, x, y + (lineIndex * lineHeight));
    line = word;
    lineIndex++;
    if (lineIndex >= maxLines) return;
  }

  if (lineIndex < maxLines && line) {
    ctx.fillText(line, x, y + (lineIndex * lineHeight));
  }
}

function pxToMillimeters(px: number, axisPx: number, physicalMm: number): number {
  return (px / Math.max(1, axisPx)) * physicalMm;
}

export function fitBoundsToAspect(
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

export function chooseBestCardBounds(
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

type BorderConfidenceAssessment = {
  confidence: number; // 0..1, higher is better
  severity: 'none' | 'low' | 'moderate' | 'high';
  metric: string;
  note: string;
  expectedBounds: ContentBounds | null;
  detectedBounds: ContentBounds | null;
  overlap: number | null;
  areaRatio: number | null;
  expectedTouchesFrame: boolean;
  detectedTouchesFrame: boolean;
};

function manualGuideBorderConfidence(
  mappedBounds: ContentBounds,
  width: number,
  height: number
): BorderConfidenceAssessment {
  const touchesFrame = touchesFrameBounds(mappedBounds, width, height, 2);
  return {
    confidence: 1,
    severity: 'none',
    metric: `manual guide override, touches frame ${touchesFrame ? 'YES' : 'NO'}`,
    note: 'Using user-adjusted overlay guides as the authoritative card and inner-frame boundaries.',
    expectedBounds: mappedBounds,
    detectedBounds: mappedBounds,
    overlap: 1,
    areaRatio: 1,
    expectedTouchesFrame: touchesFrame,
    detectedTouchesFrame: touchesFrame
  };
}

function assessNormalizedBorderConfidence(args: {
  normalizationMethod: 'opencv_perspective' | 'crop_scale';
  width: number;
  height: number;
  expectedBounds: ContentBounds | null;
  detectedBounds: ContentBounds | null;
}): BorderConfidenceAssessment {
  const {
    normalizationMethod,
    width,
    height,
    expectedBounds,
    detectedBounds
  } = args;
  const expectedTouchesFrame = touchesFrameBounds(expectedBounds, width, height, 2);
  const detectedTouchesFrame = touchesFrameBounds(detectedBounds, width, height, 2);
  const overlap = expectedBounds && detectedBounds
    ? overlapFraction(expectedBounds, detectedBounds)
    : null;
  const areaRatio = expectedBounds && detectedBounds
    ? boundsArea(detectedBounds) / Math.max(1, boundsArea(expectedBounds))
    : null;

  let penalty = 0;

  if (!detectedBounds) {
    penalty += normalizationMethod === 'crop_scale' ? 0.65 : 0.35;
  } else if (overlap != null && areaRatio != null) {
    if (overlap < 0.60) penalty += 0.52;
    else if (overlap < 0.72) penalty += 0.36;
    else if (overlap < 0.84) penalty += 0.18;
    else if (overlap < 0.90) penalty += 0.08;

    if (areaRatio < 0.72 || areaRatio > 1.34) penalty += 0.42;
    else if (areaRatio < 0.84 || areaRatio > 1.20) penalty += 0.22;
    else if (areaRatio < 0.92 || areaRatio > 1.12) penalty += 0.08;
  }

  if (normalizationMethod === 'crop_scale' && detectedTouchesFrame && !expectedTouchesFrame) {
    // Detected outer border touching normalized frame is a strong clipping warning.
    penalty += 0.35;
  }
  if (normalizationMethod === 'opencv_perspective' && expectedTouchesFrame && !detectedTouchesFrame) {
    // When perspective output should fill the frame but detected borders sit inward, edge mapping is suspect.
    penalty += 0.28;
  }

  const confidence = clamp01(1 - penalty);
  const severity: BorderConfidenceAssessment['severity'] =
    confidence < 0.50 ? 'high'
      : confidence < 0.66 ? 'moderate'
        : confidence < 0.80 ? 'low'
          : 'none';

  const metric = [
    `confidence ${(confidence * 100).toFixed(0)}%`,
    `overlap ${overlap == null ? 'n/a' : `${(overlap * 100).toFixed(1)}%`}`,
    `area ratio ${areaRatio == null ? 'n/a' : areaRatio.toFixed(2)}`,
    `detected touches frame ${detectedTouchesFrame ? 'YES' : 'NO'}`
  ].join(', ');

  const note = severity === 'high'
    ? 'Detected outer-border geometry is inconsistent with the normalized card bounds; centering and border-based scoring are unsafe.'
    : severity === 'moderate'
      ? 'Outer-border confidence is reduced; centering may be biased.'
      : severity === 'low'
        ? 'Outer-border fit is mostly consistent, with minor mismatch.'
        : 'Outer-border fit is consistent with normalized card bounds.';

  return {
    confidence,
    severity,
    metric,
    note,
    expectedBounds,
    detectedBounds,
    overlap,
    areaRatio,
    expectedTouchesFrame,
    detectedTouchesFrame
  };
}

function boundsArea(bounds: ContentBounds): number {
  return Math.max(1, (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1));
}

function touchesFrameBounds(
  bounds: ContentBounds | null,
  width: number,
  height: number,
  pad: number
): boolean {
  if (!bounds) return true;
  return (
    bounds.minX <= pad
    || bounds.minY <= pad
    || bounds.maxX >= width - 1 - pad
    || bounds.maxY >= height - 1 - pad
  );
}

function detectInnerContentBounds(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  cardBounds: ContentBounds | null
): ContentBounds | null {
  // Centering is measured from the outer card edge to the first stable inner design/frame boundary.
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
    .map((y) => detectInnerEdgeDistanceForSample(px, width, base, y, 'left', maxBorderX, minInsetX))
    .filter((v): v is number => v != null);
  const rightBorders = ySamples
    .map((y) => detectInnerEdgeDistanceForSample(px, width, base, y, 'right', maxBorderX, minInsetX))
    .filter((v): v is number => v != null);
  const topBorders = xSamples
    .map((x) => detectInnerEdgeDistanceForSample(px, width, base, x, 'top', maxBorderY, minInsetY))
    .filter((v): v is number => v != null);
  const bottomBorders = xSamples
    .map((x) => detectInnerEdgeDistanceForSample(px, width, base, x, 'bottom', maxBorderY, minInsetY))
    .filter((v): v is number => v != null);

  const leftBorder = robustBorderDistance(leftBorders, ySamples.length, maxBorderX);
  const rightBorder = robustBorderDistance(rightBorders, ySamples.length, maxBorderX);
  const topBorder = robustBorderDistance(topBorders, xSamples.length, maxBorderY);
  const bottomBorder = robustBorderDistance(bottomBorders, xSamples.length, maxBorderY);

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

function scanBorderTransitionByGradient(
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

  const smoothLuma = smoothProfile(samples.map((sample) => sample.luma), 2);
  const grad = new Array<number>(samples.length).fill(0);
  for (let i = 1; i < samples.length; i++) {
    grad[i] = Math.abs(smoothLuma[i] - smoothLuma[i - 1]);
  }

  const referenceCount = clampInt(Math.round(samples.length * 0.2), 4, Math.max(4, Math.min(14, samples.length - 4)));
  if (referenceCount >= samples.length - 3) return null;

  const baseGradNoise = averageNumber(grad.slice(1, referenceCount));
  const edgeThreshold = Math.max(5, baseGradNoise * 2.6 + 3);
  const minContrast = Math.max(4, edgeThreshold * 0.5);

  let bestIndex: number | null = null;
  let bestScore = 0;

  for (let i = referenceCount; i <= samples.length - 4; i++) {
    const localGrad = grad[i];
    if (localGrad < edgeThreshold * 0.8) continue;

    const beforeStart = Math.max(0, i - 3);
    const beforeEnd = i;
    const afterStart = i + 1;
    const afterEnd = Math.min(samples.length, i + 4);
    if (beforeEnd - beforeStart < 2 || afterEnd - afterStart < 2) continue;

    const beforeMean = averageNumber(smoothLuma.slice(beforeStart, beforeEnd));
    const afterMean = averageNumber(smoothLuma.slice(afterStart, afterEnd));
    const contrast = Math.abs(afterMean - beforeMean);
    const localEnergy = averageNumber(grad.slice(i, Math.min(samples.length, i + 3)));
    if (contrast < minContrast && localGrad < edgeThreshold) continue;

    const score = (localGrad * 0.6) + (localEnergy * 0.25) + (contrast * 0.45);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex == null ? null : samples[bestIndex].distanceFromEdge;
}

function detectInnerEdgeDistanceForSample(
  px: Uint8ClampedArray,
  width: number,
  bounds: ContentBounds,
  fixedCoord: number,
  side: 'left' | 'right' | 'top' | 'bottom',
  maxBorder: number,
  minInset: number
): number | null {
  const colorCandidate = scanBorderTransition(px, width, bounds, fixedCoord, side, maxBorder, minInset);
  const gradientCandidate = scanBorderTransitionByGradient(px, width, bounds, fixedCoord, side, maxBorder, minInset);
  if (colorCandidate == null && gradientCandidate == null) return null;
  if (colorCandidate == null) return gradientCandidate;
  if (gradientCandidate == null) return colorCandidate;

  const diff = Math.abs(colorCandidate - gradientCandidate);
  if (diff <= 3) return (colorCandidate + gradientCandidate) / 2;

  // For centering, prefer the first strong border->design transition from the outer edge inward.
  return Math.min(colorCandidate, gradientCandidate);
}

function robustBorderDistance(values: number[], expectedSampleCount: number, maxBorder: number): number | null {
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  const minSupport = Math.max(6, Math.floor(expectedSampleCount * 0.42));
  if (sorted.length < minSupport) return null;

  const windowSize = Math.max(4, Math.ceil(sorted.length * 0.58));
  if (sorted.length <= windowSize) {
    const span = sorted[sorted.length - 1] - sorted[0];
    const spanFrac = span / Math.max(1, maxBorder);
    if (spanFrac > 0.28) return null;
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

  const clustered = sorted.slice(bestStart, bestStart + windowSize);
  const support = clustered.length / Math.max(1, expectedSampleCount);
  const span = clustered[clustered.length - 1] - clustered[0];
  const spanFrac = span / Math.max(1, maxBorder);
  if (support < 0.38 || spanFrac > 0.28) return null;
  return medianOfSorted(clustered);
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

export function buildCanvasCentering(
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
      innerRect: { x: minX, y: minY, w: Math.max(1, maxX - minX + 1), h: Math.max(1, maxY - minY + 1) }
    }
  };
}

export function severityToFindingSeverity(severity: Severity | Exclude<Severity, 'NONE'>): FindingSeverity {
  switch (severity) {
    case 'Slight':
      return 'slight';
    case 'Minor':
      return 'minor';
    case 'Moderate':
      return 'moderate';
    case 'Major':
      return 'major';
    default:
      return 'none';
  }
}

function findingEvidenceFromSeverity(severity: FindingSeverity): EvidenceStrength {
  switch (severity) {
    case 'major':
    case 'moderate':
      return 'high';
    case 'minor':
      return 'medium';
    case 'slight':
      return 'low';
    default:
      return 'low';
  }
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case 'Major':
      return 4;
    case 'Moderate':
      return 3;
    case 'Minor':
      return 2;
    case 'Slight':
      return 1;
    default:
      return 0;
  }
}

function worseSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function downgradeSeverity(severity: Severity): Severity {
  switch (severity) {
    case 'Major':
      return 'Moderate';
    case 'Moderate':
      return 'Minor';
    case 'Minor':
      return 'Slight';
    default:
      return 'NONE';
  }
}

function severityFromThresholds(
  value: number,
  thresholds: {
    slight: number;
    minor?: number;
    moderate?: number;
    major?: number;
  }
): Severity {
  if (!Number.isFinite(value) || value <= 0) return 'NONE';
  if (thresholds.major != null && value >= thresholds.major) return 'Major';
  if (thresholds.moderate != null && value >= thresholds.moderate) return 'Moderate';
  if (thresholds.minor != null && value >= thresholds.minor) return 'Minor';
  return value >= thresholds.slight ? 'Slight' : 'NONE';
}

function combineDetectedSeverity(
  scoreSeverity: Severity,
  measuredSeverity: Severity,
  evidenceStrength: EvidenceStrength
): Severity {
  const combined = measuredSeverity === 'NONE'
    ? scoreSeverity
    : worseSeverity(scoreSeverity, measuredSeverity);

  if (measuredSeverity !== 'NONE') return combined;
  if (evidenceStrength === 'low') return downgradeSeverity(combined);
  if (evidenceStrength === 'medium' && combined === 'Slight') return 'NONE';
  return combined;
}

function boundsAreaPx(bounds: ContentBounds): number {
  return Math.max(1, bounds.maxX - bounds.minX + 1) * Math.max(1, bounds.maxY - bounds.minY + 1);
}

function totalBoundsAreaPx<T extends { bounds: ContentBounds }>(items: readonly T[]): number {
  return items.reduce((sum, item) => sum + boundsAreaPx(item.bounds), 0);
}

function largestBoundsAreaPx<T extends { bounds: ContentBounds }>(items: readonly T[]): number {
  return items.reduce((largest, item) => Math.max(largest, boundsAreaPx(item.bounds)), 0);
}

function totalInteriorHotspotLengthPx(hotspots: readonly InteriorHotspot[]): number {
  return hotspots.reduce((sum, hotspot) => (
    sum + Math.max(
      hotspot.bounds.maxX - hotspot.bounds.minX + 1,
      hotspot.bounds.maxY - hotspot.bounds.minY + 1
    )
  ), 0);
}

function uniqueBorderSides(hotspots: readonly BorderHotspot[]): BorderHotspot['side'][] {
  return [...new Set(hotspots.map((hotspot) => hotspot.side))];
}

function describeAffectedSides(sides: readonly BorderHotspot['side'][]): string {
  if (sides.length === 0) return 'perimeter';
  if (sides.length === 1) return `${sides[0]} edge`;
  if (sides.length === 2) return `${sides[0]} + ${sides[1]} edges`;
  return 'multiple edges';
}

function describeAffectedCorners(corners: readonly CornerHotspot[]): string {
  if (corners.length === 0) return 'corner region';
  if (corners.length === 1) return corners[0].name;
  return `${corners.length} corners`;
}

function downgradeSeverityBySteps(severity: Severity, steps: number): Severity {
  let current = severity;
  for (let index = 0; index < steps; index++) {
    current = downgradeSeverity(current);
    if (current === 'NONE') break;
  }
  return current;
}

function countHotspotQuadrants(
  hotspots: readonly { bounds: ContentBounds }[],
  region: ContentBounds
): number {
  if (hotspots.length === 0) return 0;
  const centerX = (region.minX + region.maxX) * 0.5;
  const centerY = (region.minY + region.maxY) * 0.5;
  const quadrants = new Set<string>();
  for (const hotspot of hotspots) {
    const x = (hotspot.bounds.minX + hotspot.bounds.maxX) * 0.5 <= centerX ? 'L' : 'R';
    const y = (hotspot.bounds.minY + hotspot.bounds.maxY) * 0.5 <= centerY ? 'T' : 'B';
    quadrants.add(`${y}${x}`);
  }
  return quadrants.size;
}

function buildSurfaceFinishProfile(args: {
  mode: SurfaceFinishMode;
  interiorStats: { anomalyPerK: number; strongPerK: number; linearPerK: number; hotspots: InteriorHotspot[] };
  scuffHotspots: InteriorHotspot[];
  interiorRegion: ContentBounds;
  scuffHotspotCoveragePct: number;
  borderStats: { toneSpread: number; outlierPct: number };
  borderHotspotCoveragePct: number;
  borderSideCount: number;
}): SurfaceFinishProfile {
  const {
    mode,
    interiorStats,
    scuffHotspots,
    interiorRegion,
    scuffHotspotCoveragePct,
    borderStats,
    borderHotspotCoveragePct,
    borderSideCount
  } = args;

  const anomalyPerK = Math.max(0, interiorStats.anomalyPerK);
  const linearityRatio = interiorStats.linearPerK / Math.max(1, anomalyPerK);
  const strongRatio = interiorStats.strongPerK / Math.max(1, anomalyPerK);
  const scuffClusterSet = scuffHotspots.length ? scuffHotspots : interiorStats.hotspots;
  const interiorHotspotQuadrants = countHotspotQuadrants(scuffClusterSet, interiorRegion);
  const totalScuffAreaPx = totalBoundsAreaPx(scuffClusterSet);
  const dominantScuffHotspotShare = totalScuffAreaPx > 0
    ? largestBoundsAreaPx(scuffClusterSet) / totalScuffAreaPx
    : 1;

  if (mode !== 'textured') {
    return {
      mode,
      interiorTextureConfidence: 0,
      borderTextureConfidence: 0,
      overallConfidence: 0,
      interiorHotspotQuadrants,
      scuffHotspotCoveragePct,
      dominantScuffHotspotShare,
      linearityRatio,
      strongRatio,
      notes: []
    };
  }

  const interiorTextureConfidence = clamp01(
    clamp01((anomalyPerK - 140) / 180) * 0.24
    + clamp01(scuffHotspotCoveragePct / 8) * 0.22
    + clamp01((interiorHotspotQuadrants - 1) / 3) * 0.2
    + clamp01((0.35 - linearityRatio) / 0.35) * 0.18
    + clamp01((0.72 - strongRatio) / 0.72) * 0.08
    + clamp01((0.7 - dominantScuffHotspotShare) / 0.7) * 0.08
  );
  const borderTextureConfidence = clamp01(
    clamp01((borderStats.toneSpread - 18) / 18) * 0.38
    + clamp01((borderSideCount - 1) / 3) * 0.24
    + clamp01(borderHotspotCoveragePct / 5) * 0.2
    + clamp01((borderStats.outlierPct - 8) / 24) * 0.18
  );

  const notes: string[] = [];
  if (interiorTextureConfidence >= 0.45) {
    notes.push('Broad interior variation matches a decorative holographic/embossed finish more than localized surface damage.');
  }
  if (borderTextureConfidence >= 0.45) {
    notes.push('Border variation is broad enough to be treated like textured finish stock rather than isolated surface wear.');
  }

  return {
    mode,
    interiorTextureConfidence,
    borderTextureConfidence,
    overallConfidence: Math.max(interiorTextureConfidence, borderTextureConfidence),
    interiorHotspotQuadrants,
    scuffHotspotCoveragePct,
    dominantScuffHotspotShare,
    linearityRatio,
    strongRatio,
    notes
  };
}

function pxLengthToCm(pxLength: number, axisPx: number, physicalCm: number): number {
  return (pxLength / Math.max(1, axisPx)) * physicalCm;
}

function pxAreaToCm2(pxArea: number, cardWidthPx: number, cardHeightPx: number): number {
  const cmPerPxX = TUNING.cardWidthCm / Math.max(1, cardWidthPx);
  const cmPerPxY = TUNING.cardHeightCm / Math.max(1, cardHeightPx);
  return pxArea * cmPerPxX * cmPerPxY;
}

function pxAreaToMm2(pxArea: number, cardWidthPx: number, cardHeightPx: number): number {
  return pxAreaToCm2(pxArea, cardWidthPx, cardHeightPx) * 100;
}

function toFindingRegion(bounds: ContentBounds, width: number, height: number): FindingRegion {
  return {
    x: bounds.minX,
    y: bounds.minY,
    w: Math.max(1, bounds.maxX - bounds.minX + 1),
    h: Math.max(1, bounds.maxY - bounds.minY + 1),
    normalized: {
      x: bounds.minX / Math.max(1, width),
      y: bounds.minY / Math.max(1, height),
      w: Math.max(1, bounds.maxX - bounds.minX + 1) / Math.max(1, width),
      h: Math.max(1, bounds.maxY - bounds.minY + 1) / Math.max(1, height)
    }
  };
}

function formatLengthCm(value: number): string {
  return `${value.toFixed(2)}cm`;
}

function formatAreaCm2(value: number): string {
  return `${value.toFixed(2)}cm²`;
}

function formatAreaMm2(value: number): string {
  return `${value.toFixed(2)}mm²`;
}

function confidenceBandFromScore(confidence: number): 'low' | 'medium' | 'high' {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.45) return 'medium';
  return 'low';
}

function gradeCapReason(source: GradeCeilingAssessment['source'], cap: GradeCap, detail: string): GradeCeilingAssessment {
  return {
    source,
    cap,
    reason: `${cap.gradeLabel}: ${detail}`
  };
}

function summarizeFinding(findings: DetectedFinding[]): string[] {
  return findings
    .filter((finding) => finding.observability === 'observed')
    .sort((a, b) => findingSeverityRank(b.severity) - findingSeverityRank(a.severity))
    .slice(0, 3)
    .map((finding) => `${finding.flawType} at ${finding.location} (${finding.severity})`);
}

function findingSeverityRank(severity: FindingSeverity): number {
  switch (severity) {
    case 'major':
      return 4;
    case 'moderate':
      return 3;
    case 'minor':
      return 2;
    case 'slight':
      return 1;
    default:
      return 0;
  }
}

function describeBoundsLocation(bounds: ContentBounds, width: number, height: number): string {
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerY = (bounds.minY + bounds.maxY) * 0.5;
  const horizontal = centerX < width * 0.33 ? 'left' : centerX > width * 0.67 ? 'right' : 'center';
  const vertical = centerY < height * 0.33 ? 'top' : centerY > height * 0.67 ? 'bottom' : 'center';
  if (horizontal === 'center' && vertical === 'center') return 'center';
  if (horizontal === 'center') return vertical;
  if (vertical === 'center') return horizontal;
  return `${vertical}-${horizontal}`;
}

type InteriorHotspot = {
  bounds: ContentBounds;
  sampleCount: number;
  strongCount: number;
  linearCount: number;
  maxSignal: number;
  kind: 'scratch' | 'scuffing';
};

type BorderHotspot = {
  bounds: ContentBounds;
  side: 'left' | 'right' | 'top' | 'bottom';
  deviation: number;
  outlierPct: number;
};

type CornerHotspot = {
  name: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  bounds: ContentBounds;
  meanDelta: number;
  outlierPct: number;
  score: number;
};

type SurfaceFinishProfile = {
  mode: SurfaceFinishMode;
  interiorTextureConfidence: number;
  borderTextureConfidence: number;
  overallConfidence: number;
  interiorHotspotQuadrants: number;
  scuffHotspotCoveragePct: number;
  dominantScuffHotspotShare: number;
  linearityRatio: number;
  strongRatio: number;
  notes: string[];
};

export function detectCanvasPsaStyleFlaws(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null,
  innerBounds: ContentBounds | null,
  surfaceFinishMode: SurfaceFinishMode = 'standard'
): {
  totalPoints: number;
  effectivePoints: number;
  condition: string;
  pointCondition: TcgCondition;
  matrixCondition: TcgCondition;
  psaProfile: string;
  limitingFlaws: Array<{
    category: FlawCategory;
    severity: Exclude<Severity, 'NONE'>;
    condition: TcgCondition;
  }>;
  gradeCap: GradeCap;
  items: FlawItem[];
  detectedFindings: DetectedFinding[];
  cornerFindings: DetectedFinding[];
  edgeFindings: DetectedFinding[];
  surfaceFindings: DetectedFinding[];
  shapeFindings: DetectedFinding[];
  notReliablyObservable: string[];
  debug: {
    blurVariance: number;
    meanLuma: number;
    stdLuma: number;
    shadowClipFrac: number;
    highlightClipFrac: number;
    borderRoughness: number;
    borderCleanlinessScore: number;
    borderOutlierPct: number;
    borderToneSpread: number;
    edgeWearScore: number;
    edgeWearOutlierPct: number;
    cornerWearScore: number;
    cornerWearOutlierPct: number;
    interiorAnomalyPerK: number;
    interiorStrongPerK: number;
    interiorLinearPerK: number;
    innerMeanLuma: number;
    innerStdLuma: number;
    borderMeanLuma: number;
    borderStdLuma: number;
    agingPenalty: number;
    cleanSceneBonus: number;
    scuffScore: number;
    scratchScore: number;
    toneClippingPct: number;
    surfaceFinishMode: SurfaceFinishMode;
    surfaceFinishProfile: {
      interiorTextureConfidence: number;
      borderTextureConfidence: number;
      overallConfidence: number;
      interiorHotspotQuadrants: number;
      scuffHotspotCoveragePct: number;
      dominantScuffHotspotShare: number;
      linearityRatio: number;
      strongRatio: number;
      notes: string[];
    };
    measuredFeatures: {
      scratchLengthCm: number;
      scuffAreaCm2: number;
      surfaceWearAreaCm2: number;
      edgeWearLengthCm: number;
      scuffHotspotCoveragePct: number;
      borderHotspotCoveragePct: number;
      edgeHotspotCoveragePct: number;
      borderSidesAffected: number;
      cornerHotspotCount: number;
    };
  };
} {
  const stats = computeLumaStats(px, width, height);
  const items: FlawItem[] = [];
  const detectedFindings: DetectedFinding[] = [];
  const borderRoughness = estimateBorderRoughness(px, width, height, bounds);
  const borderStats = analyzeCanvasBorderCleanliness(px, width, height, bounds, innerBounds);
  const wearStats = analyzeCanvasWear(px, width, height, bounds, innerBounds);
  const interiorStats = analyzeCanvasInteriorDisturbance(px, width, height, innerBounds ?? bounds);
  const toneBands = analyzeCanvasToneBands(px, width, height, bounds, innerBounds);
  const borderHotspots = detectBorderHotspots(px, width, height, bounds, innerBounds);
  const cornerHotspots = detectCornerHotspots(px, width, height, bounds, innerBounds);
  const measurementBounds = bounds ?? innerBounds ?? { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  const cardWidthPx = Math.max(1, measurementBounds.maxX - measurementBounds.minX + 1);
  const cardHeightPx = Math.max(1, measurementBounds.maxY - measurementBounds.minY + 1);
  const cardAreaCm2 = TUNING.cardWidthCm * TUNING.cardHeightCm;
  const cardPerimeterCm = 2 * (TUNING.cardWidthCm + TUNING.cardHeightCm);
  const interiorRegion = innerBounds ?? bounds ?? measurementBounds;
  const scratchHotspots = interiorStats.hotspots.filter((hotspot) => hotspot.kind === 'scratch');
  const scuffHotspots = interiorStats.hotspots.filter((hotspot) => hotspot.kind === 'scuffing');
  const scratchLengthPx = totalInteriorHotspotLengthPx(scratchHotspots);
  const scratchLengthCm = pxLengthToCm(
    scratchLengthPx,
    Math.max(cardWidthPx, cardHeightPx),
    Math.max(TUNING.cardWidthCm, TUNING.cardHeightCm)
  );
  const scuffAreaCm2 = pxAreaToCm2(totalBoundsAreaPx(scuffHotspots), cardWidthPx, cardHeightPx);
  const surfaceWearAreaCm2 = pxAreaToCm2(totalBoundsAreaPx(borderHotspots), cardWidthPx, cardHeightPx);
  const edgeWearLengthCm = borderHotspots.reduce((sum, hotspot) => {
    const lengthPx = hotspot.side === 'left' || hotspot.side === 'right'
      ? hotspot.bounds.maxY - hotspot.bounds.minY + 1
      : hotspot.bounds.maxX - hotspot.bounds.minX + 1;
    return sum + (
      hotspot.side === 'left' || hotspot.side === 'right'
        ? pxLengthToCm(lengthPx, cardHeightPx, TUNING.cardHeightCm)
        : pxLengthToCm(lengthPx, cardWidthPx, TUNING.cardWidthCm)
    );
  }, 0);
  const borderSides = uniqueBorderSides(borderHotspots);
  const borderSideCount = borderSides.length;
  const interiorAreaPx = Math.max(1, boundsAreaPx(interiorRegion));
  const scuffHotspotCoveragePct = (totalBoundsAreaPx(scuffHotspots) / interiorAreaPx) * 100;
  const borderHotspotCoveragePct = (surfaceWearAreaCm2 / Math.max(0.001, cardAreaCm2)) * 100;
  const edgeHotspotCoveragePct = (edgeWearLengthCm / Math.max(0.001, cardPerimeterCm)) * 100;
  const finishProfile = buildSurfaceFinishProfile({
    mode: surfaceFinishMode,
    interiorStats,
    scuffHotspots,
    interiorRegion,
    scuffHotspotCoveragePct,
    borderStats: {
      toneSpread: borderStats.toneSpread,
      outlierPct: borderStats.outlierPct
    },
    borderHotspotCoveragePct,
    borderSideCount
  });
  let findingSequence = 0;

  const createObservedFinding = (args: {
    category: FindingCategory;
    flawType: string;
    severity: FindingSeverity;
    metric: string;
    location: string;
    notes: string[];
    measurement?: FindingMeasurement;
    region?: FindingRegion;
    evidenceStrength?: EvidenceStrength;
    count?: number;
  }): DetectedFinding => {
    const finding: DetectedFinding = {
      id: `${args.category}-${findingSequence++}`,
      category: args.category,
      flawType: args.flawType,
      location: args.location,
      severity: args.severity,
      evidenceStrength: args.evidenceStrength ?? findingEvidenceFromSeverity(args.severity),
      observability: 'observed',
      metric: args.metric,
      notes: args.notes,
      measurement: args.measurement,
      count: args.count,
      region: args.region
    };
    detectedFindings.push(finding);
    return finding;
  };

  const addFlawItem = (
    category: FlawCategory,
    severity: Exclude<Severity, 'NONE'>,
    metric: string,
    finding?: DetectedFinding
  ) => {
    items.push({
      category,
      severity,
      points: severityToPoints(severity),
      metric,
      location: finding?.location,
      evidenceStrength: finding?.evidenceStrength,
      observability: finding?.observability === 'observed' ? 'observed' : undefined,
      measurement: finding?.measurement,
      region: finding?.region
    });
  };

  const agingPenalty =
    Math.max(0, 152 - toneBands.innerMeanLuma) * 0.26
    + Math.max(0, toneBands.innerStdLuma - 54) * 0.22
    + Math.max(0, toneBands.borderStdLuma - 70) * 0.14
    + Math.max(0, borderStats.toneSpread - 26) * 0.18;
  const cleanSceneBonus =
    Math.max(0, toneBands.innerMeanLuma - 150) * 0.45
    + Math.max(0, 54 - toneBands.innerStdLuma) * 0.35
    + Math.max(0, 70 - toneBands.borderStdLuma) * 0.18;
  const borderVariationAllowance = 10 + borderStats.toneSpread * 0.22 + finishProfile.borderTextureConfidence * 12;
  const borderOutlierAllowance = Math.max(2.5, borderStats.toneSpread * 0.22 + finishProfile.borderTextureConfidence * 8);
  const normalizedBorderMeanDelta = Math.max(0, borderStats.meanDelta - borderVariationAllowance);
  const normalizedBorderOutlierPct = Math.max(0, borderStats.outlierPct - borderOutlierAllowance);
  const normalizedEdgeMeanDelta = Math.max(0, wearStats.edgeMeanDelta - wearStats.edgeBaseline - 5);
  const normalizedEdgeOutlierPct = Math.max(0, wearStats.edgeOutlierPct - 2);
  const borderSpreadBonus = Math.max(0, borderSideCount - 1) * 3.2;
  const localizedSurfacePenalty = borderSideCount <= 1 ? 6 : 0;
  const surfaceCoverageBonus = Math.max(0, borderHotspotCoveragePct - (1.2 + finishProfile.borderTextureConfidence * 1.6)) * 1.6;
  const borderCleanlinessScore = Math.max(
    0,
    normalizedBorderMeanDelta * 0.82
      + normalizedBorderOutlierPct * 0.72
      + Math.max(0, borderStats.toneSpread - 26) * 0.14
      + agingPenalty * 0.45
      - cleanSceneBonus * 1.25
      + borderSpreadBonus
      + surfaceCoverageBonus
      - localizedSurfacePenalty
  );
  const edgeLocalizationBonus = borderSideCount === 1 ? 4.5 : borderSideCount === 2 ? 2 : 0;
  const edgeCoverageBonus = Math.max(0, edgeHotspotCoveragePct - 6) * 0.28;
  const rawEdgeWearScore = Math.max(
    0,
    normalizedEdgeMeanDelta * 1.05
      + normalizedEdgeOutlierPct * 0.55
      + Math.max(0, borderRoughness - 46) * 0.08
      + agingPenalty * 0.28
      - cleanSceneBonus * 0.72
      + edgeLocalizationBonus
      + edgeCoverageBonus
  );
  const edgeWearScore = Math.max(0, rawEdgeWearScore - finishProfile.borderTextureConfidence * 5.5);
  const normalizedCornerMeanDelta = Math.max(0, wearStats.cornerMeanDelta - wearStats.edgeBaseline - 7);
  const normalizedCornerOutlierPct = Math.max(0, wearStats.cornerOutlierPct - 2.5);
  const cornerWearScore =
    normalizedCornerMeanDelta * 1.35
    + normalizedCornerOutlierPct * 0.65
    + agingPenalty * 0.25
    + Math.max(0, cornerHotspots.length - 1) * 4;
  const rawScuffScore = Math.max(
    0,
    Math.max(0, interiorStats.anomalyPerK - 240) * 0.22
      + Math.max(0, interiorStats.strongPerK - 164) * 0.42
      + agingPenalty * 0.7
      - cleanSceneBonus
  );
  const scuffScore = Math.max(0, rawScuffScore - finishProfile.interiorTextureConfidence * 8.5);
  const rawScratchScore = Math.max(
    0,
    Math.max(0, interiorStats.linearPerK - 156) * 0.55
      + Math.max(0, interiorStats.strongPerK - 168) * 0.18
      + agingPenalty * 0.3
      - cleanSceneBonus * 0.72
  );
  const scratchScore = Math.max(
    0,
    rawScratchScore - (
      finishProfile.interiorTextureConfidence
      * clamp01((0.28 - finishProfile.linearityRatio) / 0.28)
      * 3.5
    )
  );

  const scratchScoreSeverity: Severity =
    scratchScore > 9 ? 'Moderate'
      : scratchScore > 4.5 ? 'Minor'
        : scratchScore > 1.8 ? 'Slight'
          : 'NONE';
  const scratchMeasuredSeverity = severityFromThresholds(scratchLengthCm, {
    slight: TUNING.scratchMinLenCmSlight,
    minor: TUNING.scratchMinLenCmMinor,
    moderate: TUNING.scratchMinLenCmModerate
  });
  const scratchEvidenceStrength: EvidenceStrength =
    scratchHotspots.some((hotspot) => hotspot.linearCount >= 3) || scratchHotspots.length >= 2 || scratchLengthCm >= TUNING.scratchMinLenCmMinor
      ? 'high'
      : scratchHotspots.length >= 1 ? 'medium' : 'low';
  let scratchSeverity = combineDetectedSeverity(
    scratchScoreSeverity,
    scratchMeasuredSeverity,
    scratchEvidenceStrength
  );
  if (
    scratchSeverity !== 'NONE'
    && finishProfile.interiorTextureConfidence >= 0.55
    && scratchMeasuredSeverity === 'NONE'
    && scratchEvidenceStrength === 'low'
  ) {
    scratchSeverity = downgradeSeverityBySteps(scratchSeverity, 1);
  }
  if (scratchSeverity !== 'NONE') {
    const hotspot = scratchHotspots[0] ?? interiorStats.hotspots[0];
    const region = hotspot ? toFindingRegion(hotspot.bounds, width, height) : undefined;
    const scratchNotes = [
      'Detected from line-like anomaly clusters in the rectified front image.',
      'Total scratch length is aggregated across the strongest detected interior hotspots.'
    ];
    if (finishProfile.interiorTextureConfidence >= 0.45) {
      scratchNotes.push('Textured-finish mode is active, so weak non-linear texture is discounted and only the more line-like disruption is retained.');
    }
    const finding = createObservedFinding({
      category: 'surface',
      flawType: 'scratch',
      severity: severityToFindingSeverity(scratchSeverity),
      metric: `Interior scratch index ${scratchScore.toFixed(1)} (${interiorStats.linearPerK.toFixed(2)} line hits/k, approx ${formatLengthCm(scratchLengthCm)} total)`,
      location: scratchHotspots.length > 1 ? 'multiple interior regions' : hotspot ? describeBoundsLocation(hotspot.bounds, width, height) : 'interior',
      notes: scratchNotes,
      measurement: {
        kind: 'length_cm',
        value: scratchLengthCm,
        display: formatLengthCm(scratchLengthCm),
        approximate: true,
        normalized: scratchLengthCm / Math.max(TUNING.cardWidthCm, TUNING.cardHeightCm)
      },
      region,
      evidenceStrength: scratchEvidenceStrength,
      count: scratchHotspots.length || undefined
    });
    addFlawItem('Scratch', scratchSeverity, finding.metric, finding);
  }

  const scuffScoreSeverity: Severity =
    scuffScore > 11 ? 'Moderate'
      : scuffScore > 5.5 ? 'Minor'
        : scuffScore > 3.4 ? 'Slight'
          : 'NONE';
  const scuffMeasuredSeverity = severityFromThresholds(scuffAreaCm2, {
    slight: TUNING.scuffSlightCm2,
    minor: TUNING.scuffMinorCm2,
    moderate: TUNING.scuffModerateCm2,
    major: TUNING.scuffMajorCm2
  });
  const scuffEvidenceStrength: EvidenceStrength =
    scuffHotspots.some((hotspot) => hotspot.strongCount >= 3) || scuffHotspots.length >= 2 || scuffAreaCm2 >= TUNING.scuffMinorCm2
      ? 'high'
      : scuffHotspots.length >= 1 ? 'medium' : 'low';
  let scuffSeverity = combineDetectedSeverity(
    scuffScoreSeverity,
    scuffMeasuredSeverity,
    scuffEvidenceStrength
  );
  if (scuffSeverity !== 'NONE' && finishProfile.interiorTextureConfidence >= 0.4) {
    const downgradeSteps = finishProfile.interiorTextureConfidence >= 0.72 ? 2 : 1;
    const effectiveSteps = finishProfile.dominantScuffHotspotShare >= 0.68
      ? Math.max(0, downgradeSteps - 1)
      : downgradeSteps;
    scuffSeverity = downgradeSeverityBySteps(scuffSeverity, effectiveSteps);
  }
  if (scuffSeverity !== 'NONE') {
    const hotspot = scuffHotspots[0] ?? interiorStats.hotspots[0];
    const region = hotspot ? toFindingRegion(hotspot.bounds, width, height) : undefined;
    const scuffNotes = [
      'Detected from clustered interior texture anomalies in the rectified front image.',
      'Approximate area is aggregated across the strongest scuff-like clusters and should still be reviewed against glare and scan noise.'
    ];
    if (finishProfile.interiorTextureConfidence >= 0.45) {
      scuffNotes.push('Textured-finish mode reduced the penalty for broad factory foil/emboss patterning and kept the focus on localized disruptions.');
    }
    const finding = createObservedFinding({
      category: 'surface',
      flawType: 'scuffing',
      severity: severityToFindingSeverity(scuffSeverity),
      metric: `Interior surface index ${scuffScore.toFixed(1)} (${interiorStats.anomalyPerK.toFixed(2)} anomalies/k, approx ${formatAreaCm2(scuffAreaCm2)})`,
      location: scuffHotspots.length > 1 ? 'multiple interior regions' : hotspot ? describeBoundsLocation(hotspot.bounds, width, height) : 'interior',
      notes: scuffNotes,
      measurement: {
        kind: 'area_cm2',
        value: scuffAreaCm2,
        display: formatAreaCm2(scuffAreaCm2),
        approximate: true,
        normalized: scuffAreaCm2 / Math.max(0.001, cardAreaCm2)
      },
      region,
      evidenceStrength: scuffEvidenceStrength,
      count: scuffHotspots.length || undefined
    });
    addFlawItem('Scuffing', scuffSeverity, finding.metric, finding);
  }

  // Surface wear proxy based on border cleanliness and tonal spread on the detected card.
  const surfaceWearScoreSeverity: Severity =
    borderCleanlinessScore > 54 ? 'Moderate'
      : borderCleanlinessScore > 36 ? 'Minor'
        : borderCleanlinessScore > 24 ? 'Slight'
          : 'NONE';
  const surfaceWearMeasuredSeverity = severityFromThresholds(surfaceWearAreaCm2, {
    slight: TUNING.surfaceWearSlightCm2,
    minor: TUNING.surfaceWearMinorCm2,
    moderate: TUNING.surfaceWearModerateCm2,
    major: TUNING.surfaceWearMajorCm2
  });
  const surfaceWearEvidenceStrength: EvidenceStrength =
    borderSideCount >= 3 || surfaceWearAreaCm2 >= TUNING.surfaceWearMinorCm2
      ? 'high'
      : borderHotspots.length >= 1 ? 'medium' : 'low';
  let surfaceWearSeverity = combineDetectedSeverity(
    surfaceWearScoreSeverity,
    surfaceWearMeasuredSeverity,
    surfaceWearEvidenceStrength
  );
  if (surfaceWearSeverity !== 'NONE' && finishProfile.borderTextureConfidence >= 0.45 && borderSideCount >= 2) {
    surfaceWearSeverity = downgradeSeverityBySteps(
      surfaceWearSeverity,
      finishProfile.borderTextureConfidence >= 0.72 ? 2 : 1
    );
  }

  // Avoid double-counting a single localized edge issue as both edge wear and broad surface wear.
  const edgewearScoreSeverity: Severity =
    edgeWearScore > 44 ? 'Moderate'
      : edgeWearScore > 30 ? 'Minor'
        : edgeWearScore > 20 ? 'Slight'
          : 'NONE';
  const edgewearMeasuredSeverity = severityFromThresholds(edgeWearLengthCm, {
    slight: TUNING.edgewearSlightCm,
    minor: TUNING.edgewearMinorCm,
    moderate: TUNING.edgewearModerateCm,
    major: TUNING.edgewearModerateCm + 0.001
  });
  const edgewearEvidenceStrength: EvidenceStrength =
    borderSideCount >= 2 || edgeWearLengthCm >= TUNING.edgewearMinorCm
      ? 'high'
      : borderHotspots.length >= 1 ? 'medium' : 'low';
  let edgewearSeverity = combineDetectedSeverity(
    edgewearScoreSeverity,
    edgewearMeasuredSeverity,
    edgewearEvidenceStrength
  );
  if (
    edgewearSeverity !== 'NONE'
    && finishProfile.borderTextureConfidence >= 0.55
    && borderSideCount >= 3
    && edgewearMeasuredSeverity === 'NONE'
  ) {
    edgewearSeverity = downgradeSeverityBySteps(edgewearSeverity, 1);
  }
  if (
    surfaceWearSeverity !== 'NONE'
    && edgewearSeverity !== 'NONE'
    && borderSideCount <= 1
    && surfaceWearMeasuredSeverity === 'NONE'
    && severityRank(surfaceWearSeverity) <= severityRank(edgewearSeverity)
  ) {
    surfaceWearSeverity = 'NONE';
  }
  if (surfaceWearSeverity !== 'NONE') {
    const hotspot = borderHotspots[0];
    const region = hotspot ? toFindingRegion(hotspot.bounds, width, height) : undefined;
    const surfaceWearNotes = [
      'Border cleanliness and tonal spread were used as a proxy for visible front-side wear.',
      'Broader side-to-side spread is weighted more heavily than a single localized edge segment.'
    ];
    if (finishProfile.borderTextureConfidence >= 0.45) {
      surfaceWearNotes.push('Textured-finish mode discounted broad decorative border sparkle so isolated wear remains more important than factory texture.');
    }
    const finding = createObservedFinding({
      category: 'surface',
      flawType: 'surface wear',
      severity: severityToFindingSeverity(surfaceWearSeverity),
      metric: `Border wear index ${borderCleanlinessScore.toFixed(1)} (${borderStats.outlierPct.toFixed(1)}% blemish, spread ${borderStats.toneSpread.toFixed(1)}, approx ${formatAreaCm2(surfaceWearAreaCm2)})`,
      location: describeAffectedSides(borderSides),
      notes: surfaceWearNotes,
      measurement: {
        kind: 'area_cm2',
        value: surfaceWearAreaCm2,
        display: formatAreaCm2(surfaceWearAreaCm2),
        approximate: true,
        normalized: surfaceWearAreaCm2 / Math.max(0.001, cardAreaCm2)
      },
      region,
      evidenceStrength: surfaceWearEvidenceStrength,
      count: borderHotspots.length || undefined
    });
    addFlawItem('Surface Wear', surfaceWearSeverity, finding.metric, finding);
  }

  // Edgewear: perimeter roughness around the detected outer-card boundary.
  if (edgewearSeverity !== 'NONE') {
    const hotspot = borderHotspots.find((candidate) => candidate.side === 'left' || candidate.side === 'right' || candidate.side === 'top' || candidate.side === 'bottom');
    const region = hotspot ? toFindingRegion(hotspot.bounds, width, height) : undefined;
    const edgewearNotes = [
      'Detected from border roughness and side-strip outliers.',
      'Length is aggregated across the affected border segments to better match the rubric\'s summed-edgewear framing.'
    ];
    if (finishProfile.borderTextureConfidence >= 0.45) {
      edgewearNotes.push('Textured-finish mode discounted broad factory border texture, so only the stronger residual edge disruption is scored.');
    }
    const finding = createObservedFinding({
      category: 'edges',
      flawType: 'edge wear',
      severity: severityToFindingSeverity(edgewearSeverity),
      metric: `Wear index ${edgeWearScore.toFixed(1)} (roughness ${borderRoughness.toFixed(1)}, outliers ${wearStats.edgeOutlierPct.toFixed(1)}%, approx ${formatLengthCm(edgeWearLengthCm)} total)`,
      location: describeAffectedSides(borderSides),
      notes: edgewearNotes,
      measurement: {
        kind: 'length_cm',
        value: edgeWearLengthCm,
        display: formatLengthCm(edgeWearLengthCm),
        approximate: true,
        normalized: edgeWearLengthCm / Math.max(0.001, cardPerimeterCm)
      },
      region,
      evidenceStrength: edgewearEvidenceStrength,
      count: borderHotspots.length || undefined
    });
    addFlawItem('Edgewear', edgewearSeverity, finding.metric, finding);
  }

  const cornerScoreSeverity: Severity =
    cornerWearScore > 38 ? 'Moderate'
      : cornerWearScore > 26 ? 'Minor'
        : cornerWearScore > 15 ? 'Slight'
          : 'NONE';
  const cornerMeasuredSeverity = severityFromThresholds(cornerHotspots.length, {
    slight: 1,
    minor: 2,
    moderate: 3,
    major: 4
  });
  const cornerEvidenceStrength: EvidenceStrength =
    cornerHotspots.length >= 2 || cornerHotspots.some((hotspot) => hotspot.score >= 34)
      ? 'high'
      : cornerHotspots.length === 1 ? 'medium' : 'low';
  const cornerWearSeverity = combineDetectedSeverity(
    cornerScoreSeverity,
    cornerMeasuredSeverity,
    cornerEvidenceStrength
  );
  if (cornerWearSeverity !== 'NONE') {
    const hotspot = cornerHotspots[0];
    const region = hotspot ? toFindingRegion(hotspot.bounds, width, height) : undefined;
    const finding = createObservedFinding({
      category: 'corners',
      flawType: 'corner wear',
      severity: severityToFindingSeverity(cornerWearSeverity),
      metric: `Corner wear index ${cornerWearScore.toFixed(1)} (${wearStats.cornerOutlierPct.toFixed(1)}% corner outliers, ${cornerHotspots.length} affected corners)`,
      location: describeAffectedCorners(cornerHotspots),
      notes: ['Corner wear is inferred from corner-patch deviation against nearby border reference pixels.', 'Affected-corner count is used to stabilize slight detections that would otherwise be easy to over-call.'],
      measurement: {
        kind: 'count',
        value: Math.max(1, cornerHotspots.length),
        display: `${Math.max(1, cornerHotspots.length)} corner hotspot${cornerHotspots.length === 1 ? '' : 's'}`,
        approximate: true
      },
      region,
      evidenceStrength: cornerEvidenceStrength,
      count: cornerHotspots.length || undefined
    });
    addFlawItem('Corner Rounding', cornerWearSeverity, finding.metric, finding);
  }

  const toneClippingPct = (stats.shadowClipFrac + stats.highlightClipFrac) * 100;
  const toneSeverity: Severity =
    toneClippingPct > 18 ? 'Moderate'
      : toneClippingPct > 10 ? 'Minor'
        : toneClippingPct > 5 ? 'Slight'
          : 'NONE';
  if (toneSeverity !== 'NONE') {
    const clippedAreaCm2 = (toneClippingPct / 100) * TUNING.cardWidthCm * TUNING.cardHeightCm;
    createObservedFinding({
      category: 'quality',
      flawType: 'tone clipping / lighting defect',
      severity: severityToFindingSeverity(toneSeverity),
      metric: `Tone clipping ${toneClippingPct.toFixed(1)}%`,
      location: 'overall image',
      notes: ['This is an image-quality proxy that can hide or exaggerate visible defects.', 'Used conservatively as a front-image observability warning.'],
      measurement: {
        kind: 'area_cm2',
        value: clippedAreaCm2,
        display: formatAreaCm2(clippedAreaCm2),
        approximate: true,
        normalized: toneClippingPct / 100
      },
      evidenceStrength: toneClippingPct > 18 ? 'high' : 'medium'
    });
  }

  const mapped = assessConditionFromFlaws(items);
  const cornerFindings = detectedFindings.filter((finding) => finding.category === 'corners');
  const edgeFindings = detectedFindings.filter((finding) => finding.category === 'edges');
  const surfaceFindings = detectedFindings.filter((finding) => finding.category === 'surface');
  const shapeFindings: DetectedFinding[] = [];
  const notReliablyObservable = [
    'indentation depth and show-through from the reverse',
    'true gloss loss',
    'fine print registration defects',
    'subtle bend, curl, or warp without side-angle evidence',
    'any reverse-side defects',
    ...(surfaceFinishMode === 'textured'
      ? ['textured finish mode is enabled: broad holographic, embossed, or etched factory texture is intentionally downweighted relative to localized surface damage']
      : []),
    ...finishProfile.notes,
    ...(toneSeverity !== 'NONE' ? ['lighting/tone clipping may be masking or exaggerating visible defects'] : [])
  ];

  return {
    totalPoints: mapped.totalPoints,
    effectivePoints: mapped.effectivePoints,
    condition: mapped.condition,
    pointCondition: mapped.pointCondition,
    matrixCondition: mapped.matrixCondition,
    psaProfile: mapped.psaProfile,
    limitingFlaws: mapped.limitingFlaws,
    gradeCap: mapped.gradeCap,
    items,
    detectedFindings,
    cornerFindings,
    edgeFindings,
    surfaceFindings,
    shapeFindings,
    notReliablyObservable,
    debug: {
      blurVariance: stats.blurVariance,
      meanLuma: stats.meanLuma,
      stdLuma: stats.stdLuma,
      shadowClipFrac: stats.shadowClipFrac,
      highlightClipFrac: stats.highlightClipFrac,
      borderRoughness,
      borderCleanlinessScore,
      borderOutlierPct: borderStats.outlierPct,
      borderToneSpread: borderStats.toneSpread,
      edgeWearScore,
      edgeWearOutlierPct: wearStats.edgeOutlierPct,
      cornerWearScore,
      cornerWearOutlierPct: wearStats.cornerOutlierPct,
      interiorAnomalyPerK: interiorStats.anomalyPerK,
      interiorStrongPerK: interiorStats.strongPerK,
      interiorLinearPerK: interiorStats.linearPerK,
      innerMeanLuma: toneBands.innerMeanLuma,
      innerStdLuma: toneBands.innerStdLuma,
      borderMeanLuma: toneBands.borderMeanLuma,
      borderStdLuma: toneBands.borderStdLuma,
      agingPenalty,
      cleanSceneBonus,
      scuffScore,
      scratchScore,
      toneClippingPct,
      surfaceFinishMode,
      surfaceFinishProfile: {
        interiorTextureConfidence: finishProfile.interiorTextureConfidence,
        borderTextureConfidence: finishProfile.borderTextureConfidence,
        overallConfidence: finishProfile.overallConfidence,
        interiorHotspotQuadrants: finishProfile.interiorHotspotQuadrants,
        scuffHotspotCoveragePct: finishProfile.scuffHotspotCoveragePct,
        dominantScuffHotspotShare: finishProfile.dominantScuffHotspotShare,
        linearityRatio: finishProfile.linearityRatio,
        strongRatio: finishProfile.strongRatio,
        notes: finishProfile.notes
      },
      measuredFeatures: {
        scratchLengthCm,
        scuffAreaCm2,
        surfaceWearAreaCm2,
        edgeWearLengthCm,
        scuffHotspotCoveragePct,
        borderHotspotCoveragePct,
        edgeHotspotCoveragePct,
        borderSidesAffected: borderSideCount,
        cornerHotspotCount: cornerHotspots.length
      }
    }
  };
}

function analyzeCanvasBorderCleanliness(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null,
  innerBounds: ContentBounds | null
): { meanDelta: number; outlierPct: number; toneSpread: number } {
  if (!bounds || !innerBounds) {
    return { meanDelta: 0, outlierPct: 0, toneSpread: 0 };
  }

  const card = {
    minX: clampInt(bounds.minX, 0, width - 1),
    minY: clampInt(bounds.minY, 0, height - 1),
    maxX: clampInt(bounds.maxX, 0, width - 1),
    maxY: clampInt(bounds.maxY, 0, height - 1)
  };
  const inner = {
    minX: clampInt(innerBounds.minX, card.minX, card.maxX),
    minY: clampInt(innerBounds.minY, card.minY, card.maxY),
    maxX: clampInt(innerBounds.maxX, card.minX, card.maxX),
    maxY: clampInt(innerBounds.maxY, card.minY, card.maxY)
  };

  const sampleStep = Math.max(1, Math.floor(Math.min(width, height) / 760));
  const strips = [
    sampleBorderStripStats(px, width, card.minX, card.minY, card.maxX, inner.minY - 1, sampleStep),
    sampleBorderStripStats(px, width, card.minX, inner.maxY + 1, card.maxX, card.maxY, sampleStep),
    sampleBorderStripStats(px, width, card.minX, inner.minY, inner.minX - 1, inner.maxY, sampleStep),
    sampleBorderStripStats(px, width, inner.maxX + 1, inner.minY, card.maxX, inner.maxY, sampleStep)
  ].filter((value): value is { meanDelta: number; outlierPct: number; toneSpread: number } => !!value);

  if (strips.length === 0) {
    return { meanDelta: 0, outlierPct: 0, toneSpread: 0 };
  }

  return {
    meanDelta: strips.reduce((sum, strip) => sum + strip.meanDelta, 0) / strips.length,
    outlierPct: strips.reduce((sum, strip) => sum + strip.outlierPct, 0) / strips.length,
    toneSpread: strips.reduce((sum, strip) => sum + strip.toneSpread, 0) / strips.length
  };
}

function sampleBorderStripStats(
  px: Uint8ClampedArray,
  width: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  step: number
): { meanDelta: number; outlierPct: number; toneSpread: number } | null {
  if (minX > maxX || minY > maxY) return null;

  const rValues: number[] = [];
  const gValues: number[] = [];
  const bValues: number[] = [];
  const lumaValues: number[] = [];

  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const idx = (y * width + x) * 4;
      const r = px[idx];
      const g = px[idx + 1];
      const b = px[idx + 2];
      rValues.push(r);
      gValues.push(g);
      bValues.push(b);
      lumaValues.push(r * 0.299 + g * 0.587 + b * 0.114);
    }
  }

  if (lumaValues.length === 0) return null;

  const sortedR = [...rValues].sort((a, b) => a - b);
  const sortedG = [...gValues].sort((a, b) => a - b);
  const sortedB = [...bValues].sort((a, b) => a - b);
  const sortedLuma = [...lumaValues].sort((a, b) => a - b);
  const refR = percentile(sortedR, 0.5);
  const refG = percentile(sortedG, 0.5);
  const refB = percentile(sortedB, 0.5);
  const refLuma = percentile(sortedLuma, 0.5);
  const toneSpread = percentile(sortedLuma, 0.75) - percentile(sortedLuma, 0.25);
  const blemishThreshold = Math.max(20, toneSpread * 1.8);

  let deltaSum = 0;
  let outlierCount = 0;
  for (let index = 0; index < lumaValues.length; index++) {
    const colorDelta = (
      Math.abs(rValues[index] - refR)
      + Math.abs(gValues[index] - refG)
      + Math.abs(bValues[index] - refB)
    ) / 3;
    const lumaDelta = Math.abs(lumaValues[index] - refLuma);
    const combinedDelta = colorDelta * 0.55 + lumaDelta * 0.45;
    deltaSum += combinedDelta;
    if (combinedDelta >= blemishThreshold || lumaValues[index] <= refLuma - 24) {
      outlierCount++;
    }
  }

  return {
    meanDelta: deltaSum / lumaValues.length,
    outlierPct: (outlierCount / lumaValues.length) * 100,
    toneSpread
  };
}

function detectBorderHotspots(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null,
  innerBounds: ContentBounds | null
): BorderHotspot[] {
  if (!bounds || !innerBounds) return [];

  const card = {
    minX: clampInt(bounds.minX, 0, width - 1),
    minY: clampInt(bounds.minY, 0, height - 1),
    maxX: clampInt(bounds.maxX, 0, width - 1),
    maxY: clampInt(bounds.maxY, 0, height - 1)
  };
  const inner = {
    minX: clampInt(innerBounds.minX, card.minX, card.maxX),
    minY: clampInt(innerBounds.minY, card.minY, card.maxY),
    maxX: clampInt(innerBounds.maxX, card.minX, card.maxX),
    maxY: clampInt(innerBounds.maxY, card.minY, card.maxY)
  };
  const step = Math.max(1, Math.floor(Math.min(width, height) / 760));
  const hotspots: BorderHotspot[] = [];
  const segmentSpan = Math.max(14, Math.round(Math.min(width, height) * 0.045));

  const pushSegments = (
    side: BorderHotspot['side'],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    alongAxis: 'x' | 'y'
  ) => {
    if (minX > maxX || minY > maxY) return;
    if (alongAxis === 'x') {
      for (let startX = minX; startX <= maxX; startX += segmentSpan) {
        const endX = Math.min(maxX, startX + segmentSpan - 1);
        const stats = sampleBorderStripStats(px, width, startX, minY, endX, maxY, step);
        if (!stats) continue;
        if (stats.outlierPct < 10 && stats.meanDelta < 18) continue;
        hotspots.push({
          bounds: { minX: startX, minY, maxX: endX, maxY },
          side,
          deviation: stats.meanDelta,
          outlierPct: stats.outlierPct
        });
      }
      return;
    }

    for (let startY = minY; startY <= maxY; startY += segmentSpan) {
      const endY = Math.min(maxY, startY + segmentSpan - 1);
      const stats = sampleBorderStripStats(px, width, minX, startY, maxX, endY, step);
      if (!stats) continue;
      if (stats.outlierPct < 10 && stats.meanDelta < 18) continue;
      hotspots.push({
        bounds: { minX, minY: startY, maxX, maxY: endY },
        side,
        deviation: stats.meanDelta,
        outlierPct: stats.outlierPct
      });
    }
  };

  pushSegments('top', card.minX, card.minY, card.maxX, inner.minY - 1, 'x');
  pushSegments('bottom', card.minX, inner.maxY + 1, card.maxX, card.maxY, 'x');
  pushSegments('left', card.minX, inner.minY, inner.minX - 1, inner.maxY, 'y');
  pushSegments('right', inner.maxX + 1, inner.minY, card.maxX, inner.maxY, 'y');

  return hotspots
    .sort((a, b) => ((b.outlierPct * 1.2) + b.deviation) - ((a.outlierPct * 1.2) + a.deviation))
    .slice(0, 8);
}

function analyzeCanvasInteriorDisturbance(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null
): {
  anomalyPerK: number;
  strongPerK: number;
  linearPerK: number;
  hotspots: InteriorHotspot[];
} {
  if (!bounds) {
    return { anomalyPerK: 0, strongPerK: 0, linearPerK: 0, hotspots: [] };
  }

  const region = insetBoundsByFrac(bounds, width, height, 0.05);
  const regionWidth = Math.max(1, region.maxX - region.minX + 1);
  const regionHeight = Math.max(1, region.maxY - region.minY + 1);
  if (regionWidth < 12 || regionHeight < 12) {
    return { anomalyPerK: 0, strongPerK: 0, linearPerK: 0, hotspots: [] };
  }

  const stride = width + 1;
  const integral = buildLumaIntegral(px, width, height, stride);
  const step = clampInt(Math.round(Math.min(regionWidth, regionHeight) / 240), 1, 4);
  const cols = Math.floor((regionWidth - 1) / step) + 1;
  const rows = Math.floor((regionHeight - 1) / step) + 1;
  const anomalyMarks = new Uint8Array(cols * rows);
  const linearMarks = new Uint8Array(cols * rows);
  const signals = new Float32Array(cols * rows);
  const smallRadius = Math.max(1, step);
  const largeRadius = clampInt(Math.round(Math.min(regionWidth, regionHeight) * 0.012), smallRadius + 2, 12);
  const anomalyThreshold = 8.5;
  const strongThreshold = 14.5;

  let sampleCount = 0;
  let anomalyCount = 0;
  let strongCount = 0;
  for (let row = 0; row < rows; row++) {
    const y = Math.min(region.maxY, region.minY + row * step);
    for (let col = 0; col < cols; col++) {
      const x = Math.min(region.maxX, region.minX + col * step);
      const index = row * cols + col;
      const smallMean = meanRectFromIntegral(integral, stride, width, height, x - smallRadius, y - smallRadius, x + smallRadius, y + smallRadius);
      const largeMean = meanRectFromIntegral(integral, stride, width, height, x - largeRadius, y - largeRadius, x + largeRadius, y + largeRadius);
      const leftMean = meanRectFromIntegral(integral, stride, width, height, x - (largeRadius * 2), y - smallRadius, x - largeRadius, y + smallRadius);
      const rightMean = meanRectFromIntegral(integral, stride, width, height, x + largeRadius, y - smallRadius, x + (largeRadius * 2), y + smallRadius);
      const upMean = meanRectFromIntegral(integral, stride, width, height, x - smallRadius, y - (largeRadius * 2), x + smallRadius, y - largeRadius);
      const downMean = meanRectFromIntegral(integral, stride, width, height, x - smallRadius, y + largeRadius, x + smallRadius, y + (largeRadius * 2));
      const localGrad = (Math.abs(rightMean - leftMean) + Math.abs(downMean - upMean)) * 0.5;
      const signal = Math.max(0, Math.abs(smallMean - largeMean) - localGrad * 0.32);

      signals[index] = signal;
      sampleCount++;
      if (signal >= anomalyThreshold) {
        anomalyMarks[index] = 1;
        anomalyCount++;
      }
      if (signal >= strongThreshold) {
        strongCount++;
      }
    }
  }

  let linearCount = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      if (!anomalyMarks[index] || signals[index] < anomalyThreshold + 1) continue;

      let bestRun = 1;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
        const run = 1
          + countMarkedRun(anomalyMarks, signals, cols, rows, col, row, dx, dy, anomalyThreshold, 3)
          + countMarkedRun(anomalyMarks, signals, cols, rows, col, row, -dx, -dy, anomalyThreshold, 3);
        if (run > bestRun) bestRun = run;
      }

      if (bestRun >= 4 && signals[index] >= anomalyThreshold + 1.5) {
        linearCount++;
        linearMarks[index] = 1;
      }
    }
  }

  return {
    anomalyPerK: (anomalyCount / Math.max(1, sampleCount)) * 1000,
    strongPerK: (strongCount / Math.max(1, sampleCount)) * 1000,
    linearPerK: (linearCount / Math.max(1, sampleCount)) * 1000,
    hotspots: clusterInteriorHotspots(region, cols, rows, step, anomalyMarks, linearMarks, signals, strongThreshold)
  };
}

function clusterInteriorHotspots(
  region: ContentBounds,
  cols: number,
  rows: number,
  step: number,
  anomalyMarks: Uint8Array,
  linearMarks: Uint8Array,
  signals: Float32Array,
  strongThreshold: number
): InteriorHotspot[] {
  const visited = new Uint8Array(cols * rows);
  const hotspots: InteriorHotspot[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const startIndex = row * cols + col;
      if (!anomalyMarks[startIndex] || visited[startIndex]) continue;

      const queue: Array<[number, number]> = [[col, row]];
      visited[startIndex] = 1;
      let sampleCount = 0;
      let strongCount = 0;
      let linearCount = 0;
      let maxSignal = 0;
      let minCol = col;
      let maxCol = col;
      let minRow = row;
      let maxRow = row;

      while (queue.length) {
        const [currentCol, currentRow] = queue.shift()!;
        const index = currentRow * cols + currentCol;
        sampleCount++;
        if (signals[index] >= strongThreshold) strongCount++;
        if (linearMarks[index]) linearCount++;
        if (signals[index] > maxSignal) maxSignal = signals[index];
        if (currentCol < minCol) minCol = currentCol;
        if (currentCol > maxCol) maxCol = currentCol;
        if (currentRow < minRow) minRow = currentRow;
        if (currentRow > maxRow) maxRow = currentRow;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nextCol = currentCol + dx;
            const nextRow = currentRow + dy;
            if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) continue;
            const nextIndex = nextRow * cols + nextCol;
            if (!anomalyMarks[nextIndex] || visited[nextIndex]) continue;
            visited[nextIndex] = 1;
            queue.push([nextCol, nextRow]);
          }
        }
      }

      if (sampleCount < 2) continue;
      const bounds: ContentBounds = {
        minX: clampInt(region.minX + (minCol * step) - step, region.minX, region.maxX),
        minY: clampInt(region.minY + (minRow * step) - step, region.minY, region.maxY),
        maxX: clampInt(region.minX + (maxCol * step) + step, region.minX, region.maxX),
        maxY: clampInt(region.minY + (maxRow * step) + step, region.minY, region.maxY)
      };
      const hotspotWidth = Math.max(1, bounds.maxX - bounds.minX + 1);
      const hotspotHeight = Math.max(1, bounds.maxY - bounds.minY + 1);
      const aspect = Math.max(hotspotWidth / hotspotHeight, hotspotHeight / hotspotWidth);
      hotspots.push({
        bounds,
        sampleCount,
        strongCount,
        linearCount,
        maxSignal,
        kind: linearCount >= Math.max(2, Math.round(sampleCount * 0.25)) || aspect >= 2.8 ? 'scratch' : 'scuffing'
      });
    }
  }

  return hotspots
    .sort((a, b) => {
      const aScore = (a.strongCount * 3) + (a.linearCount * 4) + a.maxSignal;
      const bScore = (b.strongCount * 3) + (b.linearCount * 4) + b.maxSignal;
      return bScore - aScore;
    })
    .slice(0, 8);
}

function analyzeCanvasToneBands(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null,
  innerBounds: ContentBounds | null
): {
  innerMeanLuma: number;
  innerStdLuma: number;
  borderMeanLuma: number;
  borderStdLuma: number;
} {
  if (!bounds) {
    return {
      innerMeanLuma: 0,
      innerStdLuma: 0,
      borderMeanLuma: 0,
      borderStdLuma: 0
    };
  }

  const card = {
    minX: clampInt(bounds.minX, 0, width - 1),
    minY: clampInt(bounds.minY, 0, height - 1),
    maxX: clampInt(bounds.maxX, 0, width - 1),
    maxY: clampInt(bounds.maxY, 0, height - 1)
  };
  const fallbackInner = insetBoundsByFrac(card, width, height, 0.08);
  const innerBase = innerBounds ?? fallbackInner;
  const inner = {
    minX: clampInt(innerBase.minX, card.minX, card.maxX),
    minY: clampInt(innerBase.minY, card.minY, card.maxY),
    maxX: clampInt(innerBase.maxX, card.minX, card.maxX),
    maxY: clampInt(innerBase.maxY, card.minY, card.maxY)
  };
  const step = Math.max(1, Math.floor(Math.min(width, height) / 760));

  const innerStats = sampleLumaRectStats(px, width, inner.minX, inner.minY, inner.maxX, inner.maxY, step);
  const borderStats = mergeLumaStats([
    sampleLumaRectStats(px, width, card.minX, card.minY, card.maxX, inner.minY - 1, step),
    sampleLumaRectStats(px, width, card.minX, inner.maxY + 1, card.maxX, card.maxY, step),
    sampleLumaRectStats(px, width, card.minX, inner.minY, inner.minX - 1, inner.maxY, step),
    sampleLumaRectStats(px, width, inner.maxX + 1, inner.minY, card.maxX, inner.maxY, step)
  ]);

  return {
    innerMeanLuma: innerStats.mean,
    innerStdLuma: innerStats.std,
    borderMeanLuma: borderStats.mean,
    borderStdLuma: borderStats.std
  };
}

function sampleLumaRectStats(
  px: Uint8ClampedArray,
  width: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  step: number
): { count: number; mean: number; std: number } {
  if (minX > maxX || minY > maxY) {
    return { count: 0, mean: 0, std: 0 };
  }

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const idx = (y * width + x) * 4;
      const luma = px[idx] * 0.299 + px[idx + 1] * 0.587 + px[idx + 2] * 0.114;
      count++;
      sum += luma;
      sumSq += luma * luma;
    }
  }

  if (!count) {
    return { count: 0, mean: 0, std: 0 };
  }

  const mean = sum / count;
  const variance = Math.max(0, (sumSq / count) - (mean * mean));
  return {
    count,
    mean,
    std: Math.sqrt(variance)
  };
}

function mergeLumaStats(
  stats: Array<{ count: number; mean: number; std: number }>
): { mean: number; std: number } {
  const valid = stats.filter((entry) => entry.count > 0);
  if (!valid.length) {
    return { mean: 0, std: 0 };
  }

  const totalCount = valid.reduce((sum, entry) => sum + entry.count, 0);
  const mean = valid.reduce((sum, entry) => sum + (entry.mean * entry.count), 0) / totalCount;
  const variance = valid.reduce((sum, entry) => {
    const entryVariance = entry.std * entry.std;
    const meanDelta = entry.mean - mean;
    return sum + entry.count * (entryVariance + meanDelta * meanDelta);
  }, 0) / totalCount;

  return {
    mean,
    std: Math.sqrt(Math.max(0, variance))
  };
}

function insetBoundsByFrac(bounds: ContentBounds, width: number, height: number, frac: number): ContentBounds {
  if (frac <= 0) return bounds;
  const padX = Math.max(1, Math.round((bounds.maxX - bounds.minX + 1) * frac));
  const padY = Math.max(1, Math.round((bounds.maxY - bounds.minY + 1) * frac));
  const minX = clampInt(bounds.minX + padX, 0, width - 2);
  const minY = clampInt(bounds.minY + padY, 0, height - 2);
  const maxX = clampInt(bounds.maxX - padX, minX + 1, width - 1);
  const maxY = clampInt(bounds.maxY - padY, minY + 1, height - 1);
  return { minX, minY, maxX, maxY };
}

function buildLumaIntegral(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  stride: number
): Float32Array {
  const integral = new Float32Array(stride * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      const idx = ((y - 1) * width + (x - 1)) * 4;
      const luma = px[idx] * 0.299 + px[idx + 1] * 0.587 + px[idx + 2] * 0.114;
      rowSum += luma;
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }
  return integral;
}

function meanRectFromIntegral(
  integral: Float32Array,
  stride: number,
  width: number,
  height: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number {
  const x0 = clampInt(minX, 0, width - 1);
  const y0 = clampInt(minY, 0, height - 1);
  const x1 = clampInt(maxX, x0, width - 1);
  const y1 = clampInt(maxY, y0, height - 1);
  const area = Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1));
  const total =
    integral[(y1 + 1) * stride + (x1 + 1)]
    - integral[y0 * stride + (x1 + 1)]
    - integral[(y1 + 1) * stride + x0]
    + integral[y0 * stride + x0];
  return total / area;
}

function countMarkedRun(
  marks: Uint8Array,
  signals: Float32Array,
  cols: number,
  rows: number,
  startCol: number,
  startRow: number,
  dx: number,
  dy: number,
  threshold: number,
  maxSteps: number
): number {
  let count = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const col = startCol + dx * step;
    const row = startRow + dy * step;
    if (col < 0 || col >= cols || row < 0 || row >= rows) break;
    const index = row * cols + col;
    if (!marks[index] || signals[index] < threshold) break;
    count++;
  }
  return count;
}

function analyzeCanvasWear(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null,
  innerBounds: ContentBounds | null
): {
  edgeBaseline: number;
  edgeMeanDelta: number;
  edgeOutlierPct: number;
  cornerMeanDelta: number;
  cornerOutlierPct: number;
} {
  if (!bounds || !innerBounds) {
    return {
      edgeBaseline: 0,
      edgeMeanDelta: 0,
      edgeOutlierPct: 0,
      cornerMeanDelta: 0,
      cornerOutlierPct: 0
    };
  }

  const card = {
    minX: clampInt(bounds.minX, 0, width - 1),
    minY: clampInt(bounds.minY, 0, height - 1),
    maxX: clampInt(bounds.maxX, 0, width - 1),
    maxY: clampInt(bounds.maxY, 0, height - 1)
  };
  const inner = {
    minX: clampInt(innerBounds.minX, card.minX, card.maxX),
    minY: clampInt(innerBounds.minY, card.minY, card.maxY),
    maxX: clampInt(innerBounds.maxX, card.minX, card.maxX),
    maxY: clampInt(innerBounds.maxY, card.minY, card.maxY)
  };

  const edgeDeltas: number[] = [];
  const cornerDeltas: number[] = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 420));
  const sides: Array<'left' | 'right' | 'top' | 'bottom'> = ['left', 'right', 'top', 'bottom'];

  for (const side of sides) {
    const borderThickness = side === 'left'
      ? inner.minX - card.minX
      : side === 'right'
        ? card.maxX - inner.maxX
        : side === 'top'
          ? inner.minY - card.minY
          : card.maxY - inner.maxY;
    if (borderThickness < 4) continue;

    const alongMin = side === 'left' || side === 'right' ? card.minY : card.minX;
    const alongMax = side === 'left' || side === 'right' ? card.maxY : card.maxX;
    const alongSpan = alongMax - alongMin + 1;
    const edgeDepth = clampInt(Math.round(borderThickness * 0.34), 1, Math.max(1, borderThickness - 1));
    const referenceOffset = clampInt(Math.round(borderThickness * 0.42), 2, Math.max(2, borderThickness - 1));
    const cornerZone = clampInt(Math.round(alongSpan * 0.12), 6, Math.max(6, Math.round(alongSpan * 0.18)));

    for (let along = alongMin; along <= alongMax; along += step) {
      const inCornerZone = along - alongMin <= cornerZone || alongMax - along <= cornerZone;
      for (let depth = 0; depth < edgeDepth; depth++) {
        const refDepth = Math.min(borderThickness - 1, depth + referenceOffset);
        if (refDepth <= depth) continue;

        const outer = borderWearPoint(card, side, along, depth);
        const reference = borderWearPoint(card, side, along, refDepth);
        const delta = wearDeltaBetweenPixels(px, width, outer.x, outer.y, reference.x, reference.y);
        edgeDeltas.push(delta);
        if (inCornerZone) cornerDeltas.push(delta);
      }
    }
  }

  const edgeStats = summarizeWearDeltas(edgeDeltas);
  const cornerStats = summarizeWearDeltas(cornerDeltas, edgeStats.baseline, edgeStats.threshold);
  return {
    edgeBaseline: edgeStats.baseline,
    edgeMeanDelta: edgeStats.mean,
    edgeOutlierPct: edgeStats.outlierPct,
    cornerMeanDelta: cornerStats.mean,
    cornerOutlierPct: cornerStats.outlierPct
  };
}

function detectCornerHotspots(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ContentBounds | null,
  innerBounds: ContentBounds | null
): CornerHotspot[] {
  if (!bounds || !innerBounds) return [];

  const card = {
    minX: clampInt(bounds.minX, 0, width - 1),
    minY: clampInt(bounds.minY, 0, height - 1),
    maxX: clampInt(bounds.maxX, 0, width - 1),
    maxY: clampInt(bounds.maxY, 0, height - 1)
  };
  const inner = {
    minX: clampInt(innerBounds.minX, card.minX, card.maxX),
    minY: clampInt(innerBounds.minY, card.minY, card.maxY),
    maxX: clampInt(innerBounds.maxX, card.minX, card.maxX),
    maxY: clampInt(innerBounds.maxY, card.minY, card.maxY)
  };
  const spanX = Math.max(6, Math.round((card.maxX - card.minX + 1) * 0.12));
  const spanY = Math.max(6, Math.round((card.maxY - card.minY + 1) * 0.12));
  const referenceDepthX = clampInt(Math.max(2, Math.round((inner.minX - card.minX) * 0.55)), 2, Math.max(2, inner.minX - card.minX));
  const referenceDepthY = clampInt(Math.max(2, Math.round((inner.minY - card.minY) * 0.55)), 2, Math.max(2, inner.minY - card.minY));
  const step = Math.max(1, Math.floor(Math.min(width, height) / 480));

  const cornerDefs: Array<{ name: CornerHotspot['name']; minX: number; minY: number; maxX: number; maxY: number; refX: number; refY: number }> = [
    {
      name: 'top-left',
      minX: card.minX,
      minY: card.minY,
      maxX: Math.min(card.maxX, card.minX + spanX),
      maxY: Math.min(card.maxY, card.minY + spanY),
      refX: Math.min(card.maxX, card.minX + referenceDepthX),
      refY: Math.min(card.maxY, card.minY + referenceDepthY)
    },
    {
      name: 'top-right',
      minX: Math.max(card.minX, card.maxX - spanX),
      minY: card.minY,
      maxX: card.maxX,
      maxY: Math.min(card.maxY, card.minY + spanY),
      refX: Math.max(card.minX, card.maxX - referenceDepthX),
      refY: Math.min(card.maxY, card.minY + referenceDepthY)
    },
    {
      name: 'bottom-left',
      minX: card.minX,
      minY: Math.max(card.minY, card.maxY - spanY),
      maxX: Math.min(card.maxX, card.minX + spanX),
      maxY: card.maxY,
      refX: Math.min(card.maxX, card.minX + referenceDepthX),
      refY: Math.max(card.minY, card.maxY - referenceDepthY)
    },
    {
      name: 'bottom-right',
      minX: Math.max(card.minX, card.maxX - spanX),
      minY: Math.max(card.minY, card.maxY - spanY),
      maxX: card.maxX,
      maxY: card.maxY,
      refX: Math.max(card.minX, card.maxX - referenceDepthX),
      refY: Math.max(card.minY, card.maxY - referenceDepthY)
    }
  ];

  return cornerDefs.map((corner) => {
    let sampleCount = 0;
    let deltaSum = 0;
    let outlierCount = 0;
    for (let y = corner.minY; y <= corner.maxY; y += step) {
      for (let x = corner.minX; x <= corner.maxX; x += step) {
        const referenceX = corner.name.includes('right') ? Math.max(corner.refX, x - referenceDepthX) : Math.min(corner.refX, x + referenceDepthX);
        const referenceY = corner.name.includes('bottom') ? Math.max(corner.refY, y - referenceDepthY) : Math.min(corner.refY, y + referenceDepthY);
        const delta = wearDeltaBetweenPixels(px, width, x, y, referenceX, referenceY);
        deltaSum += delta;
        sampleCount++;
        if (delta >= 22) outlierCount++;
      }
    }

    const meanDelta = sampleCount ? deltaSum / sampleCount : 0;
    const outlierPct = sampleCount ? (outlierCount / sampleCount) * 100 : 0;
    return {
      name: corner.name,
      bounds: { minX: corner.minX, minY: corner.minY, maxX: corner.maxX, maxY: corner.maxY },
      meanDelta,
      outlierPct,
      score: (meanDelta * 1.2) + (outlierPct * 0.85)
    };
  })
    .filter((corner) => corner.score >= 18)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

function borderWearPoint(
  card: ContentBounds,
  side: 'left' | 'right' | 'top' | 'bottom',
  along: number,
  depth: number
): { x: number; y: number } {
  switch (side) {
    case 'left':
      return { x: card.minX + depth, y: along };
    case 'right':
      return { x: card.maxX - depth, y: along };
    case 'top':
      return { x: along, y: card.minY + depth };
    case 'bottom':
      return { x: along, y: card.maxY - depth };
  }
}

function wearDeltaBetweenPixels(
  px: Uint8ClampedArray,
  width: number,
  xA: number,
  yA: number,
  xB: number,
  yB: number
): number {
  const indexA = (yA * width + xA) * 4;
  const indexB = (yB * width + xB) * 4;

  const rA = px[indexA];
  const gA = px[indexA + 1];
  const bA = px[indexA + 2];
  const rB = px[indexB];
  const gB = px[indexB + 1];
  const bB = px[indexB + 2];

  const colorDelta = (Math.abs(rA - rB) + Math.abs(gA - gB) + Math.abs(bA - bB)) / 3;
  const lumaDelta = Math.abs(
    (rA * 0.299 + gA * 0.587 + bA * 0.114)
    - (rB * 0.299 + gB * 0.587 + bB * 0.114)
  );
  return colorDelta * 0.7 + lumaDelta * 0.45;
}

function summarizeWearDeltas(
  deltas: number[],
  baselineOverride?: number,
  thresholdOverride?: number
): { mean: number; baseline: number; threshold: number; outlierPct: number } {
  if (deltas.length === 0) {
    return {
      mean: 0,
      baseline: baselineOverride ?? 0,
      threshold: thresholdOverride ?? 0,
      outlierPct: 0
    };
  }

  const sorted = [ ...deltas ].sort((a, b) => a - b);
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const baseline = baselineOverride ?? percentile(sorted, 0.5);
  const spread = percentile(sorted, 0.75) - percentile(sorted, 0.25);
  const threshold = thresholdOverride ?? Math.max(14, baseline + Math.max(4, spread * 1.8));
  const outlierCount = deltas.reduce((sum, value) => sum + (value >= threshold ? 1 : 0), 0);
  return {
    mean,
    baseline,
    threshold,
    outlierPct: (outlierCount / deltas.length) * 100
  };
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const clampedFraction = Math.max(0, Math.min(1, fraction));
  const position = clampedFraction * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * weight;
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

function computeLumaStats(
  px: Uint8ClampedArray,
  width: number,
  height: number
): {
  meanLuma: number;
  stdLuma: number;
  blurVariance: number;
  shadowClipFrac: number;
  highlightClipFrac: number;
} {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 320));
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let lapCount = 0;
  let lapSum = 0;
  let lapSumSq = 0;
  let shadowClipCount = 0;
  let highlightClipCount = 0;

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
      if (c <= 18) shadowClipCount++;
      if (c >= 238) highlightClipCount++;

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
  return {
    meanLuma,
    stdLuma,
    blurVariance,
    shadowClipFrac: count ? shadowClipCount / count : 0,
    highlightClipFrac: count ? highlightClipCount / count : 0
  };
}

function computeCanvasConfidence(blurVariance: number, meanLuma: number, stdLuma: number, hasBounds: boolean): number {
  const blurScore = clamp01((blurVariance - 18) / 160);
  const exposureScore = clamp01(1 - Math.abs(meanLuma - 128) / 128);
  const contrastScore = clamp01(stdLuma / 64);
  const boundsScore = hasBounds ? 1 : 0.65;
  return clamp01(0.25 + 0.35 * blurScore + 0.2 * exposureScore + 0.12 * contrastScore + 0.08 * boundsScore);
}

export function buildCanvasQualityAssessment(args: {
  stats: ReturnType<typeof computeLumaStats>;
  sourceWidth: number;
  sourceHeight: number;
  cardBounds: ContentBounds | null;
  innerBounds: ContentBounds | null;
  borderConfidence: BorderConfidenceAssessment;
}): QualityAssessment {
  const {
    stats,
    sourceWidth,
    sourceHeight,
    cardBounds,
    innerBounds,
    borderConfidence
  } = args;
  const longEdgePx = Math.max(sourceWidth, sourceHeight);
  const cardDetected = !!cardBounds;
  const cardTouchesFrame = !cardBounds
    ? true
    : cardBounds.minX <= 2
      || cardBounds.minY <= 2
      || cardBounds.maxX >= sourceWidth - 3
      || cardBounds.maxY >= sourceHeight - 3;
  const borderReliabilityLow = borderConfidence.severity === 'high';
  const fullFrontVisible = !!cardBounds && !cardTouchesFrame && !borderReliabilityLow;
  const cardW = cardBounds ? Math.max(1, cardBounds.maxX - cardBounds.minX + 1) : 0;
  const cardH = cardBounds ? Math.max(1, cardBounds.maxY - cardBounds.minY + 1) : 0;
  const areaFrac = cardDetected ? (cardW * cardH) / Math.max(1, sourceWidth * sourceHeight) : 0;
  const aspectError = cardDetected
    ? Math.abs(Math.log((cardW / Math.max(1, cardH)) / (TUNING.cardWidthCm / TUNING.cardHeightCm)))
    : Number.POSITIVE_INFINITY;
  const clippingPct = (stats.shadowClipFrac + stats.highlightClipFrac) * 100;

  const checks: QualityCheck[] = [
    {
      key: 'blur',
      label: 'Blur',
      observed: stats.blurVariance < TUNING.blurVarianceThreshold,
      severity: stats.blurVariance < 18 ? 'high' : stats.blurVariance < 40 ? 'moderate' : stats.blurVariance < TUNING.blurVarianceThreshold ? 'low' : 'none',
      metric: `Laplacian variance ${stats.blurVariance.toFixed(1)}`,
      note: 'Blur reduces confidence in corner, edge, and fine surface assessment.',
      impactsObservability: true
    },
    {
      key: 'glare',
      label: 'Glare / reflections',
      observed: clippingPct > 3,
      severity: clippingPct > 14 ? 'high' : clippingPct > 8 ? 'moderate' : clippingPct > 3 ? 'low' : 'none',
      metric: `Tone clipping ${clippingPct.toFixed(1)}%`,
      note: 'Clipped highlights or shadows can hide or exaggerate visible front defects.',
      impactsObservability: true
    },
    {
      key: 'low_resolution',
      label: 'Resolution',
      observed: longEdgePx < 1400,
      severity: longEdgePx < TUNING.lowResolutionLongEdgePx ? 'high' : longEdgePx < TUNING.moderateResolutionLongEdgePx ? 'moderate' : longEdgePx < 1400 ? 'low' : 'none',
      metric: `${sourceWidth}x${sourceHeight}px`,
      note: 'Lower resolution limits detection of slight wear and narrow edge defects.',
      impactsObservability: true
    },
    {
      key: 'occlusion',
      label: 'Occlusion',
      observed: cardDetected && areaFrac < 0.38 && cardTouchesFrame,
      severity: !cardDetected ? 'high' : areaFrac < 0.28 ? 'high' : areaFrac < 0.38 && cardTouchesFrame ? 'moderate' : 'none',
      metric: cardDetected ? `Card area ${(areaFrac * 100).toFixed(1)}% of frame` : undefined,
      note: 'A partially obscured or heavily cropped card image reduces grading reliability.',
      impactsObservability: true
    },
    {
      key: 'cropping',
      label: 'Cropping issues',
      observed: cardTouchesFrame,
      severity: !cardDetected ? 'high' : cardTouchesFrame ? 'high' : 'none',
      metric: cardDetected ? `Bounds ${cardW}x${cardH}px` : undefined,
      note: 'The full front should be visible to evaluate borders and perimeter wear conservatively.',
      impactsObservability: true
    },
    {
      key: 'perspective',
      label: 'Perspective distortion',
      observed: aspectError > 0.06,
      severity: aspectError > 0.22 ? 'high' : aspectError > 0.12 ? 'moderate' : aspectError > 0.06 ? 'low' : 'none',
      metric: Number.isFinite(aspectError) ? `Aspect error ${aspectError.toFixed(3)}` : undefined,
      note: 'Perspective distortion can bias centering measurements if rectification is imperfect.',
      impactsObservability: true
    },
    {
      key: 'full_front_border',
      label: 'Full front border visibility',
      observed: !innerBounds || borderConfidence.severity !== 'none',
      severity: !innerBounds
        ? 'high'
        : borderConfidence.severity,
      metric: !innerBounds
        ? 'Inner frame not detected'
        : `Inner frame detected; ${borderConfidence.metric}`,
      note: !innerBounds
        ? 'If the front border-to-art transition is not detectable, centering confidence is limited.'
        : borderConfidence.note,
      impactsObservability: true
    }
  ];

  const penalty = checks.reduce((sum, check) => {
    switch (check.severity) {
      case 'high':
        return sum + 0.22;
      case 'moderate':
        return sum + 0.12;
      case 'low':
        return sum + 0.05;
      default:
        return sum;
    }
  }, 0);
  const baseScore = computeCanvasConfidence(stats.blurVariance, stats.meanLuma, stats.stdLuma, !!cardBounds && !!innerBounds);
  const imageQualityScore = clamp01(baseScore - penalty + (cardDetected ? 0.06 : 0));

  return {
    readable: cardDetected && stats.blurVariance >= 8 && longEdgePx >= 400,
    imageQualityScore,
    blurVariance: stats.blurVariance,
    meanLuma: stats.meanLuma,
    stdLuma: stats.stdLuma,
    resolution: { width: sourceWidth, height: sourceHeight, longEdgePx },
    cardDetected,
    fullFrontVisible,
    checks
  };
}

export function observabilityCeilingFromQuality(quality: QualityAssessment): GradeCeilingAssessment {
  const highCount = quality.checks.filter((check) => check.impactsObservability && check.severity === 'high').length;
  const moderateCount = quality.checks.filter((check) => check.impactsObservability && check.severity === 'moderate').length;
  const lowCount = quality.checks.filter((check) => check.impactsObservability && check.severity === 'low').length;

  if (!quality.cardDetected || !quality.readable) {
    return gradeCapReason('confidence', { gradeLabel: 'PR 1', psaNumeric: 1 }, 'Image quality or card localization is too poor for a reliable front-only estimate.');
  }
  if (!quality.fullFrontVisible) {
    return gradeCapReason('confidence', { gradeLabel: 'EX 5', psaNumeric: 5 }, 'Full front borders are not completely visible, so high-grade outcomes are not supportable.');
  }
  if (highCount >= 2) {
    return gradeCapReason('confidence', { gradeLabel: 'VG-EX 4', psaNumeric: 4 }, 'Multiple severe observability issues make the estimate highly conservative.');
  }
  if (highCount === 1) {
    return gradeCapReason('confidence', { gradeLabel: 'EX-MT 6', psaNumeric: 6 }, 'One severe observability issue limits how high the pre-grade can reasonably go.');
  }
  if (moderateCount >= 2) {
    return gradeCapReason('confidence', { gradeLabel: 'NM 7', psaNumeric: 7 }, 'Multiple moderate image-quality issues reduce confidence in slight-defect detection.');
  }
  if (moderateCount === 1 || lowCount >= 3) {
    return gradeCapReason('confidence', { gradeLabel: 'NM-MT 8', psaNumeric: 8 }, 'Some observability limits remain, so the estimate is capped conservatively.');
  }
  if (lowCount >= 1) {
    return gradeCapReason('confidence', { gradeLabel: 'MINT 9', psaNumeric: 9 }, 'Minor image-quality limits remain even though the card is generally scorable.');
  }
  return gradeCapReason('confidence', { gradeLabel: 'GEM-MT 10', psaNumeric: 10 }, 'Image quality is strong enough that observability does not materially lower the grade ceiling.');
}

function buildCanvasUnscorableReasons(quality: QualityAssessment, innerBounds: ContentBounds | null): UnscorableReason[] {
  const reasons: UnscorableReason[] = [];
  const borderVisibilityCheck = quality.checks.find((check) => check.key === 'full_front_border');
  const severeBorderVisibility = borderVisibilityCheck?.severity === 'high';
  if (!quality.cardDetected) {
    reasons.push({
      code: 'CARD_NOT_FOUND',
      message: 'Could not reliably localize the full card front in the image.'
    });
  } else {
    if (!innerBounds) {
      reasons.push({
        code: 'BORDER_NOT_DETECTABLE',
        message: 'Could not reliably detect the inner border-to-art boundary needed for centering.'
      });
    }
  }

  // Do not force UNSCORABLE solely from conservative visibility flags if centering is still measurable.
  if (quality.cardDetected && !quality.fullFrontVisible && (!innerBounds || severeBorderVisibility)) {
    reasons.push({
      code: 'CARD_PARTIAL',
      message: borderVisibilityCheck?.metric
        ? `Full-border confidence is too low for reliable grading (${borderVisibilityCheck.metric}).`
        : 'The full card front is not fully visible, so a PSA-style front grade is not reliable.'
    });
  }

  const blurCheck = quality.checks.find((check) => check.key === 'blur');
  if (blurCheck?.severity === 'high') {
    reasons.push({
      code: 'BLURRY',
      message: blurCheck.metric
        ? `Image blur is too high for reliable grading (${blurCheck.metric}).`
        : 'Image blur is too high for reliable grading.'
    });
  }

  const glareCheck = quality.checks.find((check) => check.key === 'glare');
  if (glareCheck?.severity === 'high') {
    reasons.push({
      code: 'GLARE',
      message: glareCheck.metric
        ? `Strong glare/reflection detected (${glareCheck.metric}).`
        : 'Strong glare/reflection detected.'
    });
  }

  const perspectiveCheck = quality.checks.find((check) => check.key === 'perspective');
  if (perspectiveCheck?.severity === 'high') {
    reasons.push({
      code: 'EXTREME_SKEW',
      message: perspectiveCheck.metric
        ? `Perspective distortion is too high for reliable border measurement (${perspectiveCheck.metric}).`
        : 'Perspective distortion is too high for reliable border measurement.'
    });
  }

  return reasons;
}

export function buildStructuredGradeReport(args: {
  imageName?: string;
  quality: QualityAssessment;
  centering: CenteringResult | undefined;
  flaws: FlawResult | undefined;
  confidenceCeiling: GradeCeilingAssessment;
  finalGradeLabel: string;
  finalGradeNumeric: number;
  confidence: number;
  assumptions?: string[];
  limitations?: string[];
}): StructuredGradeReport {
  const {
    imageName,
    quality,
    centering,
    flaws,
    confidenceCeiling,
    finalGradeLabel,
    finalGradeNumeric,
    confidence,
    assumptions = [],
    limitations = []
  } = args;
  const centeringCeiling = centering
    ? gradeCapReason('centering', centering.gradeCap, `Worse front centering axis ${centering.worst.axis} measured ${centering.worst.ratio}.`)
    : gradeCapReason('centering', { gradeLabel: 'PR 1', psaNumeric: 1 }, 'Centering could not be measured reliably from the provided front image.');
  const visibleDefectCeiling = flaws
    ? gradeCapReason(
      'visible_defect',
      flaws.gradeCap,
      flaws.items.length
        ? `Visible front findings total ${flaws.effectivePoints ?? flaws.totalPoints} rubric points.`
        : 'No visible front findings crossed the configured thresholds.'
    )
    : gradeCapReason('visible_defect', { gradeLabel: 'GEM-MT 10', psaNumeric: 10 }, 'No visible front defects were evaluated.');
  const confidenceBand = confidenceBandFromScore(confidence);
  const qualityIssues = quality.checks.filter((check) => check.severity !== 'none');
  const detectedDefects = flaws?.detectedFindings ?? [];
  const topReasons = [
    centeringCeiling.reason,
    visibleDefectCeiling.reason,
    confidenceCeiling.reason,
    ...summarizeFinding(detectedDefects)
  ].slice(0, 4);
  const topChangeDrivers = [
    ...qualityIssues.map((check) => check.note),
    ...(flaws?.notReliablyObservable ?? [])
  ].slice(0, 4);
  const mergedLimitations = [
    ...limitations,
    ...(flaws?.notReliablyObservable ?? [])
  ];

  return {
    imageName,
    cardDetected: quality.cardDetected,
    fullFrontVisible: quality.fullFrontVisible,
    imageQuality: quality,
    frontCenteringLR: centering?.lr.ratio,
    frontCenteringTB: centering?.tb.ratio,
    effectiveFrontCentering: centering?.worst.ratio,
    cornerFindings: flaws?.cornerFindings ?? [],
    edgeFindings: flaws?.edgeFindings ?? [],
    surfaceFindings: flaws?.surfaceFindings ?? [],
    shapeFindings: flaws?.shapeFindings ?? [],
    detectedDefects,
    defectPointsTotal: flaws?.effectivePoints ?? flaws?.totalPoints ?? 0,
    centeringGradeCeiling: centeringCeiling,
    visibleDefectGradeCeiling: visibleDefectCeiling,
    confidenceGradeCeiling: confidenceCeiling,
    finalGradeLabel,
    finalGradeNumeric,
    confidenceBand,
    manualReviewRequired: confidenceBand !== 'high' || qualityIssues.length > 0 || !quality.fullFrontVisible,
    assumptions,
    limitations: mergedLimitations,
    topReasons,
    topChangeDrivers
  };
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
      innerRect: { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
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

  const assessed = assessConditionFromFlaws(items);

  return {
    totalPoints: assessed.totalPoints,
    effectivePoints: assessed.effectivePoints,
    condition: assessed.condition,
    pointCondition: assessed.pointCondition,
    matrixCondition: assessed.matrixCondition,
    psaProfile: assessed.psaProfile,
    limitingFlaws: assessed.limitingFlaws,
    gradeCap: assessed.gradeCap,
    items
  };
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
  const effectiveRadiusPx = Math.max(0, radiusPx - TUNING.cornerNaturalRadiusAllowancePx);

  let sev: Severity = 'NONE';
  if (effectiveRadiusPx >= TUNING.cornerRadiusMajorPx) sev = 'Major';
  else if (effectiveRadiusPx >= TUNING.cornerRadiusModeratePx) sev = 'Moderate';
  else if (effectiveRadiusPx >= TUNING.cornerRadiusMinorPx) sev = 'Minor';
  else if (effectiveRadiusPx >= TUNING.cornerRadiusSlightPx) sev = 'Slight';

  gray.delete();
  edges.delete();

  if (sev === 'NONE') return null;
  return {
    category: 'Corner Rounding',
    severity: sev,
    points: severityToPoints(sev),
    metric: `Avg corner radius ≈ ${radiusPx.toFixed(1)} px (${effectiveRadiusPx.toFixed(1)} px over natural allowance)`
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
    cv.rectangle(overlay, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width - 1, rect.y + rect.height - 1), new cv.Scalar(125, 211, 252, 255), 2);

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
  const flawPointsLabel =
    flaws.effectivePoints && flaws.effectivePoints !== flaws.totalPoints
      ? `${flaws.totalPoints}->${flaws.effectivePoints}`
      : `${flaws.totalPoints}`;
  cv.putText(
    overlay,
    `Flaw points: ${flawPointsLabel} (${flaws.condition}) cap ${flaws.gradeCap.gradeLabel}`,
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
