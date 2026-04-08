export type GradeLabel =
  | 'GEM-MT 10'
  | 'MINT 9'
  | 'NM-MT 8'
  | 'NM 7'
  | 'EX-MT 6'
  | 'EX 5'
  | 'VG-EX 4'
  | 'VG 3'
  | 'GOOD 2'
  | 'FR 1.5'
  | 'PR 1';

export type GradeCap = {
  gradeLabel: GradeLabel;
  psaNumeric: number; // PSA 10..1 (FR=1.5)
};

export type Severity = 'NONE' | 'Slight' | 'Minor' | 'Moderate' | 'Major';

export type FlawCategory =
  | 'Scratch'
  | 'Scuffing'
  | 'Edgewear'
  | 'Indentation'
  | 'Grime'
  | 'Bend'
  | 'Surface Wear'
  | 'Curling'
  | 'Fault'
  | 'Defect'
  | 'Damage'
  | 'Corner Rounding';

export type TcgCondition =
  | 'Near Mint'
  | 'Lightly Played'
  | 'Moderately Played'
  | 'Heavily Played'
  | 'Damaged';

export type RubricFlawInput = {
  category: FlawCategory;
  severity: Exclude<Severity, 'NONE'>;
  points: number;
};

export type ConditionAssessment = {
  condition: TcgCondition;
  tcgCondition: TcgCondition;
  pointCondition: TcgCondition;
  matrixCondition: TcgCondition;
  totalPoints: number;
  effectivePoints: number;
  psaProfile: string;
  gradeCap: GradeCap;
  limitingFlaws: Array<{
    category: FlawCategory;
    severity: Exclude<Severity, 'NONE'>;
    condition: TcgCondition;
  }>;
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
  { gradeLabel: 'GEM-MT 10', psaNumeric: 10, maxWorstSidePctFront: 55, summary: 'Sharp corners/surface, full gloss' },
  { gradeLabel: 'MINT 9', psaNumeric: 9, maxWorstSidePctFront: 65, summary: 'One minor flaw allowed' },
  { gradeLabel: 'NM-MT 8', psaNumeric: 8, maxWorstSidePctFront: 70, summary: 'Very slight corner/print/border issues' },
  { gradeLabel: 'NM 7', psaNumeric: 7, maxWorstSidePctFront: 75, summary: 'Slight wear/blemish' },
  { gradeLabel: 'EX-MT 6', psaNumeric: 6, maxWorstSidePctFront: 80, summary: 'Visible wear, minor scratches/defects' },
  // 5 and 4 share 85/15 front centering; flaw profile decides between them.
  { gradeLabel: 'EX 5', psaNumeric: 5, maxWorstSidePctFront: 85, summary: 'Rounded corners, visible wear/loss of gloss' },
  // 3, 2, 1.5, and 1 share 90/10 front centering; flaw profile decides among them.
  { gradeLabel: 'VG 3', psaNumeric: 3, maxWorstSidePctFront: 90, summary: 'Heavy wear/scuffing/possible creases' },
  { gradeLabel: 'PR 1', psaNumeric: 1, maxWorstSidePctFront: 100, summary: 'Extreme defects' }
];

export const CENTERING_FRONT_CAPS: Array<{ maxWorstSidePct: number; cap: GradeCap; }> = [
  // Worst side percentage: e.g. 55/45 => worstSidePct=55
  { maxWorstSidePct: 55, cap: { gradeLabel: 'GEM-MT 10', psaNumeric: 10 } },
  { maxWorstSidePct: 65, cap: { gradeLabel: 'MINT 9', psaNumeric: 9 } },
  { maxWorstSidePct: 70, cap: { gradeLabel: 'NM-MT 8', psaNumeric: 8 } },
  { maxWorstSidePct: 75, cap: { gradeLabel: 'NM 7', psaNumeric: 7 } },
  { maxWorstSidePct: 80, cap: { gradeLabel: 'EX-MT 6', psaNumeric: 6 } },
  { maxWorstSidePct: 85, cap: { gradeLabel: 'EX 5', psaNumeric: 5 } },
  { maxWorstSidePct: 90, cap: { gradeLabel: 'VG 3', psaNumeric: 3 } },
  { maxWorstSidePct: 100, cap: { gradeLabel: 'PR 1', psaNumeric: 1 } }
];

export function centeringCapFromWorstSidePct( worstSidePct: number ): GradeCap {
  for ( const row of CENTERING_FRONT_CAPS ) {
    if ( worstSidePct <= row.maxWorstSidePct ) return row.cap;
  }
  return { gradeLabel: 'PR 1', psaNumeric: 1 };
}

