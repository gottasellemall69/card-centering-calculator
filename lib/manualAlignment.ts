export type AffineMatrix = { a: number; b: number; c: number; d: number };

export type ManualImageNormalization = {
  rotationDeg: number;
  skewXDeg: number;
  skewYDeg: number;
  anchor?: { x: number; y: number } | null;
  source?: 'manual' | 'auto';
  confidence?: number | null;
};

export const MAX_MANUAL_ROTATION_DEG = 20;
export const MAX_MANUAL_SKEW_DEG = 20;

export const DEFAULT_MANUAL_IMAGE_NORMALIZATION: ManualImageNormalization = {
  rotationDeg: 0,
  skewXDeg: 0,
  skewYDeg: 0,
  anchor: null,
  source: 'manual',
  confidence: null
};

export function clampFloat(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampManualImageNormalization(
  normalization: ManualImageNormalization | null | undefined
): ManualImageNormalization {
  if (!normalization) return { ...DEFAULT_MANUAL_IMAGE_NORMALIZATION };
  return {
    rotationDeg: clampFloat(Number(normalization.rotationDeg) || 0, -MAX_MANUAL_ROTATION_DEG, MAX_MANUAL_ROTATION_DEG),
    skewXDeg: clampFloat(Number(normalization.skewXDeg) || 0, -MAX_MANUAL_SKEW_DEG, MAX_MANUAL_SKEW_DEG),
    skewYDeg: clampFloat(Number(normalization.skewYDeg) || 0, -MAX_MANUAL_SKEW_DEG, MAX_MANUAL_SKEW_DEG),
    anchor: normalization.anchor && Number.isFinite(normalization.anchor.x) && Number.isFinite(normalization.anchor.y)
      ? { x: normalization.anchor.x, y: normalization.anchor.y }
      : null,
    source: normalization.source === 'auto' ? 'auto' : 'manual',
    confidence: normalization.confidence == null || !Number.isFinite(normalization.confidence)
      ? null
      : clampFloat(normalization.confidence, 0, 1)
  };
}

export function isIdentityNormalization(
  normalization: ManualImageNormalization | null | undefined
): boolean {
  const clamped = clampManualImageNormalization(normalization);
  return Math.abs(clamped.rotationDeg) < 0.001
    && Math.abs(clamped.skewXDeg) < 0.001
    && Math.abs(clamped.skewYDeg) < 0.001;
}

export function formatDegrees(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}°`;
}

export function rotationMatrix(rotationDeg: number): AffineMatrix {
  const angleRad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { a: cos, b: sin, c: -sin, d: cos };
}

export function skewXMatrix(skewDeg: number): AffineMatrix {
  return { a: 1, b: 0, c: Math.tan((skewDeg * Math.PI) / 180), d: 1 };
}

export function skewYMatrix(skewDeg: number): AffineMatrix {
  return { a: 1, b: Math.tan((skewDeg * Math.PI) / 180), c: 0, d: 1 };
}

export function scaleAffineMatrix(matrix: AffineMatrix, scale: number): AffineMatrix {
  return {
    a: matrix.a * scale,
    b: matrix.b * scale,
    c: matrix.c * scale,
    d: matrix.d * scale
  };
}

export function multiplyAffineMatrices(left: AffineMatrix, right: AffineMatrix): AffineMatrix {
  return {
    a: (left.a * right.a) + (left.c * right.b),
    b: (left.b * right.a) + (left.d * right.b),
    c: (left.a * right.c) + (left.c * right.d),
    d: (left.b * right.c) + (left.d * right.d)
  };
}

export function buildNormalizationMatrix(
  normalization: ManualImageNormalization | null | undefined
): AffineMatrix {
  const clamped = clampManualImageNormalization(normalization);
  const rotation = rotationMatrix(clamped.rotationDeg);
  const skewX = skewXMatrix(clamped.skewXDeg);
  const skewY = skewYMatrix(clamped.skewYDeg);
  return multiplyAffineMatrices(rotation, multiplyAffineMatrices(skewY, skewX));
}

export function fitAffineMatrixToSize(
  matrix: AffineMatrix,
  imageSize: { w: number; h: number }
): AffineMatrix {
  const boundsWidth = (Math.abs(matrix.a) * imageSize.w) + (Math.abs(matrix.c) * imageSize.h);
  const boundsHeight = (Math.abs(matrix.b) * imageSize.w) + (Math.abs(matrix.d) * imageSize.h);
  const fitScale = Math.min(
    1,
    imageSize.w / Math.max(1, boundsWidth),
    imageSize.h / Math.max(1, boundsHeight)
  );
  return scaleAffineMatrix(matrix, fitScale);
}

export function buildFittedImageTransform(
  imageSize: { w: number; h: number },
  normalization: ManualImageNormalization | null | undefined
): AffineMatrix {
  return fitAffineMatrixToSize(buildNormalizationMatrix(normalization), imageSize);
}

export function applyAffineToVector(matrix: AffineMatrix, vector: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (matrix.a * vector.x) + (matrix.c * vector.y),
    y: (matrix.b * vector.x) + (matrix.d * vector.y)
  };
}

export function matrixToCss(matrix: AffineMatrix): string {
  return `matrix(${matrix.a.toFixed(6)}, ${matrix.b.toFixed(6)}, ${matrix.c.toFixed(6)}, ${matrix.d.toFixed(6)}, 0, 0)`;
}
