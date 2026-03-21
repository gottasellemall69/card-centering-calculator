import { NextResponse } from 'next/server';
import * as fs from 'node:fs/promises';
import path from 'path';

const BASE = process.env.CARD_GRADER_OUTDIR || '/tmp/card-grader-results';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const ids = await fs.readdir( BASE );
    return NextResponse.json( { ok: true, ids } );
  } catch {
    return NextResponse.json( { ok: true, ids: [] } );
  }
}

export const dynamic = 'force-dynamic';
