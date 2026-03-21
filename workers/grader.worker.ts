import { gradeCardFrontCanvasOnly, prepareCardFrontCanvasOnly, type GradeResult } from '@/lib/grader';

type PrepareRequestMessage = { type: 'PREPARE'; id: string; file: File; };
type GradeRequestMessage = { type: 'GRADE'; id: string; file: File; };
type GradeRequestMessageAny = PrepareRequestMessage | GradeRequestMessage;
type PrepareDoneMessage = {
  type: 'PREPARED';
  id: string;
  result: GradeResult;
};
type GradeDoneMessage = {
  type: 'DONE';
  id: string;
  result: GradeResult;
  overlayPNG: string;
  rectifiedPNG: string;
};
type GradeErrorMessage = { type: 'ERROR'; id: string; error: string; };
type GradeResponseMessage = PrepareDoneMessage | GradeDoneMessage | GradeErrorMessage;

const ctx: any = self;

ctx.onmessage = async (event: MessageEvent<GradeRequestMessageAny>) => {
  const message = event.data;
  if (!message || (message.type !== 'PREPARE' && message.type !== 'GRADE')) return;

  try {
    if (message.type === 'PREPARE') {
      const { result } = await prepareCardFrontCanvasOnly(message.file);
      const prepared: GradeResponseMessage = {
        type: 'PREPARED',
        id: message.id,
        result
      };
      ctx.postMessage(prepared);
      return;
    }

    const { result, overlayPNG, rectifiedPNG } = await gradeCardFrontCanvasOnly(message.file);
    const done: GradeResponseMessage = {
      type: 'DONE',
      id: message.id,
      result,
      overlayPNG,
      rectifiedPNG
    };
    ctx.postMessage(done);
  } catch (error) {
    const failed: GradeResponseMessage = {
      type: 'ERROR',
      id: message.id,
      error: error instanceof Error ? error.message : String(error)
    };
    ctx.postMessage(failed);
  }
};

export {};
