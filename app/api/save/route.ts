import { NextResponse } from 'next/server';
import * as fs from 'node:fs/promises';
import path from 'path';

import type { GradeResult } from '@/lib/grader';
import { flattenGradeResult, serializeGradeRowsToCsv } from '@/lib/resultExport';

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
  await refreshSummaryCsv();

  return NextResponse.json( { ok: true, id } );
}

async function refreshSummaryCsv(): Promise<void> {
  const rows = await loadSavedRows();
  const csv = serializeGradeRowsToCsv(rows);
  await fs.writeFile(path.join(BASE, 'summary.csv'), csv, 'utf8');
}

async function loadSavedRows() {
  let ids: string[] = [];
  try {
    ids = await fs.readdir(BASE);
  } catch {
    return [];
  }

  const rows = await Promise.all(ids.map(async (id) => {
    const filePath = path.join(BASE, id, 'result.json');
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { filename?: string } & GradeResult;
      if (!parsed.filename) return null;
      return flattenGradeResult(parsed.filename, parsed);
    } catch {
      return null;
    }
  }));

  return rows.filter((row): row is ReturnType<typeof flattenGradeResult> => row !== null);
}

function dataUrlToBuffer( dataUrl: string ): Buffer {
  const m = dataUrl.match( /^data:(.+);base64,(.*)$/ );
  if ( !m ) throw new Error( 'Invalid data URL' );
  return Buffer.from( m[ 2 ], 'base64' );
}