type WorkbookFlawCategory = Exclude<FlawCategory, 'Corner Rounding'>;

const SEVERITY_RANK: Record<Severity, number> = {
  NONE: 0,
  Slight: 1,
  Minor: 2,
  Moderate: 3,
  Major: 4
};

const CONDITION_RANK: Record<TcgCondition, number> = {
  'Near Mint': 0,
  'Lightly Played': 1,
  'Moderately Played': 2,
  'Heavily Played': 3,
  Damaged: 4
};

// PSA-normalized flaw point bands used for the condition floor.
// These bands are intentionally wider than the cap table so the final cap can
// still distinguish adjacent PSA outcomes within the same broad condition.
const PSA_FLAW_POINT_BANDS: Array<{
  condition: TcgCondition;
  minPoints: number;
  maxPoints: number | null;
}> = [
    { condition: 'Near Mint', minPoints: 0, maxPoints: 2 },
    { condition: 'Lightly Played', minPoints: 3, maxPoints: 8 },
    { condition: 'Moderately Played', minPoints: 9, maxPoints: 17 },
    { condition: 'Heavily Played', minPoints: 18, maxPoints: 31 },
    { condition: 'Damaged', minPoints: 32, maxPoints: null }
  ];

const PSA_FLAW_PROFILE_CAPS: Array<{ maxPoints: number; condition: string; gradeCap: GradeCap; }> = [
  { maxPoints: 2, condition: 'PSA 10 profile', gradeCap: { gradeLabel: 'GEM-MT 10', psaNumeric: 10 } },
  { maxPoints: 4, condition: 'PSA 9 profile', gradeCap: { gradeLabel: 'MINT 9', psaNumeric: 9 } },
  { maxPoints: 8, condition: 'PSA 8 profile', gradeCap: { gradeLabel: 'NM-MT 8', psaNumeric: 8 } },
  { maxPoints: 12, condition: 'PSA 7 profile', gradeCap: { gradeLabel: 'NM 7', psaNumeric: 7 } },
  { maxPoints: 17, condition: 'PSA 6 profile', gradeCap: { gradeLabel: 'EX-MT 6', psaNumeric: 6 } },
  { maxPoints: 23, condition: 'PSA 5 profile', gradeCap: { gradeLabel: 'EX 5', psaNumeric: 5 } },
  { maxPoints: 31, condition: 'PSA 4 profile', gradeCap: { gradeLabel: 'VG-EX 4', psaNumeric: 4 } },
  { maxPoints: 40, condition: 'PSA 3 profile', gradeCap: { gradeLabel: 'VG 3', psaNumeric: 3 } },
  { maxPoints: 49, condition: 'PSA 2 profile', gradeCap: { gradeLabel: 'GOOD 2', psaNumeric: 2 } },
  { maxPoints: 58, condition: 'PSA 1.5 profile', gradeCap: { gradeLabel: 'FR 1.5', psaNumeric: 1.5 } },
  { maxPoints: Number.POSITIVE_INFINITY, condition: 'PSA 1 profile', gradeCap: { gradeLabel: 'PR 1', psaNumeric: 1 } }
];

function validateRubricInvariants(): void {
  for ( let index = 0; index < PSA_FLAW_POINT_BANDS.length; index++ ) {
    const band = PSA_FLAW_POINT_BANDS[ index ];
    if ( index === 0 && band.minPoints !== 0 ) {
      throw new Error( 'PSA_FLAW_POINT_BANDS must start at minPoints=0.' );
    }
    if ( index > 0 ) {
      const previous = PSA_FLAW_POINT_BANDS[ index - 1 ];
      if ( previous.maxPoints == null ) {
        throw new Error( 'PSA_FLAW_POINT_BANDS cannot have entries after an open-ended band.' );
      }
      if ( band.minPoints !== previous.maxPoints + 1 ) {
        throw new Error( 'PSA_FLAW_POINT_BANDS must be contiguous without gaps or overlaps.' );
      }
    }
  }

  let previousMax = Number.NEGATIVE_INFINITY;
  for ( const cap of PSA_FLAW_PROFILE_CAPS ) {
    if ( cap.maxPoints <= previousMax ) {
      throw new Error( 'PSA_FLAW_PROFILE_CAPS must be strictly increasing by maxPoints.' );
    }
    previousMax = cap.maxPoints;
  }
}

validateRubricInvariants();

export const PSA_FLAW_CONDITION_MATRIX: Record<
  Exclude<TcgCondition, 'Damaged'>,
  Record<WorkbookFlawCategory, Severity>
