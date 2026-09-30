export type StandardsBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type StandardsZone = {
  key: string;
  bounds: StandardsBounds;
  label: string;
};

export type StandardsOverlayGeometry = {
  cardBounds: StandardsBounds;
  innerBounds: StandardsBounds;
  edgeBands: {
    left: StandardsBounds | null;
    right: StandardsBounds | null;
    top: StandardsBounds | null;
    bottom: StandardsBounds | null;
  };
  cornerZones: StandardsZone[];
  surfaceZone: StandardsZone;
  metrics: {
    cardWidthPx: number;
    cardHeightPx: number;
    cornerWidthPx: number;
    cornerHeightPx: number;
    borderSegmentSpanPx: number;
    defaultInnerInsetXPx: number;
    defaultInnerInsetYPx: number;
    surfaceInsetXPx: number;
    surfaceInsetYPx: number;
  };
};

export const STANDARDS_SOURCE_DOCUMENTS = {
  conditioning: 'standards/Card-Conditioning-Standards.pdf',
  overlays: 'standards/Conditioning Overlays.pdf'
} as const;

export const STANDARD_CARD_DIMENSIONS_MM = {
  width: 63.5,
  height: 88.9
} as const;

export const STANDARD_CARD_DIMENSIONS_CM = {
  width: STANDARD_CARD_DIMENSIONS_MM.width / 10,
  height: STANDARD_CARD_DIMENSIONS_MM.height / 10
} as const;

export const CONDITIONING_CENTERING_CAPS = [
  { gradeLabel: 'GEM-MT 10', psaNumeric: 10, maxWorstSidePctFront: 55, summary: 'Sharp corners/surface, full gloss' },
  { gradeLabel: 'MINT 9', psaNumeric: 9, maxWorstSidePctFront: 65, summary: 'One minor flaw allowed' },
  { gradeLabel: 'NM-MT 8', psaNumeric: 8, maxWorstSidePctFront: 70, summary: 'Very slight corner/print/border issues' },
  { gradeLabel: 'NM 7', psaNumeric: 7, maxWorstSidePctFront: 75, summary: 'Slight wear/blemish' },
  { gradeLabel: 'EX-MT 6', psaNumeric: 6, maxWorstSidePctFront: 80, summary: 'Visible wear, minor scratches/defects' },
  { gradeLabel: 'EX 5', psaNumeric: 5, maxWorstSidePctFront: 85, summary: 'Rounded corners, visible wear/loss of gloss' },
  { gradeLabel: 'VG 3', psaNumeric: 3, maxWorstSidePctFront: 90, summary: 'Heavy wear/scuffing/possible creases' },
  { gradeLabel: 'PR 1', psaNumeric: 1, maxWorstSidePctFront: 100, summary: 'Extreme defects' }
] as const;

export const CONDITIONING_MEASUREMENT_THRESHOLDS = {
  scratch: {
    slightCm: 2,
    minorCm: 4,
    moderateCmExclusiveLowerBound: 4
  },
  scuffing: {
    slightCm2: 2,
    minorCm2: 27.72,
    moderateCm2: 55.44,
    majorCm2: 110.88
  },
  edgewear: {
    slightCm: 2,
    minorCm: 8,
    moderateCm: 16
  },
  indentation: {
    slightCount: 1,
    minorMm2: 4,
    moderateMm2: 25
  },
  grime: {
    slightMm2: 2.5,
    minorCm2: 13.75,
    moderateCm2: 27.5
  },
  bend: {
    minorCm: 1,
    moderateCm: 2
  },
  surfaceWear: {
    slightCm2: 0.25,
    minorCm2: 1,
    moderateCm2: 4,
    majorCm2: 16
  },
  curling: {
    slightMm: 5
  },
  fault: {
    slightCm2: 0.25,
    minorCm2: 1,
    moderateCm2: 4,
    majorCm2: 16
  },
  defect: {
    slightCm2: 0.25,
    minorCm2: 0.5,
    moderateCm2: 1
  }
} as const;

export const CONDITIONING_MEASUREMENT_GUIDE = {
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
    notes: ['Major threshold not specified in the workbook']
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
} as const;

export const CONDITIONING_OVERLAY_SPEC = {
  defaultInnerInsetMm: {
    x: 5.08,
    y: 7.11
  },
  surfaceReviewInsetMm: {
    x: 3.18,
    y: 4.45
  },
  cornerWindowMm: {
    x: 7.62,
    y: 10.67
  },
  borderSegmentSpanMm: 2.86
} as const;

export function pxToCardMillimeters(px: number, axisPx: number, physicalMm: number): number {
  return (px / Math.max(1, axisPx)) * physicalMm;
}

export function pxToCardWidthMillimeters(px: number, cardWidthPx: number): number {
  return pxToCardMillimeters(px, cardWidthPx, STANDARD_CARD_DIMENSIONS_MM.width);
}

export function pxToCardHeightMillimeters(px: number, cardHeightPx: number): number {
  return pxToCardMillimeters(px, cardHeightPx, STANDARD_CARD_DIMENSIONS_MM.height);
}

export function mmToCardWidthPx(mm: number, cardWidthPx: number): number {
  return mmToCardAxisPx(mm, cardWidthPx, STANDARD_CARD_DIMENSIONS_MM.width);
}

export function mmToCardHeightPx(mm: number, cardHeightPx: number): number {
  return mmToCardAxisPx(mm, cardHeightPx, STANDARD_CARD_DIMENSIONS_MM.height);
}

