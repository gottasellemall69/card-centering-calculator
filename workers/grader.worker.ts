import { gradeCardFront, prepareCardFrontCanvasOnly, type GradeResult, type ManualGuideOverride } from '@/lib/grader';

type PrepareRequestMessage = { type: 'PREPARE'; id: string; file: File; };
type GradeRequestMessage = { type: 'GRADE'; id: string; file: File; manualGuideOverride?: ManualGuideOverride | null; };
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
  overlayBlob: Blob;
  rectifiedBlob: Blob;
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

    const { result, overlayPNG, rectifiedPNG } = await gradeCardFront(
      message.file,
      message.manualGuideOverride ?? null
    );
    const [overlayBlob, rectifiedBlob] = await Promise.all([
      dataUrlToBlob(overlayPNG),
      dataUrlToBlob(rectifiedPNG)
    ]);
    const done: GradeResponseMessage = {
      type: 'DONE',
      id: message.id,
      result,
      overlayBlob,
      rectifiedBlob
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

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to decode worker artifact (${response.status}).`);
  }
  return response.blob();
}

export {};
