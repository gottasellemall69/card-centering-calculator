export type GradeLabel =
  | 'GEM-MT'
  | 'MINT'
  | 'NM-MT'
  | 'NM'
  | 'EX-MT'
  | 'EX'
  | 'VG-EX'
  | 'VG'
  | 'GOOD'
  | 'FR'
  | 'PR';

export type GradeCap = {
  gradeLabel: GradeLabel;
  psaNumeric: number; // PSA 10..1 (FR=1.5)
};

export type FrontGradeDefinition = {
  gradeLabel: GradeLabel;
  psaNumeric: number;
  maxWorstSidePctFront: number;
  summary: string;
};

// Front-only centering definitions derived from the provided PSA guide.
// PSA 10 front centering uses the updated 55/45 threshold.
// Back-of-card centering is intentionally ignored in this project.
export const PSA_FRONT_GRADE_DEFINITIONS: FrontGradeDefinition[] = [
  { gradeLabel: 'GEM-MT', psaNumeric: 10, maxWorstSidePctFront: 55, summary: 'Sharp corners/surface, full gloss' },
  { gradeLabel: 'MINT', psaNumeric: 9, maxWorstSidePctFront: 65, summary: 'One minor flaw allowed' },
  { gradeLabel: 'NM-MT', psaNumeric: 8, maxWorstSidePctFront: 70, summary: 'Very slight corner/print/border issues' },
  { gradeLabel: 'NM', psaNumeric: 7, maxWorstSidePctFront: 75, summary: 'Slight wear/blemish' },
  { gradeLabel: 'EX-MT', psaNumeric: 6, maxWorstSidePctFront: 80, summary: 'Visible wear, minor scratches/defects' },
  // 5 and 4 share 85/15 front centering; flaw profile decides between them.
  { gradeLabel: 'EX', psaNumeric: 5, maxWorstSidePctFront: 85, summary: 'Rounded corners, visible wear/loss of gloss' },
  // 3, 2, 1.5, and 1 share 90/10 front centering; flaw profile decides among them.
  { gradeLabel: 'VG', psaNumeric: 3, maxWorstSidePctFront: 90, summary: 'Heavy wear/scuffing/possible creases' },
  { gradeLabel: 'PR', psaNumeric: 1, maxWorstSidePctFront: 100, summary: 'Extreme defects' }
];

export const CENTERING_FRONT_CAPS: Array<{ maxWorstSidePct: number; cap: GradeCap }> = [
  // Worst side percentage: e.g. 55/45 => worstSidePct=55
  { maxWorstSidePct: 55, cap: { gradeLabel: 'GEM-MT', psaNumeric: 10 } },
  { maxWorstSidePct: 65, cap: { gradeLabel: 'MINT', psaNumeric: 9 } },
  { maxWorstSidePct: 70, cap: { gradeLabel: 'NM-MT', psaNumeric: 8 } },
  { maxWorstSidePct: 75, cap: { gradeLabel: 'NM', psaNumeric: 7 } },
  { maxWorstSidePct: 80, cap: { gradeLabel: 'EX-MT', psaNumeric: 6 } },
  { maxWorstSidePct: 85, cap: { gradeLabel: 'EX', psaNumeric: 5 } },
  { maxWorstSidePct: 90, cap: { gradeLabel: 'VG', psaNumeric: 3 } },
  { maxWorstSidePct: 100, cap: { gradeLabel: 'PR', psaNumeric: 1 } }
];

export function centeringCapFromWorstSidePct(worstSidePct: number): GradeCap {
  for (const row of CENTERING_FRONT_CAPS) {
    if (worstSidePct <= row.maxWorstSidePct) return row.cap;
  }
  return { gradeLabel: 'PR', psaNumeric: 1 };
}

// Severity points mapping from your table.
export type Severity = 'NONE' | 'Slight' | 'Minor' | 'Moderate' | 'Major';

export function severityToPoints(sev: Severity): number {
  switch (sev) {
    case 'Slight':
      return 1;
    case 'Minor':
      return 2;
    case 'Moderate':
      return 4;
    case 'Major':
      return 8;
    default:
      return 0;
  }
}

export function pointsToCondition(total: number): { condition: string; gradeCap: GradeCap } {
  // Front-only flaw-profile mapping aligned to the supplied PSA definitions.
  if (total <= 0) return { condition: 'PSA 10 profile', gradeCap: { gradeLabel: 'GEM-MT', psaNumeric: 10 } };
  if (total <= 1) return { condition: 'PSA 9 profile', gradeCap: { gradeLabel: 'MINT', psaNumeric: 9 } };
  if (total <= 2) return { condition: 'PSA 8 profile', gradeCap: { gradeLabel: 'NM-MT', psaNumeric: 8 } };
  if (total <= 3) return { condition: 'PSA 7 profile', gradeCap: { gradeLabel: 'NM', psaNumeric: 7 } };
  if (total <= 5) return { condition: 'PSA 6 profile', gradeCap: { gradeLabel: 'EX-MT', psaNumeric: 6 } };
  if (total <= 7) return { condition: 'PSA 5 profile', gradeCap: { gradeLabel: 'EX', psaNumeric: 5 } };
  if (total <= 10) return { condition: 'PSA 4 profile', gradeCap: { gradeLabel: 'VG-EX', psaNumeric: 4 } };
  if (total <= 14) return { condition: 'PSA 3 profile', gradeCap: { gradeLabel: 'VG', psaNumeric: 3 } };
  if (total <= 19) return { condition: 'PSA 2 profile', gradeCap: { gradeLabel: 'GOOD', psaNumeric: 2 } };
  if (total <= 27) return { condition: 'PSA 1.5 profile', gradeCap: { gradeLabel: 'FR', psaNumeric: 1.5 } };
  return { condition: 'PSA 1 profile', gradeCap: { gradeLabel: 'PR', psaNumeric: 1 } };
}

export function finalGradeFromCaps(a: GradeCap, b: GradeCap): GradeCap {
  // Lower PSA number is worse.
  return a.psaNumeric <= b.psaNumeric ? a : b;
}
