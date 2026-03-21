import type { FlawItem, GradeResult } from './grader';
import {
  centeringCapFromWorstSidePct,
  finalGradeFromCaps,
  pointsToCondition,
  severityToPoints
} from './rubric';

export type ManualFlawObservation = {
  category: FlawItem['category'];
  severity: FlawItem['severity'];
  metric: string;
};

export type ManualPsaObservation = {
  cardName: string;
  centering: {
    lr: [major: number, minor: number];
    tb: [major: number, minor: number];
  };
  flaws: ManualFlawObservation[];
  confidence?: number;
  notes?: string[];
};

function ratioWorstPct(major: number, minor: number): number {
  const total = Math.max(1, major + minor);
  return (Math.max(major, minor) / total) * 100;
}

function ratioString(major: number, minor: number): string {
  return `${Math.max(major, minor)}/${Math.min(major, minor)}`;
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

  const flawItems: FlawItem[] = input.flaws.map((flaw) => ({
    category: flaw.category,
    severity: flaw.severity,
    points: severityToPoints(flaw.severity),
    metric: flaw.metric
  }));
  const totalPoints = flawItems.reduce((sum, flaw) => sum + flaw.points, 0);
  const flawCondition = pointsToCondition(totalPoints);
  const finalCap = finalGradeFromCaps(centeringCap, flawCondition.gradeCap);

  return {
    centering: {
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
    },
    flaws: {
      totalPoints,
      condition: flawCondition.condition,
      gradeCap: flawCondition.gradeCap,
      items: flawItems
    },
    final: {
      unscorable: false,
      gradeLabel: finalCap.gradeLabel,
      psaNumeric: finalCap.psaNumeric,
      confidence: input.confidence ?? 0.65
    },
    debug: {
      manualEstimate: true,
      cardName: input.cardName,
      notes: input.notes ?? []
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
      metric: 'Very light edge/corner wear visible in front image'
    },
    {
      category: 'Surface Wear',
      severity: 'Slight',
      metric: 'Minor print/surface noise from scan/photo texture'
    }
  ],
  confidence: 0.72,
  notes: [
    'Front-only visual estimate',
    'No back-surface, gloss, or print-line inspection'
  ]
};

export const EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_RESULT = buildManualPsaEstimate(
  EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_FRONT
);
