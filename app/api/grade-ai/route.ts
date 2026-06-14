import { NextResponse } from 'next/server';

import { AI_REVIEW_RESPONSE_SCHEMA, isAIReviewPayload } from '@/lib/aiReview';
import type { GradeResult } from '@/lib/grader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5-nano';
const DEFAULT_DETAIL = 'high';
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export async function POST( request: Request ) {
  const apiKey = process.env.OPENAI_API_KEY;
  if ( !apiKey ) {
    return NextResponse.json(
      {
        ok: false,
        error: 'OPENAI_API_KEY is not configured on the server.'
      },
      { status: 503 }
    );
  }

  try {
    const form = await request.formData();
    const filename = readFormString( form, 'filename' ) || 'card-image';
    const resultJson = readFormString( form, 'result' );
    const detail = normalizeDetail( readFormString( form, 'detail' ) );
    const model = process.env.OPENAI_GRADER_MODEL || DEFAULT_MODEL;
    const sourceImage = readFormFile( form, 'sourceImage' );
    const rectifiedImage = readFormFile( form, 'rectifiedImage' );

    if ( !resultJson ) {
      return NextResponse.json( { ok: false, error: 'Missing deterministic grading result.' }, { status: 400 } );
    }

    if ( !rectifiedImage && !sourceImage ) {
      return NextResponse.json( { ok: false, error: 'Missing image for AI review.' }, { status: 400 } );
    }

    const deterministicResult = parseGradeResult( resultJson );
    if ( !deterministicResult ) {
      return NextResponse.json( { ok: false, error: 'Deterministic grading result is not valid JSON.' }, { status: 400 } );
    }

    const totalImageBytes = ( sourceImage?.size ?? 0 ) + ( rectifiedImage?.size ?? 0 );
    if ( totalImageBytes > MAX_TOTAL_IMAGE_BYTES ) {
      return NextResponse.json(
        {
          ok: false,
          error: `Images are too large for this review route (${ formatBytes( totalImageBytes ) } > ${ formatBytes( MAX_TOTAL_IMAGE_BYTES ) }).`
        },
        { status: 413 }
      );
    }

    const inputContent: Array<Record<string, unknown>> = [
      {
        type: 'input_text',
        text: buildPrompt( filename, deterministicResult )
      }
    ];

    const imageInputs: Array<{ label: string; imageUrl: string; detail: 'low' | 'high'; }> = [];
    const skippedImages: string[] = [];

    if ( rectifiedImage ) {
      const encoded = await fileToDataUrl( rectifiedImage, 'rectified image' );
      if ( encoded.ok ) {
        imageInputs.push( {
          label: 'rectified image',
          imageUrl: encoded.dataUrl,
          detail
        } );
      } else {
        skippedImages.push( encoded.error );
      }
    }

    if ( sourceImage ) {
      const encoded = await fileToDataUrl( sourceImage, 'source image' );
      if ( encoded.ok ) {
        imageInputs.push( {
          label: 'source image',
          imageUrl: encoded.dataUrl,
          detail: 'low'
        } );
      } else {
        skippedImages.push( encoded.error );
      }
    }

    if ( imageInputs.length === 0 ) {
      return NextResponse.json(
        {
          ok: false,
          error: skippedImages.length
            ? `No valid AI review image could be read. ${ skippedImages.join( ' ' ) }`
            : 'No valid AI review image could be read.'
        },
        { status: 400 }
      );
    }

    if ( skippedImages.length > 0 ) {
      inputContent.push( {
        type: 'input_text',
        text: `One or more submitted image attachments were skipped before AI review because they were not valid supported image files: ${ skippedImages.join( ' ' ) }`
      } );
    }

    for ( const imageInput of imageInputs ) {
      inputContent.push( {
        type: 'input_image',
        image_url: imageInput.imageUrl,
        detail: imageInput.detail
      } );
    }

    const response = await fetch( OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ apiKey }`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify( {
        model,
        store: false,
        instructions: [
          'You are a senior grader at PSA (Professional Sports Authenticator) with 15+ years of experience examining trading cards.',
          'You follow PSA\'s conservative grading standards and the official 10-point grading scale.',
          'You approach every card with professional skepticism - when in doubt, the lower grade prevails.',
          'Your priorities: centering and corners first (most critical), then edges, then surface condition.',
          'You look for: corner wear (even microscopic), edge chipping or roughness, surface scratches visible only under angle, print imperfections, focus issues.',
          'If centering calculations seem off, perhaps due to image quality, provide your expert visual assessment of centering based on the imagery.',
          'You flag cards that appear "borderline" between grades - these require physical inspection under magnification.',
          'You communicate in precise PSA terminology: "visible under 10x magnification", "borderline PSA 8/9", "slight corner touch", etc.',
          'You are conservative: a card you\'d grade as a PSA 8 might receive a 7 from you in this review to ensure accuracy.',
          'Return only the required structured JSON.'
        ].join( ' ' ),
        input: [
          {
            role: 'user',
            content: inputContent
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'card_grading_ai_review',
            strict: true,
            schema: AI_REVIEW_RESPONSE_SCHEMA
          }
        },
        max_output_tokens: 1800
      } )
    } );

    if ( !response.ok ) {
      return NextResponse.json(
        {
          ok: false,
          error: await readOpenAIError( response )
        },
        { status: response.status }
      );
    }

    const payload = await response.json();
    const outputText = extractOutputText( payload );
    if ( !outputText ) {
      return NextResponse.json( { ok: false, error: 'OpenAI response did not include structured output text.' }, { status: 502 } );
    }

    const review = JSON.parse( outputText );
    if ( !isAIReviewPayload( review ) ) {
      return NextResponse.json( { ok: false, error: 'OpenAI response did not match the AI review schema.' }, { status: 502 } );
    }

    return NextResponse.json( {
      ok: true,
      review: {
        ...review,
        model
      }
    } );
  } catch ( error ) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String( error )
      },
      { status: 500 }
    );
  }
}

function readFormString( form: FormData, key: string ): string {
  const value = form.get( key );
  return typeof value === 'string' ? value.trim() : '';
}

function readFormFile( form: FormData, key: string ): File | null {
  const value = form.get( key );
  if ( !value || typeof value === 'string' ) return null;
  return value;
}

function normalizeDetail( value: string ): 'low' | 'high' {
  if ( value === 'low' || value === 'high' ) return value;
  return DEFAULT_DETAIL;
}

function parseGradeResult( value: string ): GradeResult | null {
  try {
    return JSON.parse( value ) as GradeResult;
  } catch {
    return null;
  }
}

async function fileToDataUrl(
  file: File,
  label: string
): Promise<{ ok: true; dataUrl: string; } | { ok: false; error: string; }> {
  const buffer = Buffer.from( await file.arrayBuffer() );
  const mimeType = detectSupportedImageMime( buffer );

  if ( !mimeType ) {
    const declared = file.type ? `declared as ${ file.type }` : 'with no browser-provided MIME type';
    return {
      ok: false,
      error: `${ label } "${ file.name || 'unnamed image' }" was ${ declared }, but its bytes do not match JPEG, PNG, GIF, or WebP.`
    };
  }

  return {
    ok: true,
    dataUrl: `data:${ mimeType };base64,${ buffer.toString( 'base64' ) }`
  };
}

function detectSupportedImageMime( buffer: Buffer ): SupportedImageMime | null {
  const sniffedType = sniffSupportedImageMime( buffer );
  if ( sniffedType ) return sniffedType;

  return null;
}

function sniffSupportedImageMime( buffer: Buffer ): SupportedImageMime | null {
  if (
    buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    buffer.length >= 6
    && ( buffer.subarray( 0, 6 ).toString( 'ascii' ) === 'GIF87a'
      || buffer.subarray( 0, 6 ).toString( 'ascii' ) === 'GIF89a' )
  ) {
    return 'image/gif';
  }

  if (
    buffer.length >= 12
    && buffer.subarray( 0, 4 ).toString( 'ascii' ) === 'RIFF'
    && buffer.subarray( 8, 12 ).toString( 'ascii' ) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function buildPrompt( filename: string, result: GradeResult ): string {
  const reviewContext = {
    filename,
    deterministicGrade: {
      final: result.final,
      centering: result.centering
        ? {
          lr: result.centering.lr,
          tb: result.centering.tb,
          worst: result.centering.worst,
          gradeCap: result.centering.gradeCap,
          borderPixels: result.centering.debug.border,
          cardRect: result.centering.debug.cardRect,
          innerRect: result.centering.debug.innerRect
        }
        : null,
      flaws: result.flaws
        ? {
          totalPoints: result.flaws.totalPoints,
          effectivePoints: result.flaws.effectivePoints,
          condition: result.flaws.condition,
          gradeCap: result.flaws.gradeCap,
          detectedFindings: result.flaws.detectedFindings ?? [],
          items: result.flaws.items ?? []
        }
        : null,
      report: result.report
        ? {
          imageQuality: result.report.imageQuality,
          finalGradeLabel: result.report.finalGradeLabel,
          finalGradeNumeric: result.report.finalGradeNumeric,
          confidenceBand: result.report.confidenceBand,
          manualReviewRequired: result.report.manualReviewRequired,
          centeringGradeCeiling: result.report.centeringGradeCeiling,
          visibleDefectGradeCeiling: result.report.visibleDefectGradeCeiling,
          confidenceGradeCeiling: result.report.confidenceGradeCeiling,
          topReasons: result.report.topReasons,
          topChangeDrivers: result.report.topChangeDrivers,
          limitations: result.report.limitations
        }
        : null
    }
  };

  return [
    'You are reviewing a card submission for PSA grading based on front-only imagery.',
    '',
    'YOUR GRADING FRAMEWORK:',
    'Centering: 55/45 or better supports the deterministic PSA 10 front-centering cap, 65/35 or better supports PSA 9, and 70/30 or better supports PSA 8.',
    'Corners: Must be sharp to the naked eye. ANY visible wear under magnification drops the grade.',
    'Edges: Must be original and sharp. No chipping, roughness, or dinging.',
    'Surface: No scratches, print spots, or focus issues visible under 10x magnification.',
    '',
    'IMAGERY CONTEXT:',
    'Image 1 (if present): Rectified analysis image with deterministic measurements overlaid.',
    'Image 2 (if present): Original source photo for overall context.',
    '',
    'YOUR ROLE:',
    'If centering calculations seem off, perhaps due to image quality, provide your expert visual assessment of centering based on the imagery.',
    'You ARE providing expert visual assessment of corners, edges, and surface condition.',
    'Flag anything that would cause PSA to reject a grade or require physical inspection.',
    'Be conservative: when borderline between grades, assume the lower grade.',
    'A card with "no visible flaws" in front-only images is not automatically a PSA 10; high-grade recommendations must still respect centering, image quality, reverse-side uncertainty, gloss loss uncertainty, and any defects visible under magnification.',
    '',
    `SUBMISSION DATA:\n${ JSON.stringify( reviewContext, null, 2 ) }`
  ].join( '\n' );
}

function extractOutputText( payload: unknown ): string {
  const direct = ( payload as { output_text?: unknown; } )?.output_text;
  if ( typeof direct === 'string' ) return direct;

  const output = ( payload as { output?: unknown; } )?.output;
  if ( !Array.isArray( output ) ) return '';

  for ( const item of output ) {
    const content = ( item as { content?: unknown; } )?.content;
    if ( !Array.isArray( content ) ) continue;
    for ( const part of content ) {
      const text = ( part as { text?: unknown; } )?.text;
      if ( typeof text === 'string' && text.trim() ) return text;
    }
  }

  return '';
}

async function readOpenAIError( response: Response ): Promise<string> {
  try {
    const payload = await response.json();
    const message = payload?.error?.message;
    return typeof message === 'string' ? message : JSON.stringify( payload );
  } catch {
    return await response.text();
  }
}

function formatBytes( value: number ): string {
  if ( value < 1024 ) return `${ value } B`;
  if ( value < 1024 * 1024 ) return `${ ( value / 1024 ).toFixed( 1 ) } KB`;
  return `${ ( value / ( 1024 * 1024 ) ).toFixed( 1 ) } MB`;
}
