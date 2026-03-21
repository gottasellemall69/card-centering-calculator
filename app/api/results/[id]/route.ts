import { NextResponse } from 'next/server';
import * as fs from 'node:fs/promises';
import path from 'path';

const BASE = process.env.CARD_GRADER_OUTDIR || '/tmp/card-grader-results';
export const runtime = 'nodejs';

export async function GET( _req: Request, ctx: { params: Promise<{ id: string; }>; } ) {
  const { id } = await ctx.params;
  const dir = path.join( BASE, id );
  try {
    const json = await fs.readFile( path.join( dir, 'result.json' ), 'utf8' );
    return NextResponse.json( { ok: true, result: JSON.parse( json ) } );
  } catch ( e: any ) {
    return NextResponse.json( { ok: false, error: 'Not found' }, { status: 404 } );
  }
}

export const dynamic = 'force-dynamic';