> = {
  'Near Mint': {
    Scratch: 'Minor',
    Scuffing: 'Slight',
    Edgewear: 'Slight',
    Indentation: 'Slight',
    Grime: 'NONE',
    Bend: 'NONE',
    'Surface Wear': 'Slight',
    Curling: 'Slight',
    Fault: 'NONE',
    Defect: 'Slight',
    Damage: 'NONE'
  },
  'Lightly Played': {
    Scratch: 'Minor',
    Scuffing: 'Minor',
    Edgewear: 'Minor',
    Indentation: 'Minor',
    Grime: 'Slight',
    Bend: 'Minor',
    'Surface Wear': 'Minor',
    Curling: 'Slight',
    Fault: 'NONE',
    Defect: 'Minor',
    Damage: 'NONE'
  },
  'Moderately Played': {
    Scratch: 'Moderate',
    Scuffing: 'Moderate',
    Edgewear: 'Moderate',
    Indentation: 'Moderate',
    Grime: 'Moderate',
    Bend: 'Moderate',
    'Surface Wear': 'Moderate',
    Curling: 'Slight',
    Fault: 'Slight',
    Defect: 'Minor',
    Damage: 'NONE'
  },
  'Heavily Played': {
    Scratch: 'Major',
    Scuffing: 'Major',
    Edgewear: 'Major',
    Indentation: 'Major',
    Grime: 'Major',
    Bend: 'Major',
    'Surface Wear': 'Major',
    Curling: 'Slight',
    Fault: 'Minor',
    Defect: 'Moderate',
    Damage: 'NONE'
  }
};

// Backward-compatible alias retained for external consumers.
export const TCGPLAYER_CONDITION_MATRIX = PSA_FLAW_CONDITION_MATRIX;

export const PSA_MEASUREMENT_GUIDE: Partial<Record<WorkbookFlawCategory, {
  measuredBy: string;
  thresholds: Partial<Record<Exclude<Severity, 'NONE'>, string>>;
  notes?: string[];
}>> = {
  Scratch: {
    measuredBy: 'Sum of length',
    thresholds: {
      Slight: '2cm',
      Minor: '4cm',
      Moderate: '>4cm'
    }
  },
  Scuffing: {
    measuredBy: 'Area',
    thresholds: {
      Slight: '2cm²',
      Minor: '27.72cm²',
      Moderate: '55.44cm²',
      Major: '110.88cm²'
    },
    notes: [
      'For holographic, embossed, etched, or glitter finishes, broad factory texture should not be scored as scuffing by itself.',
      'Prefer localized disruptions, gloss breaks, or non-uniform patches that stand apart from the card\'s expected finish pattern.'
    ]
  },
  Edgewear: {
    measuredBy: 'Sum of length',
    thresholds: {
      Slight: '2cm',
      Minor: '8cm',
      Moderate: '16cm',
      Major: '>16cm'
    }
  },
  Indentation: {
    measuredBy: 'Sum of area or count',
    thresholds: {
      Slight: '1 count',
      Minor: '4mm²',
      Moderate: '25mm²',
      Major: '>25mm²'
    },
    notes: [
      'Slight: pinpoint, cannot show through the other side',
      'Minor: cannot show through the other side',
      'Moderate: can show through the other side'
    ]
  },
  Grime: {
    measuredBy: 'Area',
    thresholds: {
      Slight: '2.5mm²',
      Minor: '13.75cm²',
      Moderate: '27.5cm²'
    },
    notes: [ 'Major threshold not specified in the workbook' ]
  },
  Bend: {
    measuredBy: 'Sum of length',
    thresholds: {
      Minor: '1cm',
      Moderate: '2cm',
      Major: '>2cm'
    }
  },
  'Surface Wear': {
    measuredBy: 'Area',
    thresholds: {
      Slight: '0.25cm²',
      Minor: '1cm²',
      Moderate: '4cm²',
      Major: '16cm²'
    },
    notes: [
      'On textured foil or embossed stock, decorative sparkle or emboss grain should not be treated as wear unless it becomes localized, inconsistent, or broken.',
      'Border texture should be compared against the expected factory finish before treating it as whitening or surface loss.'
    ]
  },
  Curling: {
    measuredBy: 'Curl height',
    thresholds: {
      Slight: '5mm'
    }
  },
  Fault: {
    measuredBy: 'Area',
    thresholds: {
      Slight: '0.25cm²',
      Minor: '1cm²',
      Moderate: '4cm²',
      Major: '16cm²'
    }
  },
  Defect: {
    measuredBy: 'Area',
    thresholds: {
      Slight: '0.25cm²',
      Minor: '0.50cm²',
      Moderate: '1cm²'
    }
  }
};

