import { NextResponse } from 'next/server';
import * as fs from 'node:fs/promises';
import path from 'path';

const BASE = process.env.CARD_GRADER_OUTDIR || '/tmp/card-grader-results';
export const runtime = 'nodejs';

export async function POST( req: Request ) {
  const body = await req.json();
  const { id, filename, rectifiedPNG, overlayPNG, result } = body ?? {};
  if ( !id || !filename || !rectifiedPNG || !overlayPNG || !result ) {
    return NextResponse.json( { ok: false, error: 'Missing required fields.' }, { status: 400 } );
  }

  await fs.mkdir( BASE, { recursive: true } );
  const dir = path.join( BASE, id );
  await fs.mkdir( dir, { recursive: true } );

  // data URLs -> buffers
  const rectBuf = dataUrlToBuffer( rectifiedPNG );
  const overBuf = dataUrlToBuffer( overlayPNG );
  await fs.writeFile( path.join( dir, 'rectified.png' ), rectBuf );
  await fs.writeFile( path.join( dir, 'overlay.png' ), overBuf );
  await fs.writeFile( path.join( dir, 'result.json' ), JSON.stringify( { id, filename, ...result }, null, 2 ) );

  return NextResponse.json( { ok: true, id } );
}

function dataUrlToBuffer( dataUrl: string ): Buffer {
  const m = dataUrl.match( /^data:(.+);base64,(.*)$/ );
  if ( !m ) throw new Error( 'Invalid data URL' );
  return Buffer.from( m[ 2 ], 'base64' );
}
