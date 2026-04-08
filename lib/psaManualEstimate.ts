import type {
  DetectedFinding,
  EvidenceStrength,
  FindingMeasurement,
  FlawItem,
  FlawResult,
  GradeCeilingAssessment,
  GradeResult,
  Observability,
  QualityAssessment,
  UnscorableReason
} from './grader';
import { buildStructuredGradeReport, severityToFindingSeverity } from './grader';
import {
  assessConditionFromFlaws,
  centeringCapFromWorstSidePct,
  finalGradeFromCaps,
  severityToPoints
} from './rubric';

export type ManualFlawObservation = {
  category: FlawItem['category'];
  severity: FlawItem['severity'];
  metric: string;
  location?: string;
  notes?: string[];
  evidenceStrength?: EvidenceStrength;
  observability?: Exclude<Observability, 'not_observable'>;
  measurement?: FindingMeasurement;
};

export type ManualQualityObservation = {
  cardDetected?: boolean;
  fullFrontVisible?: boolean;
  readable?: boolean;
  imageQualityScore?: number;
};

export type ManualPsaObservation = {
  cardName: string;
  centering: {
    lr: [major: number, minor: number];
    tb: [major: number, minor: number];
  };
  flaws: ManualFlawObservation[];
  confidence?: number;
  quality?: ManualQualityObservation;
  assumptions?: string[];
  limitations?: string[];
  notReliablyObservable?: string[];
  notes?: string[];
};

function ratioWorstPct(major: number, minor: number): number {
  const total = Math.max(1, major + minor);
  return (Math.max(major, minor) / total) * 100;
}