// Backward-compatible alias retained for external consumers.
export const TCGPLAYER_MEASUREMENT_GUIDE = PSA_MEASUREMENT_GUIDE;

function rubricCategoryForMatrix( category: FlawCategory ): WorkbookFlawCategory {
  if ( category === 'Corner Rounding' ) return 'Edgewear';
  return category;
}

function pointBandFromTotal( total: number ): { condition: TcgCondition; minPoints: number; maxPoints: number | null; } {
  for ( const band of PSA_FLAW_POINT_BANDS ) {
    if ( band.maxPoints === null || total <= band.maxPoints ) {
      return band;
    }
  }
  return PSA_FLAW_POINT_BANDS[ PSA_FLAW_POINT_BANDS.length - 1 ];
}

function worseCondition( a: TcgCondition, b: TcgCondition ): TcgCondition {
  return CONDITION_RANK[ a ] >= CONDITION_RANK[ b ] ? a : b;
}

function severityFitsWithin( observed: Severity, allowed: Severity ): boolean {
  return SEVERITY_RANK[ observed ] <= SEVERITY_RANK[ allowed ];
}

function psaProfileFromPoints( total: number ): { condition: string; gradeCap: GradeCap; } {
  for ( const row of PSA_FLAW_PROFILE_CAPS ) {
    if ( total <= row.maxPoints ) {
      return { condition: row.condition, gradeCap: row.gradeCap };
    }
  }
  return { condition: 'PSA 1 profile', gradeCap: { gradeLabel: 'PR 1', psaNumeric: 1 } };
}

export function severityToPoints( sev: Severity ): number {
  switch ( sev ) {
    case 'Slight':
      return 1;
    case 'Minor':
      return 4;
    case 'Moderate':
      return 9;
    case 'Major':
      return 16;
    default:
      return 0;
  }
}

export function bestConditionAllowedForFlaw(
  category: FlawCategory,
  severity: Exclude<Severity, 'NONE'>
): TcgCondition {
  const rubricCategory = rubricCategoryForMatrix( category );
  for ( const condition of [ 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played' ] as const ) {
    if ( severityFitsWithin( severity, PSA_FLAW_CONDITION_MATRIX[ condition ][ rubricCategory ] ) ) {
      return condition;
    }
  }
  return 'Damaged';
}

export function assessConditionFromFlaws( items: readonly RubricFlawInput[] ): ConditionAssessment {
  const totalPoints = items.reduce( ( sum, item ) => sum + item.points, 0 );
  const pointBand = pointBandFromTotal( totalPoints );
  let matrixCondition: TcgCondition = 'Near Mint';
  const flawConditions = items.map( ( item ) => {
    const condition = bestConditionAllowedForFlaw( item.category, item.severity );
    matrixCondition = worseCondition( matrixCondition, condition );
    return {
      category: item.category,
      severity: item.severity,
      condition
    };
  } );

  const condition = worseCondition( pointBand.condition, matrixCondition );
  const requiredPoints = PSA_FLAW_POINT_BANDS.find( ( band ) => band.condition === condition )?.minPoints
    ?? PSA_FLAW_POINT_BANDS[ PSA_FLAW_POINT_BANDS.length - 1 ].minPoints;
  const adjustedPoints = Math.max( totalPoints, requiredPoints );
  const psaProfile = psaProfileFromPoints( adjustedPoints );

  return {
    condition,
    tcgCondition: condition,
    pointCondition: pointBand.condition,
    matrixCondition,
    totalPoints,
    effectivePoints: adjustedPoints,
    psaProfile: psaProfile.condition,
    gradeCap: psaProfile.gradeCap,
    limitingFlaws: flawConditions.filter( ( item ) => item.condition === matrixCondition && item.condition !== 'Near Mint' )
  };
}

export function pointsToCondition( total: number ): ConditionAssessment {
  const pointBand = pointBandFromTotal( total );
  const psaProfile = psaProfileFromPoints( total );
  return {
    condition: pointBand.condition,
    tcgCondition: pointBand.condition,
    pointCondition: pointBand.condition,
    matrixCondition: pointBand.condition,
    totalPoints: total,
    effectivePoints: total,
    psaProfile: psaProfile.condition,
    gradeCap: psaProfile.gradeCap,
    limitingFlaws: []
  };
}

export function finalGradeFromCaps( a: GradeCap, b: GradeCap ): GradeCap {
  // Lower PSA number is worse.
  return a.psaNumeric <= b.psaNumeric ? a : b;
}
