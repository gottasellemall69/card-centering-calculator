'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';

import type { CenteringResult, GradeResult } from '@/lib/grader';
import {
  DEFAULT_MANUAL_IMAGE_NORMALIZATION,
  MAX_MANUAL_ROTATION_DEG,
  MAX_MANUAL_SKEW_DEG,
  applyAffineToVector,
  buildFittedImageTransform,
  buildNormalizationMatrix,
  clampFloat,
  clampManualImageNormalization,
  formatDegrees,
  isIdentityNormalization,
  matrixToCss,
  type ManualImageNormalization
} from '@/lib/manualAlignment';
import { centeringCapFromWorstSidePct } from '@/lib/rubric';

const CARD_WIDTH_MM = 63.5;
const CARD_HEIGHT_MM = 88.9;
const MIN_CARD_SPAN_PX = 63.5;
const MIN_INNER_SPAN_PX = 59.5;
const MIN_BORDER_PX = 3;
const AUTO_STRAIGHTEN_MIN_CONFIDENCE = 0.35;

type BoundsRect = { minX: number; minY: number; maxX: number; maxY: number; };
type GuideState = { cardBounds: BoundsRect; innerBounds: BoundsRect; };
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

export function OverlayViewer( {
  imageDataUrl,
  result,
  manualCentering,
  manualNormalization,
  alt,
  onCenteringChange,
  onNormalizationChange
}: {
  imageDataUrl: string;
  alt: string;
  result: GradeResult;
  manualCentering?: ManualCenteringView | null;
  manualNormalization?: ManualImageNormalization | null;
  onCenteringChange?: ( value: ManualCenteringView | null ) => void;
  onNormalizationChange?: ( value: ManualImageNormalization | null ) => void;
} ) {
  const frameRef = useRef<HTMLDivElement | null>( null );
  const [ imageSize, setImageSize ] = useState<{ w: number; h: number; } | null>( null );
  const [ guides, setGuides ] = useState<GuideState | null>( null );
  const [ dragKey, setDragKey ] = useState<GuideKey | null>( null );
  const [ normalization, setNormalization ] = useState<ManualImageNormalization>(
    clampManualImageNormalization( manualNormalization )
  );
  const [ normalizationAnchor, setNormalizationAnchor ] = useState<{ x: number; y: number; } | null>( null );
  const [ isAutoStraightening, setIsAutoStraightening ] = useState( false );
  const [ autoStraightenStatus, setAutoStraightenStatus ] = useState<string | null>( null );
  const activeNormalizationAnchor = normalizationAnchor ?? normalization.anchor ?? ( guides ? getBoundsCenter( guides.cardBounds ) : null );

  useEffect( () => {
    setImageSize( null );
    setGuides( null );
    setDragKey( null );
    setNormalization( clampManualImageNormalization( manualNormalization ) );
    setNormalizationAnchor( null );
    setAutoStraightenStatus( null );
    setIsAutoStraightening( false );
  }, [ imageDataUrl ] );

  useEffect( () => {
    const next = clampManualImageNormalization( manualNormalization );
    setNormalization( ( current ) => ( sameManualNormalization( current, next ) ? current : next ) );
  }, [ manualNormalization ] );

  useEffect( () => {
    if ( !imageSize ) return;
    setGuides( resolveInitialGuides( result, imageSize, manualCentering ?? null ) );
  }, [ imageDataUrl, result, imageSize ] );

  useEffect( () => {
    if ( !guides || !imageSize ) return;
    onCenteringChange?.( buildManualCentering( guides.cardBounds, guides.innerBounds, imageSize.w, imageSize.h ) );
  }, [ guides, imageSize, onCenteringChange ] );

  useEffect( () => {
    const clamped = clampManualImageNormalization( normalization );
    if ( activeNormalizationAnchor ) {
      clamped.anchor = activeNormalizationAnchor;
    }
    onNormalizationChange?.( isIdentityNormalization( clamped ) ? null : clamped );
  }, [ normalization, activeNormalizationAnchor, onNormalizationChange ] );

  useEffect( () => {
    if ( !guides ) return;
    const center = getBoundsCenter( guides.cardBounds );
    setNormalizationAnchor( ( current ) => {
      if ( manualNormalization?.anchor ) return manualNormalization.anchor;
      if ( !current ) return center;
      return isIdentityNormalization( normalization ) ? center : current;
    } );
  }, [ guides, normalization, manualNormalization ] );

  useEffect( () => {
    if ( !dragKey || !imageSize ) return;

    const onPointerMove = ( event: PointerEvent ) => {
      const frame = frameRef.current;
      if ( !frame ) return;
      const rect = frame.getBoundingClientRect();
      const nextValue = pointerToImageCoordinate( event.clientX, event.clientY, rect, imageSize, dragKey );
      setGuides( ( current ) => ( current ? applyGuideUpdate( current, dragKey, nextValue, imageSize ) : current ) );
    };

    const stopDragging = () => setDragKey( null );

    window.addEventListener( 'pointermove', onPointerMove );
    window.addEventListener( 'pointerup', stopDragging );
    window.addEventListener( 'pointercancel', stopDragging );
    return () => {
      window.removeEventListener( 'pointermove', onPointerMove );
      window.removeEventListener( 'pointerup', stopDragging );
      window.removeEventListener( 'pointercancel', stopDragging );
    };
  }, [ dragKey, imageSize ] );

  const centering = guides && imageSize
    ? buildManualCentering( guides.cardBounds, guides.innerBounds, imageSize.w, imageSize.h )
    : null;
  const cardSize = guides ? getBoundsSize( guides.cardBounds ) : null;
  const cardTransform = imageSize
    ? buildFittedImageTransform( imageSize, normalization )
    : buildFittedImageTransform( { w: 1, h: 1 }, DEFAULT_MANUAL_IMAGE_NORMALIZATION );
  const cardTransformOrigin = activeNormalizationAnchor && imageSize
    ? `${ toXPercent( activeNormalizationAnchor.x, imageSize.w ) }% ${ toYPercent( activeNormalizationAnchor.y, imageSize.h ) }%`
    : '50% 50%';
  const cardTransformStyle: CSSProperties = {
    transformOrigin: cardTransformOrigin,
    transform: matrixToCss( cardTransform )
  };
  const hasNormalization = !isIdentityNormalization( normalization );
  const cardCropStyle: CSSProperties | undefined = guides && imageSize && cardSize
    ? {
      left: `${ toXEdgePercent( guides.cardBounds.minX, imageSize.w ) }%`,
      top: `${ toYEdgePercent( guides.cardBounds.minY, imageSize.h ) }%`,
      width: `${ toSpanPercent( cardSize.w, imageSize.w ) }%`,
      height: `${ toSpanPercent( cardSize.h, imageSize.h ) }%`
    }
    : undefined;
  const cardClipPath = guides && imageSize
    ? buildBoundsClipPath( guides.cardBounds, imageSize )
    : null;
  const cardClipStyle: CSSProperties | undefined = cardClipPath
    ? {
      left: 0,
      top: 0,
      width: '100%',
      height: '100%',
      background: 'transparent',
      boxShadow: 'none',
      borderRadius: 0,
      clipPath: cardClipPath,
      WebkitClipPath: cardClipPath
    }
    : undefined;
  const cardImageStyle: CSSProperties = {
    left: 0,
    top: 0,
    width: '100%',
    height: '100%'
  };

  const resetGuides = () => {
    if ( !imageSize ) return;
    setDragKey( null );
    setNormalizationAnchor( null );
    setGuides( resolveInitialGuides( result, imageSize, manualCentering ?? null ) );
  };
  const resetNormalization = () => {
    setNormalization( { ...DEFAULT_MANUAL_IMAGE_NORMALIZATION } );
    setAutoStraightenStatus( null );
  };
  const handleNormalizationChange = ( key: 'rotationDeg' | 'skewXDeg' | 'skewYDeg' ) => ( event: ChangeEvent<HTMLInputElement> ) => {
    const limit = key === 'rotationDeg' ? MAX_MANUAL_ROTATION_DEG : MAX_MANUAL_SKEW_DEG;
    const rawValue = Number( event.currentTarget.value );
    const nextValue = Number.isFinite( rawValue ) ? clampFloat( rawValue, -limit, limit ) : 0;
    setAutoStraightenStatus( null );
    setNormalization( ( current ) => ( {
      ...current,
      [ key ]: nextValue,
      source: 'manual',
      confidence: null
    } ) );
  };
  const nudgeNormalization = ( key: 'rotationDeg' | 'skewXDeg' | 'skewYDeg', delta: number ) => {
    const limit = key === 'rotationDeg' ? MAX_MANUAL_ROTATION_DEG : MAX_MANUAL_SKEW_DEG;
    setAutoStraightenStatus( null );
    setNormalization( ( current ) => ( {
      ...current,
      [ key ]: clampFloat( current[ key ] + delta, -limit, limit ),
      source: 'manual',
      confidence: null
    } ) );
  };
  const autoStraighten = async () => {
    if ( !guides || !imageSize ) return;
    setIsAutoStraightening( true );
    setAutoStraightenStatus( 'Analyzing card edges…' );
    try {
      const estimate = await estimateAutoNormalization( imageDataUrl, imageSize, guides );
      if ( !estimate ) {
        setAutoStraightenStatus( 'Auto mode could not find stable card edges. Try a quick manual rotation first.' );
        return;
      }
      if ( estimate.confidence < AUTO_STRAIGHTEN_MIN_CONFIDENCE ) {
        setAutoStraightenStatus(
          `Auto mode found only weak edge evidence (${ Math.round( estimate.confidence * 100 ) }% confidence). Try tightening the guides around the card or dial in a quick manual rotate first.`
        );
        return;
      }
      const next = clampManualImageNormalization( {
        ...estimate.normalization,
        anchor: activeNormalizationAnchor ?? getBoundsCenter( guides.cardBounds ),
        source: 'auto',
        confidence: estimate.confidence
      } );
      setNormalization( next );
      setAutoStraightenStatus(
        `Auto straighten applied (${ Math.round( estimate.confidence * 100 ) }% confidence): rotate ${ formatDegrees( next.rotationDeg ) }, skew X ${ formatDegrees( next.skewXDeg ) }, skew Y ${ formatDegrees( next.skewYDeg ) }.`
      );
    } catch ( error ) {
      setAutoStraightenStatus( error instanceof Error ? error.message : 'Auto straighten failed.' );
    } finally {
      setIsAutoStraightening( false );
    }
  };

  return (
    <div className="overlayViewer">
      <div className="overlayViewerToolbar">
        <div className="small">Use Auto straighten for a starting point, then fine-tune rotate/skew and drag the dotted guides until the card and inner frame sit square.</div>
        <div className="overlayViewerToolbarActions">
          <button type="button" className="btn btnPrimary" onClick={() => void autoStraighten()} disabled={!guides || !imageSize || isAutoStraightening}>
            {isAutoStraightening ? 'Auto straightening…' : 'Auto straighten'}
          </button>
          <button type="button" className="btn" onClick={resetNormalization} disabled={!hasNormalization}>Reset normalize</button>
          <button type="button" className="btn" onClick={resetGuides}>Reset guides</button>
        </div>
      </div>

      <div className="overlayViewerLayout">
        <aside className="overlayViewerPanel">
          <div className="overlayViewerPanelSection">
            <div className="overlayViewerPanelLabel">Centering</div>
            <div className="overlayViewerMetricTitle">Left / Right</div>
            <div className="overlayViewerMetricMm">
              {centering ? `${ centering.mm.left.toFixed( 1 ) }mm / ${ centering.mm.right.toFixed( 1 ) }mm` : '—'}
            </div>
            <div className="overlayViewerMetricPct">
              {centering ? `${ Math.round( centering.debug.border.leftPct ) }% / ${ Math.round( centering.debug.border.rightPct ) }%` : '—'}
            </div>

            <div className="overlayViewerMetricTitle">Top / Bottom</div>
            <div className="overlayViewerMetricMm">
              {centering ? `${ centering.mm.top.toFixed( 1 ) }mm / ${ centering.mm.bottom.toFixed( 1 ) }mm` : '—'}
            </div>
            <div className="overlayViewerMetricPct">
              {centering ? `${ Math.round( centering.debug.border.topPct ) }% / ${ Math.round( centering.debug.border.bottomPct ) }%` : '—'}
            </div>

            <div className="overlayViewerMetricTitle">Used for grade</div>
            <div className="overlayViewerMetricMm">
              {centering ? `${ centering.worst.axis } ${ centering.worst.ratio }` : '—'}
            </div>
            <div className="overlayViewerMetricPct">
              {centering ? `Cap ${ centering.gradeCap.gradeLabel }` : '—'}
            </div>
          </div>
        </aside>

        <div className="overlayViewerStage">
          <section className="overlayViewerNormalizePanel">
            <div className="overlayViewerPanelLabel">Normalize</div>
            <div className="small">These adjustments are applied during grading too, so the manual overlay and final estimate use the same straightened view.</div>
            {autoStraightenStatus ? (
              <div className="overlayViewerStatus">{autoStraightenStatus}</div>
            ) : null}
            <div className="overlayViewerControlRow">
              <NormalizationControl
                label="Rotate"
                value={normalization.rotationDeg}
                min={-MAX_MANUAL_ROTATION_DEG}
                max={MAX_MANUAL_ROTATION_DEG}
                step={0.1}
                onChange={handleNormalizationChange( 'rotationDeg' )}
                onNudge={( delta ) => nudgeNormalization( 'rotationDeg', delta )}
              />
              <NormalizationControl
                label="Skew X"
                value={normalization.skewXDeg}
                min={-MAX_MANUAL_SKEW_DEG}
                max={MAX_MANUAL_SKEW_DEG}
                step={0.1}
                onChange={handleNormalizationChange( 'skewXDeg' )}
                onNudge={( delta ) => nudgeNormalization( 'skewXDeg', delta )}
              />
              <NormalizationControl
                label="Skew Y"
                value={normalization.skewYDeg}
                min={-MAX_MANUAL_SKEW_DEG}
                max={MAX_MANUAL_SKEW_DEG}
                step={0.1}
                onChange={handleNormalizationChange( 'skewYDeg' )}
                onNudge={( delta ) => nudgeNormalization( 'skewYDeg', delta )}
              />
            </div>
          </section>

          <div className="overlayViewerFrame" ref={frameRef}>
            <img
              className="overlayViewerBase"
              src={imageDataUrl}
              alt={alt}
              onLoad={( event ) => {
                const img = event.currentTarget;
                setImageSize( { w: img.naturalWidth, h: img.naturalHeight } );
              }}
            />

            {guides && imageSize && cardSize && cardCropStyle && cardClipStyle ? (
              <>
                <div className="overlayViewerCardBackdrop" aria-hidden="true" style={cardCropStyle} />
                <div className="overlayViewerCardShell" aria-hidden="true" style={cardClipStyle}>
                  <div className="overlayViewerCardLayer" style={cardTransformStyle}>
                    <img
                      className="overlayViewerCardImage"
                      src={imageDataUrl}
                      alt=""
                      aria-hidden="true"
                      style={cardImageStyle}
                    />
                  </div>
                </div>

                <div className="overlayViewerGuides" aria-hidden="true">
                  {renderOutsideShade( guides.cardBounds, imageSize )}
                  {renderMeasurementBands( guides, imageSize )}
                  {renderGuide(
                    'cardLeft',
                    guides.cardBounds.minX,
                    imageSize,
                    'vertical',
                    'overlayGuideOuterLeft',
                    () => setDragKey( 'cardLeft' )
                  )}
                  {renderGuide(
                    'innerLeft',
                    guides.innerBounds.minX,
                    imageSize,
                    'vertical',
                    'overlayGuideInnerLeft',
                    () => setDragKey( 'innerLeft' )
                  )}
                  {renderGuide(
                    'innerRight',
                    guides.innerBounds.maxX,
                    imageSize,
                    'vertical',
                    'overlayGuideInnerRight',
                    () => setDragKey( 'innerRight' )
                  )}
                  {renderGuide(
                    'cardRight',
                    guides.cardBounds.maxX,
                    imageSize,
                    'vertical',
                    'overlayGuideOuterRight',
                    () => setDragKey( 'cardRight' )
                  )}
                  {renderGuide(
                    'cardTop',
                    guides.cardBounds.minY,
                    imageSize,
                    'horizontal',
                    'overlayGuideOuterTop',
                    () => setDragKey( 'cardTop' )
                  )}
                  {renderGuide(
                    'innerTop',
                    guides.innerBounds.minY,
                    imageSize,
                    'horizontal',
                    'overlayGuideInnerTop',
                    () => setDragKey( 'innerTop' )
                  )}
                  {renderGuide(
                    'innerBottom',
                    guides.innerBounds.maxY,
                    imageSize,
                    'horizontal',
                    'overlayGuideInnerBottom',
                    () => setDragKey( 'innerBottom' )
                  )}
                  {renderGuide(
                    'cardBottom',
                    guides.cardBounds.maxY,
                    imageSize,
                    'horizontal',
                    'overlayGuideOuterBottom',
                    () => setDragKey( 'cardBottom' )
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function NormalizationControl( {
  label,
  value,
  min,
  max,
  step,
  onChange,
  onNudge
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: ( event: ChangeEvent<HTMLInputElement> ) => void;
  onNudge: ( delta: number ) => void;
} ) {
  return (
    <label className="overlayViewerControl">
      <span className="overlayViewerControlLabel">
        <span>{label}</span>
        <span>{formatDegrees( value )}</span>
      </span>
      <div className="overlayViewerNudgeRow">
        <button type="button" className="btn overlayViewerNudgeButton" onClick={() => onNudge( -1 )}>-1°</button>
        <button type="button" className="btn overlayViewerNudgeButton" onClick={() => onNudge( -0.1 )}>-0.1°</button>
        <button type="button" className="btn overlayViewerNudgeButton" onClick={() => onNudge( 0.1 )}>+0.1°</button>
        <button type="button" className="btn overlayViewerNudgeButton" onClick={() => onNudge( 1 )}>+1°</button>
      </div>
      <input
        className="overlayViewerRange"
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
      />
      <input
        className="overlayViewerNumber"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
      />
    </label>
  );
}

function renderGuide(
  key: GuideKey,
  value: number,
  imageSize: { w: number; h: number; },
  orientation: 'vertical' | 'horizontal',
  className: string,
  onPointerDown: () => void
) {
  const style = orientation === 'vertical'
    ? ( { left: `${ toXPercent( value, imageSize.w ) }%` } as CSSProperties )
    : ( { top: `${ toYPercent( value, imageSize.h ) }%` } as CSSProperties );

  return (
    <button
      key={key}
      type="button"
      className={`overlayGuide ${ orientation === 'vertical' ? 'overlayGuideVertical' : 'overlayGuideHorizontal' } ${ className }`}
      style={style}
      onPointerDown={( event ) => {
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

function renderOutsideShade( bounds: BoundsRect, imageSize: { w: number; h: number; } ) {
  return (
    <>
      <div className="overlayMask" style={{ top: 0, left: 0, right: 0, height: `${ toSpanPercent( bounds.minY, imageSize.h ) }%` }} />
      <div className="overlayMask" style={{ top: `${ toYEdgePercent( bounds.maxY + 1, imageSize.h ) }%`, left: 0, right: 0, bottom: 0 }} />
      <div
        className="overlayMask"
        style={{
          top: `${ toYEdgePercent( bounds.minY, imageSize.h ) }%`,
          left: 0,
          width: `${ toSpanPercent( bounds.minX, imageSize.w ) }%`,
          height: `${ toSpanPercent( bounds.maxY - bounds.minY + 1, imageSize.h ) }%`
        }}
      />
      <div
        className="overlayMask"
        style={{
          top: `${ toYEdgePercent( bounds.minY, imageSize.h ) }%`,
          left: `${ toXEdgePercent( bounds.maxX + 1, imageSize.w ) }%`,
          right: 0,
          height: `${ toSpanPercent( bounds.maxY - bounds.minY + 1, imageSize.h ) }%`
        }}
      />
    </>
  );
}

function renderMeasurementBands( guides: GuideState, imageSize: { w: number; h: number; } ) {
  const { cardBounds, innerBounds } = guides;
  return (
    <>
      <div
        className="overlayBand overlayBandLeft"
        style={{
          left: `${ toXEdgePercent( cardBounds.minX, imageSize.w ) }%`,
          top: `${ toYEdgePercent( cardBounds.minY, imageSize.h ) }%`,
          width: `${ toSpanPercent( innerBounds.minX - cardBounds.minX, imageSize.w ) }%`,
          height: `${ toSpanPercent( cardBounds.maxY - cardBounds.minY + 1, imageSize.h ) }%`
        }}
      />
      <div
        className="overlayBand overlayBandRight"
        style={{
          left: `${ toXEdgePercent( innerBounds.maxX + 1, imageSize.w ) }%`,
          top: `${ toYEdgePercent( cardBounds.minY, imageSize.h ) }%`,
          width: `${ toSpanPercent( cardBounds.maxX - innerBounds.maxX, imageSize.w ) }%`,
          height: `${ toSpanPercent( cardBounds.maxY - cardBounds.minY + 1, imageSize.h ) }%`
        }}
      />
      <div
        className="overlayBand overlayBandTop"
        style={{
          left: `${ toXEdgePercent( cardBounds.minX, imageSize.w ) }%`,
          top: `${ toYEdgePercent( cardBounds.minY, imageSize.h ) }%`,
          width: `${ toSpanPercent( cardBounds.maxX - cardBounds.minX + 1, imageSize.w ) }%`,
          height: `${ toSpanPercent( innerBounds.minY - cardBounds.minY, imageSize.h ) }%`
        }}
      />
      <div
        className="overlayBand overlayBandBottom"
        style={{
          left: `${ toXEdgePercent( cardBounds.minX, imageSize.w ) }%`,
          top: `${ toYEdgePercent( innerBounds.maxY + 1, imageSize.h ) }%`,
          width: `${ toSpanPercent( cardBounds.maxX - cardBounds.minX + 1, imageSize.w ) }%`,
          height: `${ toSpanPercent( cardBounds.maxY - innerBounds.maxY, imageSize.h ) }%`
        }}
      />
    </>
  );
}

function pointerToImageCoordinate(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  imageSize: { w: number; h: number; },
  key: GuideKey
): number {
  if ( key === 'cardLeft' || key === 'innerLeft' || key === 'innerRight' || key === 'cardRight' ) {
    const x = ( ( clientX - rect.left ) / Math.max( 1, rect.width ) ) * ( imageSize.w - 1 );
    return clampInt( x, 0, Math.max( 0, imageSize.w - 1 ) );
  }
  const y = ( ( clientY - rect.top ) / Math.max( 1, rect.height ) ) * ( imageSize.h - 1 );
  return clampInt( y, 0, Math.max( 0, imageSize.h - 1 ) );
}

function applyGuideUpdate(
  guides: GuideState,
  key: GuideKey,
  nextValue: number,
  imageSize: { w: number; h: number; }
): GuideState {
  const cardBounds = { ...guides.cardBounds };
  const innerBounds = { ...guides.innerBounds };
  const minCardWidth = Math.min( MIN_CARD_SPAN_PX, Math.max( 40, Math.round( imageSize.w * 0.18 ) ) );
  const minCardHeight = Math.min( MIN_CARD_SPAN_PX, Math.max( 40, Math.round( imageSize.h * 0.18 ) ) );
  const minInnerWidth = Math.min( MIN_INNER_SPAN_PX, Math.max( 40, Math.round( imageSize.w * 0.18 ) ) );
  const minInnerHeight = Math.min( MIN_INNER_SPAN_PX, Math.max( 40, Math.round( imageSize.h * 0.18 ) ) );
  const minBorderX = Math.min( 16, Math.max( MIN_BORDER_PX, Math.round( imageSize.w * 0.01 ) ) );
  const minBorderY = Math.min( 16, Math.max( MIN_BORDER_PX, Math.round( imageSize.h * 0.01 ) ) );

  switch ( key ) {
    case 'cardLeft':
      cardBounds.minX = clampInt( nextValue, 0, Math.min( cardBounds.maxX - minCardWidth, innerBounds.minX - minBorderX ) );
      break;
    case 'innerLeft':
      innerBounds.minX = clampInt( nextValue, cardBounds.minX + minBorderX, innerBounds.maxX - minInnerWidth );
      break;
    case 'innerRight':
      innerBounds.maxX = clampInt( nextValue, innerBounds.minX + minInnerWidth, cardBounds.maxX - minBorderX );
      break;
    case 'cardRight':
      cardBounds.maxX = clampInt( nextValue, Math.max( cardBounds.minX + minCardWidth, innerBounds.maxX + minBorderX ), imageSize.w - 1 );
      break;
    case 'cardTop':
      cardBounds.minY = clampInt( nextValue, 0, Math.min( cardBounds.maxY - minCardHeight, innerBounds.minY - minBorderY ) );
      break;
    case 'innerTop':
      innerBounds.minY = clampInt( nextValue, cardBounds.minY + minBorderY, innerBounds.maxY - minInnerHeight );
      break;
    case 'innerBottom':
      innerBounds.maxY = clampInt( nextValue, innerBounds.minY + minInnerHeight, cardBounds.maxY - minBorderY );
      break;
    case 'cardBottom':
      cardBounds.maxY = clampInt( nextValue, Math.max( cardBounds.minY + minCardHeight, innerBounds.maxY + minBorderY ), imageSize.h - 1 );
      break;
  }

  innerBounds.minX = clampInt( innerBounds.minX, cardBounds.minX + minBorderX, innerBounds.maxX - minInnerWidth );
  innerBounds.maxX = clampInt( innerBounds.maxX, innerBounds.minX + minInnerWidth, cardBounds.maxX - minBorderX );
  innerBounds.minY = clampInt( innerBounds.minY, cardBounds.minY + minBorderY, innerBounds.maxY - minInnerHeight );
  innerBounds.maxY = clampInt( innerBounds.maxY, innerBounds.minY + minInnerHeight, cardBounds.maxY - minBorderY );

  return { cardBounds, innerBounds };
}

function resolveInitialGuides(
  result: GradeResult,
  imageSize: { w: number; h: number; },
  manualCentering: ManualCenteringView | null
): GuideState {
  const manualCardBounds = rectToBounds( manualCentering?.debug.cardRect );
  const manualInnerBounds = rectToBounds( manualCentering?.debug.innerRect );
  const debug = asRecord( result.debug );
  const sourceSize = parseImageSize( debug?.sourceSize );
  const rectifiedSize = parseImageSize( result.centering?.debug.rectifiedSize );
  const normalizedSize = parseImageSize( debug?.normalizedSize ) ?? rectifiedSize;
  const debugCardBounds = parseBoundsRect( debug?.cardBounds );
  const debugCropBounds = parseBoundsRect( debug?.cropBounds );
  const debugNormalizedCardBounds = parseBoundsRect( debug?.normalizedCardBounds );
  const debugInnerBounds = parseBoundsRect( debug?.innerBounds );
  const centeringCardBounds = rectToBounds( result.centering?.debug.cardRect );
  const centeringInnerBounds = rectToBounds( result.centering?.debug.innerRect );

  const sourceCardBounds = sourceSize
    ? clampBounds(
      debugCardBounds ?? (
        normalizedSize && debugCropBounds && debugNormalizedCardBounds
          ? mapNormalizedBoundsToSource( debugNormalizedCardBounds, normalizedSize, debugCropBounds )
          : { minX: 0, minY: 0, maxX: sourceSize.w - 1, maxY: sourceSize.h - 1 }
      ),
      sourceSize.w,
      sourceSize.h
    )
    : null;

  const sourceCropBounds = sourceSize
    ? clampBounds( debugCropBounds ?? sourceCardBounds ?? { minX: 0, minY: 0, maxX: sourceSize.w - 1, maxY: sourceSize.h - 1 }, sourceSize.w, sourceSize.h )
    : null;

  const sourceInnerBounds = sourceSize && normalizedSize && debugInnerBounds && sourceCropBounds
    ? clampBounds(
      mapNormalizedBoundsToSource( debugInnerBounds, normalizedSize, sourceCropBounds ),
      sourceSize.w,
      sourceSize.h
    )
    : null;

  const mappedCardBounds = sourceCardBounds && sourceSize
    ? scaleBoundsBetweenSizes( sourceCardBounds, sourceSize, imageSize )
    : ( sourceSize && normalizedSize && debugNormalizedCardBounds && debugCropBounds )
      ? scaleBoundsBetweenSizes(
        mapNormalizedBoundsToSource( debugNormalizedCardBounds, normalizedSize, debugCropBounds ),
        sourceSize,
        imageSize
      )
      : null;

  const mappedInnerBounds = sourceInnerBounds && sourceSize
    ? scaleBoundsBetweenSizes( sourceInnerBounds, sourceSize, imageSize )
    : ( centeringInnerBounds && rectifiedSize )
      ? scaleBoundsBetweenSizes( centeringInnerBounds, rectifiedSize, imageSize )
      : null;

  const cardBounds = clampBounds(
    manualCardBounds
    ?? mappedCardBounds
    ?? ( centeringCardBounds && rectifiedSize
      ? scaleBoundsBetweenSizes( centeringCardBounds, rectifiedSize, imageSize )
      : centeringCardBounds )
    ?? { minX: 0, minY: 0, maxX: imageSize.w - 1, maxY: imageSize.h - 1 },
    imageSize.w,
    imageSize.h
  );

  const defaultInsetX = Math.max( 10, Math.round( ( cardBounds.maxX - cardBounds.minX + 1 ) * 0.08 ) );
  const defaultInsetY = Math.max( 10, Math.round( ( cardBounds.maxY - cardBounds.minY + 1 ) * 0.08 ) );
  const fallbackInner = {
    minX: cardBounds.minX + defaultInsetX,
    minY: cardBounds.minY + defaultInsetY,
    maxX: cardBounds.maxX - defaultInsetX,
    maxY: cardBounds.maxY - defaultInsetY
  };

  const innerBounds = clampInnerBounds(
    manualInnerBounds
    ?? mappedInnerBounds
    ?? ( centeringInnerBounds && rectifiedSize
      ? scaleBoundsBetweenSizes( centeringInnerBounds, rectifiedSize, imageSize )
      : centeringInnerBounds )
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
  const card = clampBounds( cardBounds, width, height );
  const inner = clampInnerBounds( innerBounds, card, width, height );
  const cardWidth = Math.max( 1, card.maxX - card.minX + 1 );
  const cardHeight = Math.max( 1, card.maxY - card.minY + 1 );

  const leftPx = Math.max( 1, inner.minX - card.minX );
  const rightPx = Math.max( 1, card.maxX - inner.maxX );
  const topPx = Math.max( 1, inner.minY - card.minY );
  const bottomPx = Math.max( 1, card.maxY - inner.maxY );

  const lrTotal = leftPx + rightPx;
  const tbTotal = topPx + bottomPx;
  const leftPct = ( leftPx / lrTotal ) * 100;
  const rightPct = ( rightPx / lrTotal ) * 100;
  const topPct = ( topPx / tbTotal ) * 100;
  const bottomPct = ( bottomPx / tbTotal ) * 100;

  const lrWorst = Math.max( leftPct, rightPct );
  const tbWorst = Math.max( topPct, bottomPct );
  const lrRatio = `${ Math.round( lrWorst ) }/${ Math.round( Math.min( leftPct, rightPct ) ) }`;
  const tbRatio = `${ Math.round( tbWorst ) }/${ Math.round( Math.min( topPct, bottomPct ) ) }`;
  const worst = lrWorst >= tbWorst
    ? { axis: 'LR' as const, ratio: lrRatio, worstSidePct: lrWorst }
    : { axis: 'TB' as const, ratio: tbRatio, worstSidePct: tbWorst };
  const gradeCap = centeringCapFromWorstSidePct( worst.worstSidePct );

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
        w: Math.max( 1, inner.maxX - inner.minX + 1 ),
        h: Math.max( 1, inner.maxY - inner.minY + 1 )
      }
    },
    mm: {
      left: pxToMillimeters( leftPx, cardWidth, CARD_WIDTH_MM ),
      right: pxToMillimeters( rightPx, cardWidth, CARD_WIDTH_MM ),
      top: pxToMillimeters( topPx, cardHeight, CARD_HEIGHT_MM ),
      bottom: pxToMillimeters( bottomPx, cardHeight, CARD_HEIGHT_MM )
    }
  };
}

function rectToBounds( rect: { x: number; y: number; w: number; h: number; } | undefined ): BoundsRect | null {
  if ( !rect ) return null;
  if ( ![ rect.x, rect.y, rect.w, rect.h ].every( ( value ) => Number.isFinite( value ) ) ) return null;
  if ( rect.w < 1 || rect.h < 1 ) return null;
  return {
    minX: rect.x,
    minY: rect.y,
    maxX: ( rect.x + rect.w ) - 1,
    maxY: ( rect.y + rect.h ) - 1
  };
}

function parseBoundsRect( value: unknown ): BoundsRect | null {
  const record = asRecord( value );
  if ( !record ) return null;
  const minX = asFiniteNumber( record.minX );
  const minY = asFiniteNumber( record.minY );
  const maxX = asFiniteNumber( record.maxX );
  const maxY = asFiniteNumber( record.maxY );
  if ( minX != null && minY != null && maxX != null && maxY != null ) {
    return { minX, minY, maxX, maxY };
  }
  return null;
}

function parseImageSize( value: unknown ): { w: number; h: number; } | null {
  const record = asRecord( value );
  if ( !record ) return null;
  const w = asFiniteNumber( record.w );
  const h = asFiniteNumber( record.h );
  if ( w == null || h == null || w <= 1 || h <= 1 ) return null;
  return { w, h };
}

function scaleBoundsBetweenSizes(
  bounds: BoundsRect,
  sourceSize: { w: number; h: number; },
  targetSize: { w: number; h: number; }
): BoundsRect {
  return clampBounds(
    {
      minX: ( bounds.minX / Math.max( 1, sourceSize.w ) ) * targetSize.w,
      minY: ( bounds.minY / Math.max( 1, sourceSize.h ) ) * targetSize.h,
      maxX: ( ( ( bounds.maxX + 1 ) / Math.max( 1, sourceSize.w ) ) * targetSize.w ) - 1,
      maxY: ( ( ( bounds.maxY + 1 ) / Math.max( 1, sourceSize.h ) ) * targetSize.h ) - 1
    },
    targetSize.w,
    targetSize.h
  );
}

function mapNormalizedBoundsToSource(
  normalizedBounds: BoundsRect,
  normalizedSize: { w: number; h: number; },
  sourceBounds: BoundsRect
): BoundsRect {
  const sourceWidth = Math.max( 1, sourceBounds.maxX - sourceBounds.minX + 1 );
  const sourceHeight = Math.max( 1, sourceBounds.maxY - sourceBounds.minY + 1 );
  return {
    minX: sourceBounds.minX + ( normalizedBounds.minX / Math.max( 1, normalizedSize.w ) ) * sourceWidth,
    minY: sourceBounds.minY + ( normalizedBounds.minY / Math.max( 1, normalizedSize.h ) ) * sourceHeight,
    maxX: sourceBounds.minX + ( ( ( normalizedBounds.maxX + 1 ) / Math.max( 1, normalizedSize.w ) ) * sourceWidth ) - 1,
    maxY: sourceBounds.minY + ( ( ( normalizedBounds.maxY + 1 ) / Math.max( 1, normalizedSize.h ) ) * sourceHeight ) - 1
  };
}

function clampBounds( bounds: BoundsRect, width: number, height: number ): BoundsRect {
  const minX = clampInt( bounds.minX, 0, Math.max( 0, width - 2 ) );
  const minY = clampInt( bounds.minY, 0, Math.max( 0, height - 2 ) );
  const maxX = clampInt( bounds.maxX, minX + 1, Math.max( 1, width - 1 ) );
  const maxY = clampInt( bounds.maxY, minY + 1, Math.max( 1, height - 1 ) );
  return { minX, minY, maxX, maxY };
}

function clampInnerBounds( bounds: BoundsRect, cardBounds: BoundsRect, width: number, height: number ): BoundsRect {
  const clampedCard = clampBounds( cardBounds, width, height );
  const minInnerWidth = Math.min( MIN_INNER_SPAN_PX, Math.max( 40, Math.round( ( clampedCard.maxX - clampedCard.minX + 1 ) * 0.18 ) ) );
  const minInnerHeight = Math.min( MIN_INNER_SPAN_PX, Math.max( 40, Math.round( ( clampedCard.maxY - clampedCard.minY + 1 ) * 0.18 ) ) );
  const minBorderX = Math.min( 16, Math.max( MIN_BORDER_PX, Math.round( ( clampedCard.maxX - clampedCard.minX + 1 ) * 0.01 ) ) );
  const minBorderY = Math.min( 16, Math.max( MIN_BORDER_PX, Math.round( ( clampedCard.maxY - clampedCard.minY + 1 ) * 0.01 ) ) );
  const minX = clampInt( bounds.minX, clampedCard.minX + minBorderX, clampedCard.maxX - minInnerWidth );
  const minY = clampInt( bounds.minY, clampedCard.minY + minBorderY, clampedCard.maxY - minInnerHeight );
  const maxX = clampInt( bounds.maxX, minX + minInnerWidth, clampedCard.maxX - minBorderX );
  const maxY = clampInt( bounds.maxY, minY + minInnerHeight, clampedCard.maxY - minBorderY );
  return { minX, minY, maxX, maxY };
}

function asRecord( value: unknown ): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asFiniteNumber( value: unknown ): number | null {
  return typeof value === 'number' && Number.isFinite( value ) ? value : null;
}

type EdgeSamplePoint = { x: number; y: number; score: number };

type FittedEdgeLine = {
  orientation: 'horizontal' | 'vertical';
  slope: number;
  intercept: number;
  confidence: number;
  support: number;
};

type AutoNormalizationEstimate = {
  normalization: ManualImageNormalization;
  confidence: number;
};

async function estimateAutoNormalization(
  imageDataUrl: string,
  imageSize: { w: number; h: number; },
  guides: GuideState
): Promise<AutoNormalizationEstimate | null> {
  const analyzed = await loadGrayImageForAutoStraighten( imageDataUrl, imageSize );
  const scaledGuides = {
    cardBounds: scaleBoundsBetweenSizes( guides.cardBounds, imageSize, { w: analyzed.width, h: analyzed.height } ),
    innerBounds: scaleBoundsBetweenSizes( guides.innerBounds, imageSize, { w: analyzed.width, h: analyzed.height } )
  };
  const lines = detectCardEdgeLines( analyzed.gray, analyzed.width, analyzed.height, scaledGuides.cardBounds );
  const horizontalLines = [ lines.top, lines.bottom ].filter( ( line ): line is FittedEdgeLine => !!line );
  const verticalLines = [ lines.left, lines.right ].filter( ( line ): line is FittedEdgeLine => !!line );
  if ( horizontalLines.length === 0 || verticalLines.length === 0 ) return null;

  const normalization = solveAutoNormalizationFromLines( horizontalLines, verticalLines );
  const confidence = clampFloat(
    ( horizontalLines.reduce( ( sum, line ) => sum + line.confidence, 0 ) / horizontalLines.length ) * 0.5
      + ( verticalLines.reduce( ( sum, line ) => sum + line.confidence, 0 ) / verticalLines.length ) * 0.5,
    0,
    1
  );
  return {
    normalization,
    confidence
  };
}

async function loadGrayImageForAutoStraighten(
  imageDataUrl: string,
  imageSize: { w: number; h: number; }
): Promise<{ gray: Float32Array; width: number; height: number }> {
  const response = await fetch( imageDataUrl );
  const blob = await response.blob();
  const bitmap = await createImageBitmap( blob );
  const longEdge = Math.max( imageSize.w, imageSize.h );
  const scale = longEdge > 1600 ? 1600 / longEdge : 1;
  const width = Math.max( 1, Math.round( imageSize.w * scale ) );
  const height = Math.max( 1, Math.round( imageSize.h * scale ) );
  const canvas = document.createElement( 'canvas' );
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
  if ( !ctx ) {
    if ( 'close' in bitmap ) bitmap.close();
    throw new Error( 'Auto straighten could not access a 2D canvas.' );
  }
  ctx.drawImage( bitmap, 0, 0, width, height );
  if ( 'close' in bitmap ) bitmap.close();
  const data = ctx.getImageData( 0, 0, width, height ).data;
  const gray = new Float32Array( width * height );
  for ( let index = 0; index < gray.length; index++ ) {
    const offset = index * 4;
    gray[ index ] = data[ offset ] * 0.299 + data[ offset + 1 ] * 0.587 + data[ offset + 2 ] * 0.114;
  }
  return { gray, width, height };
}

function detectCardEdgeLines(
  gray: Float32Array,
  width: number,
  height: number,
  bounds: BoundsRect
): {
  top: FittedEdgeLine | null;
  bottom: FittedEdgeLine | null;
  left: FittedEdgeLine | null;
  right: FittedEdgeLine | null;
} {
  return {
    top: fitEdgeLine( sampleEdgePoints( gray, width, height, bounds, 'top' ), 'horizontal' ),
    bottom: fitEdgeLine( sampleEdgePoints( gray, width, height, bounds, 'bottom' ), 'horizontal' ),
    left: fitEdgeLine( sampleEdgePoints( gray, width, height, bounds, 'left' ), 'vertical' ),
    right: fitEdgeLine( sampleEdgePoints( gray, width, height, bounds, 'right' ), 'vertical' )
  };
}

function sampleEdgePoints(
  gray: Float32Array,
  width: number,
  height: number,
  bounds: BoundsRect,
  side: 'top' | 'bottom' | 'left' | 'right'
): EdgeSamplePoint[] {
  const cardWidth = Math.max( 1, bounds.maxX - bounds.minX + 1 );
  const cardHeight = Math.max( 1, bounds.maxY - bounds.minY + 1 );
  const alongStep = clampInt( Math.min( cardWidth, cardHeight ) / 90, 2, 8 );
  const marginX = clampInt( cardWidth * 0.08, 6, Math.max( 6, Math.round( cardWidth * 0.2 ) ) );
  const marginY = clampInt( cardHeight * 0.08, 6, Math.max( 6, Math.round( cardHeight * 0.2 ) ) );
  const searchDepth = side === 'top' || side === 'bottom'
    ? clampInt( cardHeight * 0.2, 12, Math.max( 12, Math.round( cardHeight * 0.38 ) ) )
    : clampInt( cardWidth * 0.2, 12, Math.max( 12, Math.round( cardWidth * 0.38 ) ) );
  const points: EdgeSamplePoint[] = [];

  if ( side === 'top' || side === 'bottom' ) {
    for ( let x = bounds.minX + marginX; x <= bounds.maxX - marginX; x += alongStep ) {
      let bestY = -1;
      let bestScore = 0;
      for ( let depth = 2; depth <= searchDepth - 2; depth++ ) {
        const y = side === 'top' ? bounds.minY + depth : bounds.maxY - depth;
        if ( y <= 2 || y >= height - 3 ) continue;
        const outside = meanBandSample(
          gray,
          width,
          height,
          x,
          y,
          'horizontal',
          side === 'top' ? -4 : 1,
          side === 'top' ? -1 : 4,
          2
        );
        const inside = meanBandSample(
          gray,
          width,
          height,
          x,
          y,
          'horizontal',
          side === 'top' ? 1 : -4,
          side === 'top' ? 4 : -1,
          2
        );
        const score = Math.abs( inside - outside );
        if ( score > bestScore ) {
          bestScore = score;
          bestY = y;
        }
      }
      if ( bestY >= 0 ) {
        points.push( { x, y: bestY, score: bestScore } );
      }
    }
  } else {
    for ( let y = bounds.minY + marginY; y <= bounds.maxY - marginY; y += alongStep ) {
      let bestX = -1;
      let bestScore = 0;
      for ( let depth = 2; depth <= searchDepth - 2; depth++ ) {
        const x = side === 'left' ? bounds.minX + depth : bounds.maxX - depth;
        if ( x <= 2 || x >= width - 3 ) continue;
        const outside = meanBandSample(
          gray,
          width,
          height,
          x,
          y,
          'vertical',
          side === 'left' ? -4 : 1,
          side === 'left' ? -1 : 4,
          2
        );
        const inside = meanBandSample(
          gray,
          width,
          height,
          x,
          y,
          'vertical',
          side === 'left' ? 1 : -4,
          side === 'left' ? 4 : -1,
          2
        );
        const score = Math.abs( inside - outside );
        if ( score > bestScore ) {
          bestScore = score;
          bestX = x;
        }
      }
      if ( bestX >= 0 ) {
        points.push( { x: bestX, y, score: bestScore } );
      }
    }
  }

  if ( points.length < 8 ) return [];
  const scoreFloor = Math.max( 6, percentile( points.map( ( point ) => point.score ), 0.45 ) );
  return points.filter( ( point ) => point.score >= scoreFloor );
}

function meanBandSample(
  gray: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  axis: 'horizontal' | 'vertical',
  startOffset: number,
  endOffset: number,
  radius: number
): number {
  let sum = 0;
  let count = 0;
  const from = Math.min( startOffset, endOffset );
  const to = Math.max( startOffset, endOffset );
  for ( let primary = from; primary <= to; primary++ ) {
    for ( let secondary = -radius; secondary <= radius; secondary++ ) {
      const sampleX = axis === 'horizontal' ? x + secondary : x + primary;
      const sampleY = axis === 'horizontal' ? y + primary : y + secondary;
      const clampedX = clampInt( sampleX, 0, Math.max( 0, width - 1 ) );
      const clampedY = clampInt( sampleY, 0, Math.max( 0, height - 1 ) );
      const index = ( clampedY * width ) + clampedX;
      if ( index < 0 || index >= gray.length ) continue;
      sum += gray[ index ];
      count++;
    }
  }
  return count ? sum / count : 0;
}

function fitEdgeLine(
  points: EdgeSamplePoint[],
  orientation: 'horizontal' | 'vertical'
): FittedEdgeLine | null {
  if ( points.length < 6 ) return null;
  const regression = regressLine( points, orientation );
  if ( !regression ) return null;
  const residuals = points.map( ( point ) => Math.abs( pointResidual( point, orientation, regression.slope, regression.intercept ) ) );
  const residualMedian = percentile( residuals, 0.5 );
  const filtered = points.filter( ( point ) => (
    Math.abs( pointResidual( point, orientation, regression.slope, regression.intercept ) ) <= Math.max( 1.8, residualMedian * 2.8 )
  ) );
  const finalFit = regressLine( filtered.length >= 6 ? filtered : points, orientation );
  if ( !finalFit ) return null;
  const meanScore = ( filtered.length >= 6 ? filtered : points ).reduce( ( sum, point ) => sum + point.score, 0 ) / Math.max( 1, filtered.length >= 6 ? filtered.length : points.length );
  return {
    orientation,
    slope: finalFit.slope,
    intercept: finalFit.intercept,
    support: filtered.length >= 6 ? filtered.length : points.length,
    confidence: clampFloat(
      ( ( filtered.length >= 6 ? filtered.length : points.length ) / Math.max( 8, points.length ) ) * 0.45
      + clampFloat( meanScore / 28, 0, 1 ) * 0.55,
      0,
      1
    )
  };
}

function regressLine(
  points: EdgeSamplePoint[],
  orientation: 'horizontal' | 'vertical'
): { slope: number; intercept: number } | null {
  if ( points.length < 2 ) return null;
  const independent = points.map( ( point ) => orientation === 'horizontal' ? point.x : point.y );
  const dependent = points.map( ( point ) => orientation === 'horizontal' ? point.y : point.x );
  const meanIndependent = independent.reduce( ( sum, value ) => sum + value, 0 ) / independent.length;
  const meanDependent = dependent.reduce( ( sum, value ) => sum + value, 0 ) / dependent.length;
  let numerator = 0;
  let denominator = 0;
  for ( let index = 0; index < independent.length; index++ ) {
    const deltaIndependent = independent[ index ] - meanIndependent;
    numerator += deltaIndependent * ( dependent[ index ] - meanDependent );
    denominator += deltaIndependent * deltaIndependent;
  }
  if ( Math.abs( denominator ) < 1e-6 ) return null;
  const slope = numerator / denominator;
  const intercept = meanDependent - ( slope * meanIndependent );
  return { slope, intercept };
}

function pointResidual(
  point: EdgeSamplePoint,
  orientation: 'horizontal' | 'vertical',
  slope: number,
  intercept: number
): number {
  return orientation === 'horizontal'
    ? point.y - ( slope * point.x ) - intercept
    : point.x - ( slope * point.y ) - intercept;
}

function solveAutoNormalizationFromLines(
  horizontalLines: FittedEdgeLine[],
  verticalLines: FittedEdgeLine[]
): ManualImageNormalization {
  const averageHorizontalAngle = horizontalLines.reduce( ( sum, line ) => sum + ( Math.atan( line.slope ) * 180 ) / Math.PI, 0 ) / horizontalLines.length;
  let best = clampManualImageNormalization( {
    ...DEFAULT_MANUAL_IMAGE_NORMALIZATION,
    rotationDeg: clampFloat( -averageHorizontalAngle, -MAX_MANUAL_ROTATION_DEG, MAX_MANUAL_ROTATION_DEG ),
    source: 'auto'
  } );
  let bestCost = normalizationCost( best, horizontalLines, verticalLines );

  for ( const step of [ 4, 2, 1, 0.5, 0.25, 0.1 ] ) {
    let improved = true;
    while ( improved ) {
      improved = false;
      for ( const key of [ 'rotationDeg', 'skewXDeg', 'skewYDeg' ] as const ) {
        for ( const delta of [ -step, step ] ) {
          const candidate = clampManualImageNormalization( {
            ...best,
            [ key ]: best[ key ] + delta,
            source: 'auto'
          } );
          const cost = normalizationCost( candidate, horizontalLines, verticalLines );
          if ( cost + 1e-6 < bestCost ) {
            best = candidate;
            bestCost = cost;
            improved = true;
          }
        }
      }
    }
  }

  return best;
}

function normalizationCost(
  normalization: ManualImageNormalization,
  horizontalLines: FittedEdgeLine[],
  verticalLines: FittedEdgeLine[]
): number {
  const matrix = buildNormalizationMatrix( normalization );
  let cost = 0;

  for ( const line of horizontalLines ) {
    const transformed = applyAffineToVector( matrix, { x: 1, y: line.slope } );
    const length = Math.hypot( transformed.x, transformed.y ) || 1;
    const tilt = transformed.y / length;
    cost += tilt * tilt * ( 1 + line.confidence );
  }

  for ( const line of verticalLines ) {
    const transformed = applyAffineToVector( matrix, { x: line.slope, y: 1 } );
    const length = Math.hypot( transformed.x, transformed.y ) || 1;
    const tilt = transformed.x / length;
    cost += tilt * tilt * ( 1 + line.confidence );
  }

  const horizontalMean = meanDirectionAfterTransform( matrix, horizontalLines, 'horizontal' );
  const verticalMean = meanDirectionAfterTransform( matrix, verticalLines, 'vertical' );
  if ( horizontalMean && verticalMean ) {
    const dot = Math.abs( ( horizontalMean.x * verticalMean.x ) + ( horizontalMean.y * verticalMean.y ) );
    cost += dot * dot * 0.6;
  }

  return cost;
}

function meanDirectionAfterTransform(
  matrix: ReturnType<typeof buildNormalizationMatrix>,
  lines: FittedEdgeLine[],
  kind: 'horizontal' | 'vertical'
): { x: number; y: number } | null {
  if ( lines.length === 0 ) return null;
  let sumX = 0;
  let sumY = 0;
  for ( const line of lines ) {
    const transformed = applyAffineToVector(
      matrix,
      kind === 'horizontal' ? { x: 1, y: line.slope } : { x: line.slope, y: 1 }
    );
    const length = Math.hypot( transformed.x, transformed.y ) || 1;
    sumX += transformed.x / length;
    sumY += transformed.y / length;
  }
  const length = Math.hypot( sumX, sumY ) || 1;
  return { x: sumX / length, y: sumY / length };
}

function percentile( values: number[], ratio: number ): number {
  if ( values.length === 0 ) return 0;
  const sorted = [ ...values ].sort( ( a, b ) => a - b );
  const index = clampInt( ratio * ( sorted.length - 1 ), 0, sorted.length - 1 );
  return sorted[ index ];
}

function sameManualNormalization(
  left: ManualImageNormalization | null | undefined,
  right: ManualImageNormalization | null | undefined
): boolean {
  const a = clampManualImageNormalization( left );
  const b = clampManualImageNormalization( right );
  const aAnchor = a.anchor ?? null;
  const bAnchor = b.anchor ?? null;
  return (
    Math.abs( a.rotationDeg - b.rotationDeg ) < 0.001
    && Math.abs( a.skewXDeg - b.skewXDeg ) < 0.001
    && Math.abs( a.skewYDeg - b.skewYDeg ) < 0.001
    && a.source === b.source
    && Math.abs( ( a.confidence ?? 0 ) - ( b.confidence ?? 0 ) ) < 0.001
    && (
      ( aAnchor == null && bAnchor == null )
      || (
        aAnchor != null
        && bAnchor != null
        && Math.abs( aAnchor.x - bAnchor.x ) < 0.5
        && Math.abs( aAnchor.y - bAnchor.y ) < 0.5
      )
    )
  );
}

function getBoundsSize( bounds: BoundsRect ): { w: number; h: number; } {
  return {
    w: Math.max( 1, bounds.maxX - bounds.minX + 1 ),
    h: Math.max( 1, bounds.maxY - bounds.minY + 1 )
  };
}

function getBoundsCenter( bounds: BoundsRect ): { x: number; y: number; } {
  return {
    x: ( bounds.minX + bounds.maxX ) / 2,
    y: ( bounds.minY + bounds.maxY ) / 2
  };
}

function buildBoundsClipPath( bounds: BoundsRect, imageSize: { w: number; h: number; } ): string {
  const left = toXEdgePercent( bounds.minX, imageSize.w );
  const top = toYEdgePercent( bounds.minY, imageSize.h );
  const right = toXEdgePercent( bounds.maxX + 1, imageSize.w );
  const bottom = toYEdgePercent( bounds.maxY + 1, imageSize.h );
  return `polygon(${ left }% ${ top }%, ${ right }% ${ top }%, ${ right }% ${ bottom }%, ${ left }% ${ bottom }%)`;
}

function toXPercent( value: number, width: number ): number {
  return ( clampInt( value, 0, Math.max( 0, width - 1 ) ) / Math.max( 1, width - 1 ) ) * 100;
}

function toYPercent( value: number, height: number ): number {
  return ( clampInt( value, 0, Math.max( 0, height - 1 ) ) / Math.max( 1, height - 1 ) ) * 100;
}

function toXEdgePercent( value: number, width: number ): number {
  return ( clampFloat( value, 0, Math.max( 0, width ) ) / Math.max( 1, width ) ) * 100;
}

function toYEdgePercent( value: number, height: number ): number {
  return ( clampFloat( value, 0, Math.max( 0, height ) ) / Math.max( 1, height ) ) * 100;
}

function toSpanPercent( span: number, total: number ): number {
  return ( Math.max( 0, span ) / Math.max( 1, total ) ) * 100;
}

function pxToMillimeters( px: number, axisPx: number, physicalMm: number ): number {
  return ( px / Math.max( 1, axisPx ) ) * physicalMm;
}

function clampInt( value: number, min: number, max: number ): number {
  return Math.max( min, Math.min( max, Math.round( value ) ) );
}
