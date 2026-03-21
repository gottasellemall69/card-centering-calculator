import { NextResponse } from 'next/server';
import {
  EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_FRONT,
  EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_RESULT
} from '@/lib/psaManualEstimate';

export function GET() {
  return NextResponse.json({
    ok: true,
    observation: EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_FRONT,
    result: EXAMPLE_1991_UPPER_DECK_MICHAEL_JORDAN_RESULT
  });
}

