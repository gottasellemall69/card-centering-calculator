'use client';

import { useEffect, useRef, useState } from 'react';

import type { CenteringResult, GradeResult } from '@/lib/grader';
import { centeringCapFromWorstSidePct } from '@/lib/rubric';

const CARD_WIDTH_MM = 64;
const CARD_HEIGHT_MM = 89;
const MIN_CARD_SPAN_PX = 80;
const MIN_INNER_SPAN_PX = 80;
const MIN_BORDER_PX = 6;

type BoundsRect = { minX: number; minY: number; maxX: number; maxY: number };
type GuideState = { cardBounds: BoundsRect; innerBounds: BoundsRect };
type GuideKey =
  | 'cardLeft'
  | 'innerLeft'
  | 'innerRight'
  | 'cardRight'
  | 'cardTop'
  | 'innerTop'
  | 'innerBottom'
  | 'cardBottom';

export type ManualCenteringView = CenteringResult & {
  mm: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
};

export function OverlayViewer({
  imageDataUrl,
  result,
  manualCentering,
  alt,
  onCenteringChange
}: {
  imageDataUrl: string;
  alt: string;
  result: GradeResult;
  manualCentering?: ManualCenteringView | null;
  onCenteringChange?: (value: ManualCenteringView | null) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [guides, setGuides] = useState<GuideState | null>(null);
  const [dragKey, setDragKey] = useState<GuideKey | null>(null);

  useEffect(() => {
    setImageSize(null);
    setGuides(null);
    setDragKey(null);
  }, [imageDataUrl]);

  useEffect(() => {
    if (!imageSize) return;
    setGuides(resolveInitialGuides(result, imageSize, manualCentering ?? null));
  }, [imageDataUrl, result, imageSize]);

  useEffect(() => {
    if (!guides || !imageSize) return;
    onCenteringChange?.(buildManualCentering(guides.cardBounds, guides.innerBounds, imageSize.w, imageSize.h));
  }, [guides, imageSize, onCenteringChange]);

  useEffect(() => {
    if (!dragKey || !imageSize) return;

    const onPointerMove = (event: PointerEvent) => {
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      const nextValue = pointerToImageCoordinate(event.clientX, event.clientY, rect, imageSize, dragKey);
      setGuides((current) => (current ? applyGuideUpdate(current, dragKey, nextValue, imageSize) : current));
    };

    const stopDragging = () => setDragKey(null);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    };
  }, [dragKey, imageSize]);

  const centering = guides && imageSize
    ? buildManualCentering(guides.cardBounds, guides.innerBounds, imageSize.w, imageSize.h)
    : null;

  const resetGuides = () => {
    if (!imageSize) return;
    setGuides(resolveInitialGuides(result, imageSize, manualCentering ?? null));
  };

  return (
    <div className="overlayViewer">
      <div className="overlayViewerToolbar">
        <div className="small">Drag the dotted guides to set the card edge and the inner frame or artwork boundary used for centering.</div>
        <button type="button" className="btn" onClick={resetGuides}>Reset guides</button>
      </div>

      <div className="overlayViewerLayout">
        <aside className="overlayViewerPanel">
          <div className="overlayViewerPanelLabel">Centering</div>
          <div className="overlayViewerMetricTitle">Left / Right</div>
          <div className="overlayViewerMetricMm">
            {centering ? `${centering.mm.left.toFixed(1)}mm / ${centering.mm.right.toFixed(1)}mm` : '—'}
          </div>
          <div className="overlayViewerMetricPct">
            {centering ? `${Math.round(centering.debug.border.leftPct)}% / ${Math.round(centering.debug.border.rightPct)}%` : '—'}
          </div>

          <div className="overlayViewerMetricTitle">Top / Bottom</div>
          <div className="overlayViewerMetricMm">
            {centering ? `${centering.mm.top.toFixed(1)}mm / ${centering.mm.bottom.toFixed(1)}mm` : '—'}
          </div>
          <div className="overlayViewerMetricPct">
            {centering ? `${Math.round(centering.debug.border.topPct)}% / ${Math.round(centering.debug.border.bottomPct)}%` : '—'}
          </div>

          <div className="overlayViewerMetricTitle">Used for grade</div>
          <div className="overlayViewerMetricMm">
            {centering ? `${centering.worst.axis} ${centering.worst.ratio}` : '—'}
          </div>
          <div className="overlayViewerMetricPct">
            {centering ? `Cap ${centering.gradeCap.gradeLabel}` : '—'}
          </div>
        </aside>

        <div className="overlayViewerStage">
          <div className="overlayViewerFrame" ref={frameRef}>
            <img
              className="overlayViewerBase"
              src={imageDataUrl}
              alt={alt}
              onLoad={(event) => {
                const img = event.currentTarget;
                setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
            />

            {guides && imageSize ? (
              <div className="overlayViewerGuides" aria-hidden="true">
                {renderOutsideShade(guides.cardBounds, imageSize)}
                {renderMeasurementBands(guides, imageSize)}
                {renderGuide(
                  'cardLeft',
                  guides.cardBounds.minX,
                  imageSize,
                  'vertical',
                  'overlayGuideOuterLeft',
                  () => setDragKey('cardLeft')
                )}
                {renderGuide(
                  'innerLeft',
                  guides.innerBounds.minX,
                  imageSize,
                  'vertical',
                  'overlayGuideInnerLeft',
                  () => setDragKey('innerLeft')
                )}
                {renderGuide(
                  'innerRight',
                  guides.innerBounds.maxX,
                  imageSize,
                  'vertical',
                  'overlayGuideInnerRight',
                  () => setDragKey('innerRight')
                )}
                {renderGuide(
                  'cardRight',
                  guides.cardBounds.maxX,
                  imageSize,
                  'vertical',
                  'overlayGuideOuterRight',
                  () => setDragKey('cardRight')
                )}
                {renderGuide(
                  'cardTop',
                  guides.cardBounds.minY,
                  imageSize,
                  'horizontal',
                  'overlayGuideOuterTop',
                  () => setDragKey('cardTop')
                )}
                {renderGuide(
                  'innerTop',
                  guides.innerBounds.minY,
                  imageSize,
                  'horizontal',
                  'overlayGuideInnerTop',
                  () => setDragKey('innerTop')
                )}
                {renderGuide(
                  'innerBottom',
                  guides.innerBounds.maxY,
                  imageSize,
                  'horizontal',
                  'overlayGuideInnerBottom',
                  () => setDragKey('innerBottom')
                )}
                {renderGuide(
                  'cardBottom',
                  guides.cardBounds.maxY,
                  imageSize,
                  'horizontal',
                  'overlayGuideOuterBottom',
                  () => setDragKey('cardBottom')
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderGuide(
  key: GuideKey,
  value: number,
  imageSize: { w: number; h: number },
  orientation: 'vertical' | 'horizontal',
  className: string,
  onPointerDown: () => void
) {
  const style = orientation === 'vertical'
    ? ({ left: `${toXPercent(value, imageSize.w)}%` } as React.CSSProperties)
    : ({ top: `${toYPercent(value, imageSize.h)}%` } as React.CSSProperties);

  return (
    <button
      key={key}
      type="button"
      className={`overlayGuide ${orientation === 'vertical' ? 'overlayGuideVertical' : 'overlayGuideHorizontal'} ${className}`}
      style={style}
      onPointerDown={(event) => {
        event.preventDefault();
        onPointerDown();
      }}
      aria-label={key}
    >
      <span className="overlayGuideLine" />
      <span className="overlayGuideHandle">
        <span className="overlayGuideHandleBar" />
        <span className="overlayGuideHandleDots" />
      </span>
    </button>
  );
}

function renderOutsideShade(bounds: BoundsRect, imageSize: { w: number; h: number }) {
  return (
    <>
      <div className="overlayMask" style={{ top: 0, left: 0, right: 0, height: `${toSpanPercent(bounds.minY, imageSize.h)}%` }} />
      <div className="overlayMask" style={{ top: `${toYPercent(bounds.maxY + 1, imageSize.h)}%`, left: 0, right: 0, bottom: 0 }} />
      <div
        className="overlayMask"
        style={{
          top: `${toYPercent(bounds.minY, imageSize.h)}%`,
          left: 0,
          width: `${toSpanPercent(bounds.minX, imageSize.w)}%`,
          height: `${toSpanPercent(bounds.maxY - bounds.minY + 1, imageSize.h)}%`
        }}
      />
      <div
        className="overlayMask"
        style={{
          top: `${toYPercent(bounds.minY, imageSize.h)}%`,
          left: `${toXPercent(bounds.maxX + 1, imageSize.w)}%`,
          right: 0,
          height: `${toSpanPercent(bounds.maxY - bounds.minY + 1, imageSize.h)}%`
        }}
      />
    </>
  );
}

function renderMeasurementBands(guides: GuideState, imageSize: { w: number; h: number }) {
  const { cardBounds, innerBounds } = guides;
  return (
    <>
      <div
        className="overlayBand overlayBandLeft"
        style={{
          left: `${toXPercent(cardBounds.minX, imageSize.w)}%`,
          top: `${toYPercent(cardBounds.minY, imageSize.h)}%`,
          width: `${toSpanPercent(innerBounds.minX - cardBounds.minX, imageSize.w)}%`,
          height: `${toSpanPercent(cardBounds.maxY - cardBounds.minY + 1, imageSize.h)}%`
        }}
      />
      <div
        className="overlayBand overlayBandRight"
        style={{
          left: `${toXPercent(innerBounds.maxX + 1, imageSize.w)}%`,
          top: `${toYPercent(cardBounds.minY, imageSize.h)}%`,
          width: `${toSpanPercent(cardBounds.maxX - innerBounds.maxX, imageSize.w)}%`,
          height: `${toSpanPercent(cardBounds.maxY - cardBounds.minY + 1, imageSize.h)}%`
        }}
      />
      <div
        className="overlayBand overlayBandTop"
        style={{
          left: `${toXPercent(cardBounds.minX, imageSize.w)}%`,
          top: `${toYPercent(cardBounds.minY, imageSize.h)}%`,
          width: `${toSpanPercent(cardBounds.maxX - cardBounds.minX + 1, imageSize.w)}%`,
          height: `${toSpanPercent(innerBounds.minY - cardBounds.minY, imageSize.h)}%`
        }}
      />
      <div
        className="overlayBand overlayBandBottom"
        style={{
          left: `${toXPercent(cardBounds.minX, imageSize.w)}%`,
          top: `${toYPercent(innerBounds.maxY + 1, imageSize.h)}%`,
          width: `${toSpanPercent(cardBounds.maxX - cardBounds.minX + 1, imageSize.w)}%`,
          height: `${toSpanPercent(cardBounds.maxY - innerBounds.maxY, imageSize.h)}%`
        }}
      />
    </>
  );
}

function pointerToImageCoordinate(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  imageSize: { w: number; h: number },
  key: GuideKey
): number {
  if (key === 'cardLeft' || key === 'innerLeft' || key === 'innerRight' || key === 'cardRight') {
    const x = ((clientX - rect.left) / Math.max(1, rect.width)) * (imageSize.w - 1);
    return clampInt(x, 0, Math.max(0, imageSize.w - 1));
  }
  const y = ((clientY - rect.top) / Math.max(1, rect.height)) * (imageSize.h - 1);
  return clampInt(y, 0, Math.max(0, imageSize.h - 1));
}

function applyGuideUpdate(
  guides: GuideState,
  key: GuideKey,
  nextValue: number,
  imageSize: { w: number; h: number }
): GuideState {
  const cardBounds = { ...guides.cardBounds };
  const innerBounds = { ...guides.innerBounds };
  const minCardWidth = Math.min(MIN_CARD_SPAN_PX, Math.max(40, Math.round(imageSize.w * 0.18)));
  const minCardHeight = Math.min(MIN_CARD_SPAN_PX, Math.max(40, Math.round(imageSize.h * 0.18)));
  const minInnerWidth = Math.min(MIN_INNER_SPAN_PX, Math.max(40, Math.round(imageSize.w * 0.18)));
  const minInnerHeight = Math.min(MIN_INNER_SPAN_PX, Math.max(40, Math.round(imageSize.h * 0.18)));
  const minBorderX = Math.min(16, Math.max(MIN_BORDER_PX, Math.round(imageSize.w * 0.01)));
  const minBorderY = Math.min(16, Math.max(MIN_BORDER_PX, Math.round(imageSize.h * 0.01)));

  switch (key) {
    case 'cardLeft':
      cardBounds.minX = clampInt(nextValue, 0, Math.min(cardBounds.maxX - minCardWidth, innerBounds.minX - minBorderX));
      break;
    case 'innerLeft':
      innerBounds.minX = clampInt(nextValue, cardBounds.minX + minBorderX, innerBounds.maxX - minInnerWidth);
      break;
    case 'innerRight':
      innerBounds.maxX = clampInt(nextValue, innerBounds.minX + minInnerWidth, cardBounds.maxX - minBorderX);
      break;
    case 'cardRight':
      cardBounds.maxX = clampInt(nextValue, Math.max(cardBounds.minX + minCardWidth, innerBounds.maxX + minBorderX), imageSize.w - 1);
      break;
    case 'cardTop':
      cardBounds.minY = clampInt(nextValue, 0, Math.min(cardBounds.maxY - minCardHeight, innerBounds.minY - minBorderY));
      break;
    case 'innerTop':
      innerBounds.minY = clampInt(nextValue, cardBounds.minY + minBorderY, innerBounds.maxY - minInnerHeight);
      break;
    case 'innerBottom':
      innerBounds.maxY = clampInt(nextValue, innerBounds.minY + minInnerHeight, cardBounds.maxY - minBorderY);
      break;
    case 'cardBottom':
      cardBounds.maxY = clampInt(nextValue, Math.max(cardBounds.minY + minCardHeight, innerBounds.maxY + minBorderY), imageSize.h - 1);
      break;
  }

  innerBounds.minX = clampInt(innerBounds.minX, cardBounds.minX + minBorderX, innerBounds.maxX - minInnerWidth);
  innerBounds.maxX = clampInt(innerBounds.maxX, innerBounds.minX + minInnerWidth, cardBounds.maxX - minBorderX);
  innerBounds.minY = clampInt(innerBounds.minY, cardBounds.minY + minBorderY, innerBounds.maxY - minInnerHeight);
  innerBounds.maxY = clampInt(innerBounds.maxY, innerBounds.minY + minInnerHeight, cardBounds.maxY - minBorderY);

  return { cardBounds, innerBounds };
}

function resolveInitialGuides(
  result: GradeResult,
  imageSize: { w: number; h: number },
  manualCentering: ManualCenteringView | null
): GuideState {
  const manualCardBounds = rectToBounds(manualCentering?.debug.cardRect);
  const manualInnerBounds = rectToBounds(manualCentering?.debug.innerRect);
  const debug = asRecord(result.debug);
  const sourceSize = parseImageSize(debug?.sourceSize);
  const rectifiedSize = parseImageSize(result.centering?.debug.rectifiedSize);
  const normalizedSize = parseImageSize(debug?.normalizedSize) ?? rectifiedSize;
  const debugCardBounds = parseBoundsRect(debug?.cardBounds);
  const debugCropBounds = parseBoundsRect(debug?.cropBounds);
  const debugNormalizedCardBounds = parseBoundsRect(debug?.normalizedCardBounds);
  const debugInnerBounds = parseBoundsRect(debug?.innerBounds);
  const centeringCardBounds = rectToBounds(result.centering?.debug.cardRect);
  const centeringInnerBounds = rectToBounds(result.centering?.debug.innerRect);

  const sourceCardBounds = sourceSize
    ? clampBounds(
      debugCardBounds ?? (
        normalizedSize && debugCropBounds && debugNormalizedCardBounds
          ? mapNormalizedBoundsToSource(debugNormalizedCardBounds, normalizedSize, debugCropBounds)
          : { minX: 0, minY: 0, maxX: sourceSize.w - 1, maxY: sourceSize.h - 1 }
      ),
      sourceSize.w,
      sourceSize.h
    )
    : null;

  const sourceCropBounds = sourceSize
    ? clampBounds(debugCropBounds ?? sourceCardBounds ?? { minX: 0, minY: 0, maxX: sourceSize.w - 1, maxY: sourceSize.h - 1 }, sourceSize.w, sourceSize.h)
    : null;

  const sourceInnerBounds = sourceSize && normalizedSize && debugInnerBounds && sourceCropBounds
    ? clampBounds(
      mapNormalizedBoundsToSource(debugInnerBounds, normalizedSize, sourceCropBounds),
      sourceSize.w,
      sourceSize.h
    )
    : null;

  const mappedCardBounds = sourceCardBounds && sourceSize
    ? scaleBoundsBetweenSizes(sourceCardBounds, sourceSize, imageSize)
    : (sourceSize && normalizedSize && debugNormalizedCardBounds && debugCropBounds)
      ? scaleBoundsBetweenSizes(
        mapNormalizedBoundsToSource(debugNormalizedCardBounds, normalizedSize, debugCropBounds),
        sourceSize,
        imageSize
      )
      : null;

  const mappedInnerBounds = sourceInnerBounds && sourceSize
    ? scaleBoundsBetweenSizes(sourceInnerBounds, sourceSize, imageSize)
    : (centeringInnerBounds && rectifiedSize)
      ? scaleBoundsBetweenSizes(centeringInnerBounds, rectifiedSize, imageSize)
      : null;

  const cardBounds = clampBounds(
    manualCardBounds
    ?? mappedCardBounds
    ?? (centeringCardBounds && rectifiedSize
      ? scaleBoundsBetweenSizes(centeringCardBounds, rectifiedSize, imageSize)
      : centeringCardBounds)
    ?? { minX: 0, minY: 0, maxX: imageSize.w - 1, maxY: imageSize.h - 1 },
    imageSize.w,
    imageSize.h
  );

  const defaultInsetX = Math.max(10, Math.round((cardBounds.maxX - cardBounds.minX + 1) * 0.08));
  const defaultInsetY = Math.max(10, Math.round((cardBounds.maxY - cardBounds.minY + 1) * 0.08));
  const fallbackInner = {
    minX: cardBounds.minX + defaultInsetX,
    minY: cardBounds.minY + defaultInsetY,
    maxX: cardBounds.maxX - defaultInsetX,
    maxY: cardBounds.maxY - defaultInsetY
  };

  const innerBounds = clampInnerBounds(
    manualInnerBounds
    ?? mappedInnerBounds
    ?? (centeringInnerBounds && rectifiedSize
      ? scaleBoundsBetweenSizes(centeringInnerBounds, rectifiedSize, imageSize)
      : centeringInnerBounds)
    ?? fallbackInner,
    cardBounds,
    imageSize.w,
    imageSize.h
  );

  return { cardBounds, innerBounds };
}

function buildManualCentering(
  cardBounds: BoundsRect,
  innerBounds: BoundsRect,
  width: number,
  height: number
): ManualCenteringView {
  const card = clampBounds(cardBounds, width, height);
  const inner = clampInnerBounds(innerBounds, card, width, height);
  const cardWidth = Math.max(1, card.maxX - card.minX + 1);
  const cardHeight = Math.max(1, card.maxY - card.minY + 1);

  const leftPx = Math.max(1, inner.minX - card.minX);
  const rightPx = Math.max(1, card.maxX - inner.maxX);
  const topPx = Math.max(1, inner.minY - card.minY);
  const bottomPx = Math.max(1, card.maxY - inner.maxY);

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
      cardRect: { x: card.minX, y: card.minY, w: cardWidth, h: cardHeight },
      innerRect: {
        x: inner.minX,
        y: inner.minY,
        w: Math.max(1, inner.maxX - inner.minX),
        h: Math.max(1, inner.maxY - inner.minY)
      }
    },
    mm: {
      left: pxToMillimeters(leftPx, cardWidth, CARD_WIDTH_MM),
      right: pxToMillimeters(rightPx, cardWidth, CARD_WIDTH_MM),
      top: pxToMillimeters(topPx, cardHeight, CARD_HEIGHT_MM),
      bottom: pxToMillimeters(bottomPx, cardHeight, CARD_HEIGHT_MM)
    }
  };
}

function rectToBounds(rect: { x: number; y: number; w: number; h: number } | undefined): BoundsRect | null {
  if (!rect) return null;
  if (![rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value))) return null;
  return {
    minX: rect.x,
    minY: rect.y,
    maxX: rect.x + rect.w,
    maxY: rect.y + rect.h
  };
}

function parseBoundsRect(value: unknown): BoundsRect | null {
  const record = asRecord(value);
  if (!record) return null;
  const minX = asFiniteNumber(record.minX);
  const minY = asFiniteNumber(record.minY);
  const maxX = asFiniteNumber(record.maxX);
  const maxY = asFiniteNumber(record.maxY);
  if (minX != null && minY != null && maxX != null && maxY != null) {
    return { minX, minY, maxX, maxY };
  }
  return null;
}

function parseImageSize(value: unknown): { w: number; h: number } | null {
  const record = asRecord(value);
  if (!record) return null;
  const w = asFiniteNumber(record.w);
  const h = asFiniteNumber(record.h);
  if (w == null || h == null || w <= 1 || h <= 1) return null;
  return { w, h };
}

function scaleBoundsBetweenSizes(
  bounds: BoundsRect,
  sourceSize: { w: number; h: number },
  targetSize: { w: number; h: number }
): BoundsRect {
  return clampBounds(
    {
      minX: (bounds.minX / Math.max(1, sourceSize.w)) * targetSize.w,
      minY: (bounds.minY / Math.max(1, sourceSize.h)) * targetSize.h,
      maxX: (((bounds.maxX + 1) / Math.max(1, sourceSize.w)) * targetSize.w) - 1,
      maxY: (((bounds.maxY + 1) / Math.max(1, sourceSize.h)) * targetSize.h) - 1
    },
    targetSize.w,
    targetSize.h
  );
}

function mapNormalizedBoundsToSource(
  normalizedBounds: BoundsRect,
  normalizedSize: { w: number; h: number },
  sourceBounds: BoundsRect
): BoundsRect {
  const sourceWidth = Math.max(1, sourceBounds.maxX - sourceBounds.minX + 1);
  const sourceHeight = Math.max(1, sourceBounds.maxY - sourceBounds.minY + 1);
  return {
    minX: sourceBounds.minX + (normalizedBounds.minX / Math.max(1, normalizedSize.w)) * sourceWidth,
    minY: sourceBounds.minY + (normalizedBounds.minY / Math.max(1, normalizedSize.h)) * sourceHeight,
    maxX: sourceBounds.minX + (((normalizedBounds.maxX + 1) / Math.max(1, normalizedSize.w)) * sourceWidth) - 1,
    maxY: sourceBounds.minY + (((normalizedBounds.maxY + 1) / Math.max(1, normalizedSize.h)) * sourceHeight) - 1
  };
}

function clampBounds(bounds: BoundsRect, width: number, height: number): BoundsRect {
  const minX = clampInt(bounds.minX, 0, Math.max(0, width - 2));
  const minY = clampInt(bounds.minY, 0, Math.max(0, height - 2));
  const maxX = clampInt(bounds.maxX, minX + 1, Math.max(1, width - 1));
  const maxY = clampInt(bounds.maxY, minY + 1, Math.max(1, height - 1));
  return { minX, minY, maxX, maxY };
}

function clampInnerBounds(bounds: BoundsRect, cardBounds: BoundsRect, width: number, height: number): BoundsRect {
  const clampedCard = clampBounds(cardBounds, width, height);
  const minInnerWidth = Math.min(MIN_INNER_SPAN_PX, Math.max(40, Math.round((clampedCard.maxX - clampedCard.minX + 1) * 0.18)));
  const minInnerHeight = Math.min(MIN_INNER_SPAN_PX, Math.max(40, Math.round((clampedCard.maxY - clampedCard.minY + 1) * 0.18)));
  const minBorderX = Math.min(16, Math.max(MIN_BORDER_PX, Math.round((clampedCard.maxX - clampedCard.minX + 1) * 0.01)));
  const minBorderY = Math.min(16, Math.max(MIN_BORDER_PX, Math.round((clampedCard.maxY - clampedCard.minY + 1) * 0.01)));
  const minX = clampInt(bounds.minX, clampedCard.minX + minBorderX, clampedCard.maxX - minInnerWidth);
  const minY = clampInt(bounds.minY, clampedCard.minY + minBorderY, clampedCard.maxY - minInnerHeight);
  const maxX = clampInt(bounds.maxX, minX + minInnerWidth, clampedCard.maxX - minBorderX);
  const maxY = clampInt(bounds.maxY, minY + minInnerHeight, clampedCard.maxY - minBorderY);
  return { minX, minY, maxX, maxY };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toXPercent(value: number, width: number): number {
  return (clampInt(value, 0, Math.max(0, width - 1)) / Math.max(1, width - 1)) * 100;
}

function toYPercent(value: number, height: number): number {
  return (clampInt(value, 0, Math.max(0, height - 1)) / Math.max(1, height - 1)) * 100;
}

function toSpanPercent(span: number, total: number): number {
  return (Math.max(0, span) / Math.max(1, total)) * 100;
}

function pxToMillimeters(px: number, axisPx: number, physicalMm: number): number {
  return (px / Math.max(1, axisPx)) * physicalMm;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