function ratioString(major: number, minor: number): string {
  return `${Math.max(major, minor)}/${Math.min(major, minor)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function findingCategoryForManualFlaw(category: FlawItem['category']): DetectedFinding['category'] {
  switch (category) {
    case 'Corner Rounding':
      return 'corners';
    case 'Edgewear':
      return 'edges';
    case 'Curling':
    case 'Bend':
    case 'Damage':
      return 'shape';
    default:
      return 'surface';
  }
}

function defaultEvidenceStrength(severity: FlawItem['severity']): EvidenceStrength {
  switch (severity) {
    case 'Major':
    case 'Moderate':
      return 'high';
    case 'Minor':
      return 'medium';
    default:
      return 'low';
  }
}

function defaultLocationForCategory(category: DetectedFinding['category']): string {
  switch (category) {
    case 'corners':
      return 'corner region';
    case 'edges':
      return 'edge region';
    case 'shape':
      return 'card shape';
    default:
      return 'surface region';
  }
}

function buildManualQualityAssessment(input: ManualPsaObservation): QualityAssessment {
  const imageQualityScore = clamp01(input.quality?.imageQualityScore ?? input.confidence ?? 0.65);
  return {
    readable: input.quality?.readable ?? true,
    imageQualityScore,
    blurVariance: 0,
    meanLuma: 0,
    stdLuma: 0,
    resolution: { width: 0, height: 0, longEdgePx: 0 },
    cardDetected: input.quality?.cardDetected ?? true,
    fullFrontVisible: input.quality?.fullFrontVisible ?? true,
    checks: []
  };
}

function manualConfidenceCeiling(quality: QualityAssessment): GradeCeilingAssessment {
  if (!quality.cardDetected || !quality.readable) {
    return {
      source: 'confidence',
      cap: { gradeLabel: 'PR 1', psaNumeric: 1 },
      reason: 'PR 1: Manual estimate marks the source as unreadable or the full card as not reliably localized.'
    };
  }
  if (!quality.fullFrontVisible) {
    return {
      source: 'confidence',
      cap: { gradeLabel: 'EX 5', psaNumeric: 5 },
      reason: 'EX 5: Manual estimate indicates the full front is not completely visible, so higher-grade outcomes are not supportable.'
    };
  }
  return {
    source: 'confidence',
    cap: { gradeLabel: 'GEM-MT 10', psaNumeric: 10 },
    reason: 'GEM-MT 10: Manual estimate uses reviewer-supplied centering and flaw observations without an additional automated image-quality ceiling.'
  };
}

function manualUnscorableReasons(quality: QualityAssessment): UnscorableReason[] {
  const reasons: UnscorableReason[] = [];
  if (!quality.cardDetected) {
    reasons.push({
      code: 'CARD_NOT_FOUND',
      message: 'Manual estimate marked the full card front as not reliably localized.'
    });
  }
  if (!quality.readable) {
    reasons.push({
      code: 'BLURRY',
      message: 'Manual estimate marked the source image as unreadable.'
    });
  }
  return reasons;
}

export function buildManualPsaEstimate(input: ManualPsaObservation): GradeResult {
  const lrWorst = ratioWorstPct(input.centering.lr[0], input.centering.lr[1]);
  const tbWorst = ratioWorstPct(input.centering.tb[0], input.centering.tb[1]);
  const lrRatio = ratioString(input.centering.lr[0], input.centering.lr[1]);
  const tbRatio = ratioString(input.centering.tb[0], input.centering.tb[1]);

  const centeringWorst = lrWorst >= tbWorst
    ? { axis: 'LR' as const, ratio: lrRatio, worstSidePct: lrWorst }
    : { axis: 'TB' as const, ratio: tbRatio, worstSidePct: tbWorst };
  const centeringCap = centeringCapFromWorstSidePct(centeringWorst.worstSidePct);

  const detectedFindings: DetectedFinding[] = input.flaws.map((flaw, index) => {
    const findingCategory = findingCategoryForManualFlaw(flaw.category);
    return {
      id: `manual-${index}`,
      category: findingCategory,
      flawType: flaw.category.toLowerCase(),
      location: flaw.location ?? defaultLocationForCategory(findingCategory),
      severity: severityToFindingSeverity(flaw.severity),
      evidenceStrength: flaw.evidenceStrength ?? defaultEvidenceStrength(flaw.severity),
      observability: flaw.observability ?? 'observed',
      metric: flaw.metric,
      notes: flaw.notes ?? ['Manual reviewer observation.'],
      measurement: flaw.measurement
    };
  });

  const flawItems: FlawItem[] = input.flaws.map((flaw, index) => ({
    category: flaw.category,
    severity: flaw.severity,
    points: severityToPoints(flaw.severity),
    metric: flaw.metric,
    location: flaw.location ?? detectedFindings[index]?.location,
    evidenceStrength: flaw.evidenceStrength ?? detectedFindings[index]?.evidenceStrength,
    observability: flaw.observability ?? 'observed',
    measurement: flaw.measurement
  }));

  const flawCondition = assessConditionFromFlaws(flawItems);
  const quality = buildManualQualityAssessment(input);
  const confidenceCeiling = manualConfidenceCeiling(quality);
  const gradingCap = finalGradeFromCaps(
    finalGradeFromCaps(centeringCap, flawCondition.gradeCap),
    confidenceCeiling.cap
  );
  const confidence = clamp01(input.confidence ?? quality.imageQualityScore);
  const unscorableReasons = manualUnscorableReasons(quality);
  const unscorable = unscorableReasons.length > 0;

  const centering = {
    lr: { ratio: lrRatio, worstSidePct: lrWorst },
    tb: { ratio: tbRatio, worstSidePct: tbWorst },
    worst: centeringWorst,
    gradeCap: centeringCap,
    debug: {
      rectifiedSize: { w: 0, h: 0 },
      border: {
        leftPx: 0,
        rightPx: 0,
        topPx: 0,
        bottomPx: 0,
        leftPct: 0,
        rightPct: 0,
        topPct: 0,
        bottomPct: 0
      },
      cardRect: { x: 0, y: 0, w: 0, h: 0 },
      innerRect: { x: 0, y: 0, w: 0, h: 0 }
    }
  };

  const flaws: FlawResult = {
    totalPoints: flawCondition.totalPoints,
    effectivePoints: flawCondition.effectivePoints,
    condition: flawCondition.condition,
    pointCondition: flawCondition.pointCondition,
    matrixCondition: flawCondition.matrixCondition,
    psaProfile: flawCondition.psaProfile,
    limitingFlaws: flawCondition.limitingFlaws,
    gradeCap: flawCondition.gradeCap,
    items: flawItems,
    detectedFindings,
    cornerFindings: detectedFindings.filter((finding) => finding.category === 'corners'),
    edgeFindings: detectedFindings.filter((finding) => finding.category === 'edges'),
    surfaceFindings: detectedFindings.filter((finding) => finding.category === 'surface'),
    shapeFindings: detectedFindings.filter((finding) => finding.category === 'shape'),
    notReliablyObservable: input.notReliablyObservable ?? [
      'any reverse-side defects',
      'gloss, print-line, and foil pattern issues not explicitly entered by the reviewer',
      'depth-based indentation or warp without side-angle evidence'
    ]
  };

  const finalGradeLabel = unscorable ? 'UNSCORABLE' : gradingCap.gradeLabel;
  const finalGradeNumeric = unscorable ? 0 : gradingCap.psaNumeric;

  return {
    centering,
    flaws,
    final: {
      unscorable,
      unscorableReasons: unscorable ? unscorableReasons : undefined,
      gradeLabel: finalGradeLabel,
      psaNumeric: finalGradeNumeric,
      confidence
    },
    report: buildStructuredGradeReport({
      imageName: input.cardName,
      quality,
      centering,
      flaws,
      confidenceCeiling,
      finalGradeLabel,
      finalGradeNumeric,
      confidence,
      assumptions: [
        'Centering ratios and visible defects were entered manually by the reviewer.',
        'Front-only estimate.',
        ...(input.assumptions ?? [])
      ],
      limitations: [
        'Manual estimates do not instrument the automated photo-quality metrics; image-quality fields are placeholders unless explicitly supplied.',
        ...(input.limitations ?? [])
      ]
    }),
    debug: {
      manualEstimate: true,
      cardName: input.cardName,
      notes: input.notes ?? [],
      quality,
      confidenceCeiling
    }
  };
}

export const EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_FRONT: ManualPsaObservation = {
  cardName: '1991 Upper Deck Michael Jordan #SP1 (front photo estimate)',
  centering: {
    lr: [54, 46],
    tb: [53, 47]
  },
  flaws: [
    {
      category: 'Edgewear',
      severity: 'Slight',
      metric: 'Very light edge/corner wear visible in front image',
      location: 'top edge',
      notes: ['Observed manually from the front image.']
    },
    {
      category: 'Surface Wear',
      severity: 'Slight',
      metric: 'Minor print/surface noise from scan/photo texture',
      location: 'center',
      notes: ['Front-only estimate from the supplied scan/photo.']
    }
  ],
  confidence: 0.72,
  limitations: [
    'No back-surface, gloss, or print-line inspection.'
  ],
  notes: [
    'Front-only visual estimate'
  ]
};

export const EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_RESULT = buildManualPsaEstimate(
  EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_FRONT
);