export function buildConditioningOverlayGeometry(
  cardBoundsInput: StandardsBounds,
  innerBoundsInput?: StandardsBounds | null
): StandardsOverlayGeometry {
  const cardBounds = normalizeBounds(cardBoundsInput);
  const cardWidthPx = Math.max(1, cardBounds.maxX - cardBounds.minX + 1);
  const cardHeightPx = Math.max(1, cardBounds.maxY - cardBounds.minY + 1);
  const defaultInnerInsetXPx = mmToCardWidthPx(CONDITIONING_OVERLAY_SPEC.defaultInnerInsetMm.x, cardWidthPx);
  const defaultInnerInsetYPx = mmToCardHeightPx(CONDITIONING_OVERLAY_SPEC.defaultInnerInsetMm.y, cardHeightPx);
  const surfaceInsetXPx = mmToCardWidthPx(CONDITIONING_OVERLAY_SPEC.surfaceReviewInsetMm.x, cardWidthPx);
  const surfaceInsetYPx = mmToCardHeightPx(CONDITIONING_OVERLAY_SPEC.surfaceReviewInsetMm.y, cardHeightPx);
  const cornerWidthPx = mmToCardWidthPx(CONDITIONING_OVERLAY_SPEC.cornerWindowMm.x, cardWidthPx);
  const cornerHeightPx = mmToCardHeightPx(CONDITIONING_OVERLAY_SPEC.cornerWindowMm.y, cardHeightPx);
  const borderSegmentSpanPx = mmToCardWidthPx(CONDITIONING_OVERLAY_SPEC.borderSegmentSpanMm, cardWidthPx);
  const fallbackInner = insetBoundsByPixels(cardBounds, defaultInnerInsetXPx, defaultInnerInsetYPx);
  const innerBounds = normalizeBounds(innerBoundsInput ?? fallbackInner);
  const surfaceBase = innerBoundsInput ? innerBounds : cardBounds;
  const surfaceBounds = insetBoundsByPixels(surfaceBase, surfaceInsetXPx, surfaceInsetYPx);

  return {
    cardBounds,
    innerBounds,
    edgeBands: {
      left: createBounds(cardBounds.minX, cardBounds.minY, innerBounds.minX - 1, cardBounds.maxY),
      right: createBounds(innerBounds.maxX + 1, cardBounds.minY, cardBounds.maxX, cardBounds.maxY),
      top: createBounds(cardBounds.minX, cardBounds.minY, cardBounds.maxX, innerBounds.minY - 1),
      bottom: createBounds(cardBounds.minX, innerBounds.maxY + 1, cardBounds.maxX, cardBounds.maxY)
    },
    cornerZones: [
      {
        key: 'top-left',
        label: 'Top-left corner review window',
        bounds: createRequiredBounds(cardBounds.minX, cardBounds.minY, cardBounds.minX + cornerWidthPx - 1, cardBounds.minY + cornerHeightPx - 1)
      },
      {
        key: 'top-right',
        label: 'Top-right corner review window',
        bounds: createRequiredBounds(cardBounds.maxX - cornerWidthPx + 1, cardBounds.minY, cardBounds.maxX, cardBounds.minY + cornerHeightPx - 1)
      },
      {
        key: 'bottom-left',
        label: 'Bottom-left corner review window',
        bounds: createRequiredBounds(cardBounds.minX, cardBounds.maxY - cornerHeightPx + 1, cardBounds.minX + cornerWidthPx - 1, cardBounds.maxY)
      },
      {
        key: 'bottom-right',
        label: 'Bottom-right corner review window',
        bounds: createRequiredBounds(cardBounds.maxX - cornerWidthPx + 1, cardBounds.maxY - cornerHeightPx + 1, cardBounds.maxX, cardBounds.maxY)
      }
    ],
    surfaceZone: {
      key: 'surface-review',
      label: 'Standardized surface review window',
      bounds: surfaceBounds
    },
    metrics: {
      cardWidthPx,
      cardHeightPx,
      cornerWidthPx,
      cornerHeightPx,
      borderSegmentSpanPx,
      defaultInnerInsetXPx,
      defaultInnerInsetYPx,
      surfaceInsetXPx,
      surfaceInsetYPx
    }
  };
}

function mmToCardAxisPx(mm: number, cardAxisPx: number, cardAxisMm: number): number {
  return Math.max(1, Math.round((mm / cardAxisMm) * cardAxisPx));
}

function insetBoundsByPixels(bounds: StandardsBounds, insetXPx: number, insetYPx: number): StandardsBounds {
  const minX = clampInt(bounds.minX + insetXPx, bounds.minX, Math.max(bounds.minX, bounds.maxX - 1));
  const minY = clampInt(bounds.minY + insetYPx, bounds.minY, Math.max(bounds.minY, bounds.maxY - 1));
  const maxX = clampInt(bounds.maxX - insetXPx, Math.min(bounds.maxX, minX + 1), bounds.maxX);
  const maxY = clampInt(bounds.maxY - insetYPx, Math.min(bounds.maxY, minY + 1), bounds.maxY);
  if (maxX <= minX || maxY <= minY) {
    return normalizeBounds(bounds);
  }
  return { minX, minY, maxX, maxY };
}

function normalizeBounds(bounds: StandardsBounds): StandardsBounds {
  const minX = Math.round(Math.min(bounds.minX, bounds.maxX));
  const maxX = Math.round(Math.max(bounds.minX, bounds.maxX));
  const minY = Math.round(Math.min(bounds.minY, bounds.maxY));
  const maxY = Math.round(Math.max(bounds.minY, bounds.maxY));
  return { minX, minY, maxX, maxY };
}

function createRequiredBounds(minX: number, minY: number, maxX: number, maxY: number): StandardsBounds {
  return normalizeBounds({ minX, minY, maxX, maxY });
}

function createBounds(minX: number, minY: number, maxX: number, maxY: number): StandardsBounds | null {
  if (maxX < minX || maxY < minY) return null;
  return normalizeBounds({ minX, minY, maxX, maxY });
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
