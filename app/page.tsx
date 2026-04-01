'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import type { GradeResult, ManualGuideOverride } from '@/lib/grader';
import { OverlayViewer, type ManualCenteringView } from '@/components/OverlayViewer';
import { flattenGradeResult, serializeGradeRowsToCsv } from '@/lib/resultExport';
import { finalGradeFromCaps } from '@/lib/rubric';

type RowStatus = 'PENDING' | 'PREPARING' | 'REVIEW' | 'PROCESSING' | 'DONE' | 'ERROR';

type Row = {
  id: string;
  filename: string;
  file: File;
  status: RowStatus;
  engine?: 'WORKER';
  startedAtMs?: number;
  completedAtMs?: number;
  preview?: GradeResult;
  result?: GradeResult;
  manualCentering?: ManualCenteringView | null;
  error?: string;
  sourceObjectURL: string;
  overlayObjectURL?: string;
  rectifiedObjectURL?: string;
};

type ResultModalPayload = {
  rowId: string;
  filename: string;
  result: GradeResult;
  overlayObjectURL?: string;
  rectifiedObjectURL?: string;
  sourceObjectURL: string;
  openedAtMs: number;
};

type PrepareWorkerRequest = { type: 'PREPARE'; id: string; file: File; };
type GradeWorkerRequest = { type: 'GRADE'; id: string; file: File; manualGuideOverride?: ManualGuideOverride | null; };
type WorkerRequest = PrepareWorkerRequest | GradeWorkerRequest;

type WorkerPreparedMessage = {
  type: 'PREPARED';
  id: string;
  result: GradeResult;
};

type WorkerDoneMessage = {
  type: 'DONE';
  id: string;
  result: GradeResult;
  overlayBlob: Blob;
  rectifiedBlob: Blob;
};

type WorkerErrorMessage = { type: 'ERROR'; id: string; error: string; };
type WorkerResponse = WorkerPreparedMessage | WorkerDoneMessage | WorkerErrorMessage;

type PrepareOutput = { result: GradeResult; engine: 'WORKER'; };
type GradeOutput = { result: GradeResult; overlayBlob: Blob; rectifiedBlob: Blob; engine: 'WORKER'; };

const WORKER_TASK_TIMEOUT_MS = 20000;

export default function Page() {
  const [rows, setRows] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resultModal, setResultModal] = useState<ResultModalPayload | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; mode: 'preparing' | 'grading'; } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const stopRequestedRef = useRef(false);
  const workerRef = useRef<Worker | null>(null);
  const rowsRef = useRef<Row[]>([]);
  const inFlightRef = useRef<{
    id: string;
    requestType: WorkerRequest['type'];
    resolve: (value: PrepareOutput | GradeOutput) => void;
    reject: (reason?: unknown) => void;
    timeoutId: number;
  } | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    return () => {
      rowsRef.current.forEach((row) => revokeRowObjectUrls(row));
    };
  }, []);

  const selected = useMemo(() => rows.find((row) => row.id === selectedId) ?? null, [rows, selectedId]);
  const selectedSeedResult = selected?.result ?? selected?.preview ?? null;
  const displayedResult = useMemo(
    () => (selected?.result ? applyManualCenteringOverride(selected.result, selected.manualCentering ?? null) : null),
    [selected]
  );
  const displayCentering = selected?.manualCentering ?? displayedResult?.centering ?? selectedSeedResult?.centering ?? null;
  const displayMm = deriveCenteringMillimeters(displayCentering);
  const estimateNeedsRefresh = !!selected?.result && !sameCentering(selected.result.centering, selected.manualCentering);

  const handleSelectedCenteringChange = useCallback((value: ManualCenteringView | null) => {
    if (!selectedId) return;

    setRows((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (row.id !== selectedId) return row;
        if (sameCentering(row.manualCentering, value)) return row;
        changed = true;
        return { ...row, manualCentering: value };
      });
      return changed ? next : prev;
    });
  }, [selectedId]);

  const setupWorker = () => {
    if (workerRef.current) return;

    const worker = new Worker(new URL('../workers/grader.worker.ts', import.meta.url));
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const pending = inFlightRef.current;
      if (!pending || pending.id !== message.id) return;

      window.clearTimeout(pending.timeoutId);
      inFlightRef.current = null;

      if (message.type === 'ERROR') {
        pending.reject(new Error(message.error));
        return;
      }

      if (pending.requestType === 'PREPARE' && message.type === 'PREPARED') {
        pending.resolve({
          result: message.result,
          engine: 'WORKER'
        });
        return;
      }

      if (pending.requestType === 'GRADE' && message.type === 'DONE') {
        pending.resolve({
          result: message.result,
          overlayBlob: message.overlayBlob,
          rectifiedBlob: message.rectifiedBlob,
          engine: 'WORKER'
        });
        return;
      }

      pending.reject(new Error('Grading worker returned an unexpected response.'));
    };

    worker.onerror = (event) => {
      const pending = inFlightRef.current;
      if (workerRef.current === worker) {
        worker.terminate();
        workerRef.current = null;
      }
      if (!pending) return;

      window.clearTimeout(pending.timeoutId);
      inFlightRef.current = null;
      pending.reject(new Error(event.message || 'Grading worker failed.'));
    };

    worker.onmessageerror = () => {
      const pending = inFlightRef.current;
      if (workerRef.current === worker) {
        worker.terminate();
        workerRef.current = null;
      }
      if (!pending) return;

      window.clearTimeout(pending.timeoutId);
      inFlightRef.current = null;
      pending.reject(new Error('Grading worker returned an unreadable response.'));
    };

    workerRef.current = worker;
  };

  const teardownWorker = (reason: string) => {
    const pending = inFlightRef.current;
    inFlightRef.current = null;
    if (pending) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }

    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  };

  const restartWorker = (reason: string) => {
    teardownWorker(reason);
    setupWorker();
  };

  const prepareWithWorker = (id: string, file: File) => {
    return new Promise<PrepareOutput>((resolve, reject) => {
      setupWorker();
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error('Grading worker is unavailable.'));
        return;
      }
      if (inFlightRef.current) {
        reject(new Error('Grading worker is busy.'));
        return;
      }

      const timeoutId = window.setTimeout(() => {
        const pending = inFlightRef.current;
        if (!pending || pending.id !== id) return;
        inFlightRef.current = null;
        if (workerRef.current) {
          workerRef.current.terminate();
          workerRef.current = null;
        }
        pending.reject(new Error(`Worker timed out after ${Math.round(WORKER_TASK_TIMEOUT_MS / 1000)}s.`));
      }, WORKER_TASK_TIMEOUT_MS);

      inFlightRef.current = {
        id,
        requestType: 'PREPARE',
        resolve: resolve as (value: PrepareOutput | GradeOutput) => void,
        reject,
        timeoutId
      };

      const message: PrepareWorkerRequest = { type: 'PREPARE', id, file };
      worker.postMessage(message);
    });
  };

  const gradeWithWorker = (id: string, file: File, manualGuideOverride?: ManualGuideOverride | null) => {
    return new Promise<GradeOutput>((resolve, reject) => {
      setupWorker();
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error('Grading worker is unavailable.'));
        return;
      }
      if (inFlightRef.current) {
        reject(new Error('Grading worker is busy.'));
        return;
      }

      const timeoutId = window.setTimeout(() => {
        const pending = inFlightRef.current;
        if (!pending || pending.id !== id) return;
        inFlightRef.current = null;
        if (workerRef.current) {
          workerRef.current.terminate();
          workerRef.current = null;
        }
        pending.reject(new Error(`Worker timed out after ${Math.round(WORKER_TASK_TIMEOUT_MS / 1000)}s.`));
      }, WORKER_TASK_TIMEOUT_MS);

      inFlightRef.current = {
        id,
        requestType: 'GRADE',
        resolve: resolve as (value: PrepareOutput | GradeOutput) => void,
        reject,
        timeoutId
      };

      const message: GradeWorkerRequest = { type: 'GRADE', id, file, manualGuideOverride: manualGuideOverride ?? null };
      worker.postMessage(message);
    });
  };

  const prepareWithRecovery = async (id: string, file: File) => {
    try {
      return await prepareWithWorker(id, file);
    } catch (firstErr: any) {
      if (stopRequestedRef.current) {
        throw new Error('Cancelled by user.');
      }

      restartWorker('Worker restarted after failure.');
      try {
        return await prepareWithWorker(id, file);
      } catch (secondErr: any) {
        const firstMessage = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const secondMessage = secondErr instanceof Error ? secondErr.message : String(secondErr);
        throw new Error(`Worker prepare failed twice: ${firstMessage} | ${secondMessage}`);
      }
    }
  };

  const gradeWithRecovery = async (id: string, file: File, manualGuideOverride?: ManualGuideOverride | null) => {
    try {
      return await gradeWithWorker(id, file, manualGuideOverride);
    } catch (firstErr: any) {
      if (stopRequestedRef.current) {
        throw new Error('Cancelled by user.');
      }

      restartWorker('Worker restarted after failure.');
      try {
        return await gradeWithWorker(id, file, manualGuideOverride);
      } catch (secondErr: any) {
        const firstMessage = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const secondMessage = secondErr instanceof Error ? secondErr.message : String(secondErr);
        throw new Error(`Worker grading failed twice: ${firstMessage} | ${secondMessage}`);
      }
    }
  };

  useEffect(() => {
    setupWorker();
    return () => {
      teardownWorker('Grading worker stopped.');
    };
  }, []);

  useEffect(() => {
    if (!isProcessing) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(intervalId);
  }, [isProcessing]);

  useEffect(() => {
    if (!resultModal) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setResultModal(null);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [resultModal]);

  const onFiles = async (files: FileList | File[]) => {
    const jobs = Array.from(files)
      .filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file.name))
      .map((file) => {
        const row: Row = {
          id: uuidv4(),
          filename: file.name,
          file,
          status: 'PENDING',
          sourceObjectURL: URL.createObjectURL(file),
          manualCentering: null
        };
        return { file, row };
      });

    const newRows = jobs.map((job) => job.row);
    if (newRows.length === 0) return;

    setRows((prev) => [...prev, ...newRows]);
    setSelectedId(newRows[0].id);

    stopRequestedRef.current = false;
    setIsProcessing(true);
    setBatchProgress({ done: 0, total: newRows.length, mode: 'preparing' });

    try {
      let cancelled = false;
      for (const job of jobs) {
        const row = job.row;
        if (stopRequestedRef.current) {
          cancelled = true;
          break;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        setRows((prev) => prev.map((current) => (
          current.id === row.id
            ? {
              ...current,
              status: 'PREPARING',
              engine: undefined,
              error: undefined,
              startedAtMs: Date.now(),
              completedAtMs: undefined,
              preview: undefined,
              result: undefined,
              overlayObjectURL: undefined,
              rectifiedObjectURL: undefined
            }
            : current
        )));

        try {
          const { result, engine } = await prepareWithRecovery(row.id, job.file);
          setRows((prev) => prev.map((current) => (
            current.id === row.id
              ? {
                ...current,
                status: 'REVIEW',
                preview: result,
                engine,
                error: undefined,
                completedAtMs: Date.now()
              }
              : current
          )));
        } catch (error: any) {
          setRows((prev) => prev.map((current) => (
            current.id === row.id
              ? {
                ...current,
                status: 'ERROR',
                error: String(error?.message ?? error),
                completedAtMs: Date.now()
              }
              : current
          )));
        }

        setBatchProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }

      if (cancelled) {
        const ids = new Set(newRows.map((row) => row.id));
        setRows((prev) => prev.map((row) => (
          ids.has(row.id) && (row.status === 'PENDING' || row.status === 'PREPARING')
            ? {
              ...row,
              status: 'ERROR',
              error: 'Cancelled by user.',
              startedAtMs: row.startedAtMs ?? Date.now(),
              completedAtMs: Date.now()
            }
            : row
        )));
      }
    } finally {
      setIsProcessing(false);
      setBatchProgress(null);
    }
  };

  const estimateSelected = async () => {
    if (!selected) return;
    if (!selected.preview && !selected.result) return;

    stopRequestedRef.current = false;
    setIsProcessing(true);
    setBatchProgress(null);

    setRows((prev) => prev.map((row) => (
      row.id === selected.id
        ? {
          ...row,
          status: 'PROCESSING',
          error: undefined,
          startedAtMs: Date.now(),
          completedAtMs: undefined
        }
        : row
    )));

    try {
      const manualGuideOverride = toManualGuideOverride(selected.manualCentering ?? null);
      const { result: gradedResult, overlayBlob, rectifiedBlob, engine } = await gradeWithRecovery(
        selected.id,
        selected.file,
        manualGuideOverride
      );
      const finalResult = applyManualCenteringOverride(gradedResult, selected.manualCentering ?? null);
      const overlayObjectURL = URL.createObjectURL(overlayBlob);
      const rectifiedObjectURL = URL.createObjectURL(rectifiedBlob);
      revokeObjectUrlSafe(selected.overlayObjectURL);
      revokeObjectUrlSafe(selected.rectifiedObjectURL);

      setRows((prev) => prev.map((row) => (
        row.id === selected.id
          ? {
            ...row,
            status: 'DONE',
            result: finalResult,
            overlayObjectURL,
            rectifiedObjectURL,
            engine,
            error: undefined,
            completedAtMs: Date.now()
          }
          : row
      )));

      setResultModal({
        rowId: selected.id,
        filename: selected.filename,
        result: finalResult,
        overlayObjectURL,
        rectifiedObjectURL,
        sourceObjectURL: selected.sourceObjectURL,
        openedAtMs: Date.now()
      });
    } catch (error: any) {
      setRows((prev) => prev.map((row) => (
        row.id === selected.id
          ? {
            ...row,
            status: 'ERROR',
            error: String(error?.message ?? error),
            completedAtMs: Date.now()
          }
          : row
      )));
    } finally {
      setIsProcessing(false);
    }
  };

  const formatDurationMs = (durationMs: number): string => {
    if (durationMs < 1000) return `${durationMs}ms`;
    if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.floor((durationMs % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  };

  const getElapsedLabel = (row: Row): string => {
    if (!row.startedAtMs) return '-';
    const running = row.status === 'PREPARING' || row.status === 'PROCESSING';
    const endMs = row.completedAtMs ?? (running ? nowMs : row.startedAtMs);
    return formatDurationMs(Math.max(0, endMs - row.startedAtMs));
  };

  const clearAll = () => {
    stopRequestedRef.current = true;
    restartWorker('Processing cancelled.');
    rows.forEach((row) => revokeRowObjectUrls(row));
    setRows([]);
    setSelectedId(null);
    setResultModal(null);
    setBatchProgress(null);
  };

  const downloadJSON = () => {
    const payload = rows
      .filter(hasResult)
      .map((row) => ({ id: row.id, filename: row.filename, ...row.result }));
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), results: payload }, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'results.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadCSV = () => {
    const data = rows
      .filter(hasResult)
      .map((row) => flattenGradeResult(row.filename, row.result));
    const csv = serializeGradeRowsToCsv(data);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'results.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const uploadButtonLabel = !isProcessing
    ? 'Select images'
    : batchProgress
      ? `${batchProgress.mode === 'preparing' ? 'Preparing' : 'Processing'} ${batchProgress.done}/${batchProgress.total}`
      : 'Working...';

  const canEstimate = !!selectedSeedResult
    && !!selected
    && selected.status !== 'PREPARING'
    && selected.status !== 'PROCESSING'
    && !isProcessing;

  return (
    <>
    <div className="row">
      <section className="card" style={{ flex: '1 1 420px', minWidth: 320 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>1) Upload images (front only)</h2>
        <div className="notice" style={{ marginBottom: 12 }}>
          Upload a card photo, review the detected measurement area, then estimate the grade once the guides look right.
        </div>
        <div className="small" style={{ marginBottom: 12 }}>
          Nothing is persisted automatically. Images and overlays stay in memory for the current session unless you explicitly export results.
        </div>

        <div className="row" style={{ alignItems: 'center' }}>
          <button
            className="btn btnPrimary"
            onClick={() => filesInputRef.current?.click()}
            disabled={isProcessing}
          >
            {uploadButtonLabel}
          </button>

          <button
            className="btn"
            onClick={() => folderInputRef.current?.click()}
            disabled={isProcessing}
          >
            Select folder
          </button>

          <button className="btn" onClick={clearAll} disabled={rows.length === 0 || isProcessing}>
            Clear
          </button>

          <button
            className="btn"
            onClick={() => {
              stopRequestedRef.current = true;
              restartWorker('Processing cancelled.');
            }}
            disabled={!isProcessing}
          >
            Stop
          </button>

          <button className="btn" onClick={downloadJSON} disabled={rows.every((row) => !row.result)}>
            Download JSON
          </button>

          <button className="btn" onClick={downloadCSV} disabled={rows.every((row) => !row.result)}>
            Download CSV
          </button>
        </div>

        <input
          ref={filesInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={(event) => {
            if (event.target.files) void onFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <input
          ref={folderInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          // @ts-expect-error webkitdirectory is non-standard but widely supported (Chromium).
          webkitdirectory="true"
          onChange={(event) => {
            if (event.target.files) void onFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <div
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer.files) void onFiles(event.dataTransfer.files);
          }}
          style={{
            marginTop: 14,
            padding: 16,
            border: '1px dashed var(--border)',
            borderRadius: 16,
            background: 'rgba(255,255,255,0.02)'
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>Drag and drop images here</div>
          <div className="small" style={{ marginTop: 6 }}>
            Filters to PNG, JPG, and WEBP. Uploading now prepares the card bounds for review instead of immediately grading the image.
          </div>
          <div className="small" style={{ marginTop: 4 }}>
            Status flow: PENDING - PREPARING - REVIEW - PROCESSING - DONE/ERROR.
          </div>
        </div>

        <hr />

        <h2 style={{ margin: 0, fontSize: 16 }}>2) Queue</h2>
        <div className="small" style={{ marginTop: 6 }}>
          Select a row to review the overlay, adjust the measurement area, and then estimate the grade for that image.
        </div>

        <div style={{ marginTop: 10, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
                <th>Engine</th>
                <th>Elapsed</th>
                <th>Grade</th>
                <th>Est. #</th>
                <th>Center</th>
                <th>Flaw pts</th>
                <th>Conf.</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="small">No files yet.</td>
                </tr>
              ) : (
                rows.map((row) => {
                  const displayRowResult = row.result ? applyManualCenteringOverride(row.result, row.manualCentering ?? null) : null;
                  const previewNumeric = row.preview?.final?.psaNumeric;
                  const estimatedNumeric = displayRowResult?.final?.psaNumeric ?? null;
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedId(row.id)}
                      style={{ cursor: 'pointer', background: selectedId === row.id ? 'rgba(125,211,252,0.08)' : undefined }}
                    >
                      <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.filename}
                      </td>
                      <td>{row.status}</td>
                      <td>{row.engine ?? '-'}</td>
                      <td>{getElapsedLabel(row)}</td>
                      <td>
                        {displayRowResult ? (
                          displayRowResult.final.unscorable ? (
                            <span style={{ color: 'var(--warn)' }}>UNSCORABLE</span>
                          ) : (
                            <span style={{ color: 'var(--good)' }}>{displayRowResult.final.gradeLabel}</span>
                          )
                        ) : row.status === 'ERROR' ? (
                          <span style={{ color: 'var(--bad)' }}>ERROR</span>
                        ) : row.status === 'REVIEW' ? (
                          <span style={{ color: 'var(--muted)' }}>Ready</span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>
                        {estimatedNumeric != null ? (
                          estimatedNumeric
                        ) : previewNumeric != null ? (
                          <span style={{ color: 'var(--muted)' }}>~{previewNumeric}</span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>{displayRowResult?.centering?.worst?.ratio ?? row.manualCentering?.worst?.ratio ?? row.preview?.centering?.worst?.ratio ?? '-'}</td>
                      <td>{displayRowResult?.flaws?.effectivePoints ?? displayRowResult?.flaws?.totalPoints ?? '-'}</td>
                      <td>{displayRowResult ? displayRowResult.final.confidence.toFixed(2) : '-'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ flex: '1 1 520px', minWidth: 320 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>3) Review and estimate</h2>
        {!selected ? (
          <div className="small">Select an uploaded image to review its measurement guides.</div>
        ) : !selectedSeedResult ? (
          <div className="small">
            {selected.status === 'ERROR'
              ? `Error: ${selected.error}`
              : selected.status === 'PREPARING'
                ? 'Preparing measurement guides...'
                : 'Waiting for measurement data...'}
          </div>
        ) : (
          <>
            <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ minWidth: 240 }}>
                <div style={{ fontWeight: 700 }}>{selected.filename}</div>
                <div className="small">
                  {displayedResult
                    ? displayedResult.final.unscorable
                      ? `UNSCORABLE (${displayedResult.final.unscorableReasons?.map((reason) => reason.code)?.join(', ') ?? 'manual review required'})`
                      : `${displayedResult.final.gradeLabel} (PSA ${displayedResult.final.psaNumeric})`
                    : 'Review the guides, then run the estimate for the final grade and flaw summary.'}
                </div>
              </div>
              <div className="badge">
                Status: <b style={{ color: 'var(--text)' }}>{selected.status}</b>
              </div>
              <div className="badge">
                Engine: <b style={{ color: 'var(--text)' }}>{selected.engine ?? '-'}</b>
              </div>
              <div className="badge">
                Session only: <b style={{ color: 'var(--text)' }}>Yes</b>
              </div>
            </div>

            {selected.error ? (
              <div className="notice" style={{ marginTop: 10 }}>
                {`Error: ${selected.error}`}
              </div>
            ) : null}

            <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
              <div className="notice" style={{ flex: '1 1 320px' }}>
                The current guide positions are the measurement area that will be used for centering when you estimate this image.
              </div>
              <div className="row" style={{ gap: 8 }}>
                {displayedResult ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setResultModal({
                      rowId: selected.id,
                      filename: selected.filename,
                      result: displayedResult,
                      overlayObjectURL: selected.overlayObjectURL,
                      rectifiedObjectURL: selected.rectifiedObjectURL,
                      sourceObjectURL: selected.sourceObjectURL,
                      openedAtMs: Date.now()
                    })}
                  >
                    View full evidence
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btnPrimary"
                  onClick={() => void estimateSelected()}
                  disabled={!canEstimate}
                >
                  {selected.status === 'PROCESSING'
                    ? 'Estimating...'
                    : displayedResult
                      ? 'Re-estimate grade'
                      : 'Estimate grade'}
                </button>
              </div>
            </div>

            {estimateNeedsRefresh ? (
              <div className="notice" style={{ marginTop: 10 }}>
                Guides changed after the last estimate. Click Re-estimate grade to apply the current measurement area to the current result.
              </div>
            ) : null}

            <hr />

            <OverlayViewer
              key={selected.id}
              imageDataUrl={selected.sourceObjectURL}
              result={selectedSeedResult}
              manualCentering={selected.manualCentering ?? null}
              alt={selected.filename}
              onCenteringChange={handleSelectedCenteringChange}
            />

            <hr />

            <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Centering</h3>
            <div className="small" style={{ marginBottom: 8 }}>
              Using the current guide positions from the overlay editor.
            </div>
            <div className="kv"><div className="small">Left/Right</div><div>{displayCentering?.lr?.ratio ?? '-'}</div></div>
            <div className="kv"><div className="small">Top/Bottom</div><div>{displayCentering?.tb?.ratio ?? '-'}</div></div>
            <div className="kv"><div className="small">Worst used</div><div>{displayCentering?.worst?.ratio ?? '-'}</div></div>
            <div className="kv"><div className="small">Centering cap</div><div>{displayCentering?.gradeCap?.gradeLabel ?? '-'}</div></div>
            <div className="kv"><div className="small">L/R thickness</div><div>{displayMm ? `${displayMm.left.toFixed(1)}mm / ${displayMm.right.toFixed(1)}mm` : '-'}</div></div>
            <div className="kv"><div className="small">T/B thickness</div><div>{displayMm ? `${displayMm.top.toFixed(1)}mm / ${displayMm.bottom.toFixed(1)}mm` : '-'}</div></div>

            {displayedResult ? (
              <>
                <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>Estimate</h3>
                <div className="kv"><div className="small">Grade</div><div>{displayedResult.final.gradeLabel} (PSA {displayedResult.final.psaNumeric})</div></div>
                <div className="kv"><div className="small">Confidence</div><div>{displayedResult.final.confidence.toFixed(2)}</div></div>
                <div className="kv"><div className="small">Confidence band</div><div>{displayedResult.report?.confidenceBand ?? '-'}</div></div>
                <div className="kv"><div className="small">Manual review</div><div>{displayedResult.report?.manualReviewRequired ? 'YES' : 'NO'}</div></div>
                <div className="kv"><div className="small">Condition</div><div>{displayedResult.flaws?.condition ?? '-'}</div></div>
                <div className="kv"><div className="small">Flaw cap</div><div>{displayedResult.flaws?.gradeCap?.gradeLabel ?? '-'}</div></div>
                <div className="kv"><div className="small">Flaw profile</div><div>{displayedResult.flaws?.psaProfile ?? '-'}</div></div>
                <div className="kv">
                  <div className="small">Total flaw points</div>
                  <div>
                    {!displayedResult.flaws
                      ? '-'
                      : displayedResult.flaws.effectivePoints && displayedResult.flaws.effectivePoints !== displayedResult.flaws.totalPoints
                        ? `${displayedResult.flaws.totalPoints} raw / ${displayedResult.flaws.effectivePoints} rubric`
                      : displayedResult.flaws.totalPoints}
                  </div>
                </div>

                <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>Image quality</h3>
                <div className="kv"><div className="small">Card detected</div><div>{displayedResult.report?.cardDetected ? 'YES' : 'NO'}</div></div>
                <div className="kv"><div className="small">Full front visible</div><div>{displayedResult.report?.fullFrontVisible ? 'YES' : 'NO'}</div></div>
                <div className="kv"><div className="small">Quality score</div><div>{displayedResult.report ? displayedResult.report.imageQuality.imageQualityScore.toFixed(2) : '-'}</div></div>
                <div className="small" style={{ marginTop: 8 }}>
                  {displayedResult.report?.imageQuality.checks?.some((check) => check.severity !== 'none') ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {displayedResult.report?.imageQuality.checks?.filter((check) => check.severity !== 'none')?.map((check) => (
                          <li key={check.key}>
                            <b>{check.label}</b>: {check.severity.toUpperCase()} {check.metric ? `(${check.metric})` : ''} - {check.note}
                          </li>
                        ))}
                    </ul>
                  ) : (
                    'No image-quality warnings were emitted.'
                  )}
                </div>

                <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>Grade ceilings</h3>
                <div className="kv"><div className="small">Centering ceiling</div><div>{displayedResult.report?.centeringGradeCeiling.cap.gradeLabel ?? '-'}</div></div>
                <div className="kv"><div className="small">Visible-defect ceiling</div><div>{displayedResult.report?.visibleDefectGradeCeiling.cap.gradeLabel ?? '-'}</div></div>
                <div className="kv"><div className="small">Observability ceiling</div><div>{displayedResult.report?.confidenceGradeCeiling.cap.gradeLabel ?? '-'}</div></div>
                <div className="small" style={{ marginTop: 8 }}>
                  {displayedResult.report?.topReasons?.length
                    ? displayedResult.report?.topReasons?.join(' | ')
                    : 'No supporting reasons available.'}
                </div>

                <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>Flaws</h3>
                <div className="small" style={{ marginTop: 8 }}>
                  {displayedResult.report?.detectedDefects?.length ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {displayedResult.report?.detectedDefects?.map((item) => (
                        <li key={item.id}>
                          <b>{item.flawType}</b>: {item.severity} at {item.location}, evidence {item.evidenceStrength}
                          {item.measurement ? `, ${item.measurement.display}` : ''}
                          {` - ${item.metric}`}
                        </li>
                      ))}
                    </ul>
                  ) : displayedResult.flaws?.items?.length ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {displayedResult.flaws.items.map((item, index) => (
                        <li key={index}>
                          <b>{item.category}</b>: {item.severity} ({item.points} pts) - {item.metric}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    'No flaws detected above thresholds.'
                  )}
                </div>
                {displayedResult.flaws?.limitingFlaws?.length ? (
                  <div className="notice" style={{ marginTop: 10 }}>
                    Matrix floor applied from {displayedResult.flaws.limitingFlaws.map((item) => `${item.category} ${item.severity}`).join(', ')}.
                  </div>
                ) : null}

                <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>Could change with better evidence</h3>
                <div className="small">
                  {displayedResult.report?.topChangeDrivers?.length
                    ? displayedResult.report?.topChangeDrivers?.join(' | ')
                    : 'No additional change drivers were recorded.'}
                </div>
              </>
            ) : (
              <>
                <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>Estimate</h3>
                <div className="small">
                  The final grade, flaw summary, and overlay will appear here after you click Estimate grade.
                </div>
              </>
            )}

            <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>Assumptions and limitations</h3>
            <div className="small">
              {displayedResult?.report?.limitations?.length
                ? displayedResult.report?.limitations?.join(' | ')
                : 'This is a photo-based heuristic grader. It can miss micro-scratches, print texture issues, gloss loss, and very subtle corner wear. Heavy glare, blur, or non-uniform lighting can cause false positives.'}
            </div>
          </>
        )}
      </section>
    </div>
    {resultModal ? (
      <EstimateEvidenceModal
        payload={resultModal}
        onClose={() => setResultModal(null)}
      />
    ) : null}
    </>
  );
}

function applyManualCenteringOverride(result: GradeResult, manualCentering: ManualCenteringView | null | undefined): GradeResult {
  if (!manualCentering || !result.centering || !result.flaws || result.final.unscorable) {
    return result;
  }

  const confidenceCap = result.report?.confidenceGradeCeiling.cap ?? { gradeLabel: 'GEM-MT 10' as const, psaNumeric: 10 };
  const centeringAndFlawCap = finalGradeFromCaps(manualCentering.gradeCap, result.flaws.gradeCap);
  const finalCap = finalGradeFromCaps(centeringAndFlawCap, confidenceCap);
  const updatedTopReasons = [
    `${manualCentering.gradeCap.gradeLabel}: Manual centering override uses ${manualCentering.worst.axis} ${manualCentering.worst.ratio}.`,
    result.report?.visibleDefectGradeCeiling.reason,
    result.report?.confidenceGradeCeiling.reason
  ].filter((value): value is string => !!value);

  return {
    ...result,
    centering: manualCentering,
    final: {
      ...result.final,
      gradeLabel: finalCap.gradeLabel,
      psaNumeric: finalCap.psaNumeric
    },
    report: result.report ? {
      ...result.report,
      frontCenteringLR: manualCentering.lr.ratio,
      frontCenteringTB: manualCentering.tb.ratio,
      effectiveFrontCentering: manualCentering.worst.ratio,
      centeringGradeCeiling: {
        source: 'centering',
        cap: manualCentering.gradeCap,
        reason: `${manualCentering.gradeCap.gradeLabel}: Manual centering override uses ${manualCentering.worst.axis} ${manualCentering.worst.ratio}.`
      },
      finalGradeLabel: finalCap.gradeLabel,
      finalGradeNumeric: finalCap.psaNumeric,
      topReasons: updatedTopReasons
    } : result.report,
    debug: {
      ...(result.debug ?? {}),
      manualCenteringApplied: true,
      manualCentering: {
        lr: manualCentering.lr,
        tb: manualCentering.tb,
        worst: manualCentering.worst,
        gradeCap: manualCentering.gradeCap,
        mm: manualCentering.mm,
        border: manualCentering.debug.border,
        cardRect: manualCentering.debug.cardRect,
        innerRect: manualCentering.debug.innerRect
      }
    }
  };
}

function hasResult(row: Row): row is Row & { result: GradeResult } {
  return Boolean(row.result);
}

function toManualGuideOverride(manualCentering: ManualCenteringView | null | undefined): ManualGuideOverride | null {
  if (!manualCentering) return null;
  const sourceSize = manualCentering.debug?.rectifiedSize;
  const cardRect = manualCentering.debug?.cardRect;
  const innerRect = manualCentering.debug?.innerRect;
  if (!sourceSize || !cardRect || !innerRect) return null;
  if (sourceSize.w <= 2 || sourceSize.h <= 2) return null;
  if (cardRect.w <= 1 || cardRect.h <= 1 || innerRect.w <= 1 || innerRect.h <= 1) return null;

  return {
    sourceSize: { w: sourceSize.w, h: sourceSize.h },
    cardRect: { x: cardRect.x, y: cardRect.y, w: cardRect.w, h: cardRect.h },
    innerRect: { x: innerRect.x, y: innerRect.y, w: innerRect.w, h: innerRect.h }
  };
}

function revokeObjectUrlSafe(url?: string): void {
  if (!url) return;
  URL.revokeObjectURL(url);
}

function revokeRowObjectUrls(row: Row): void {
  revokeObjectUrlSafe(row.overlayObjectURL);
  revokeObjectUrlSafe(row.rectifiedObjectURL);
  revokeObjectUrlSafe(row.sourceObjectURL);
}

function EstimateEvidenceModal({
  payload,
  onClose
}: {
  payload: ResultModalPayload;
  onClose: () => void;
}) {
  const result = payload.result;
  const centering = result.centering ?? null;
  const mm = deriveCenteringMillimeters(centering);
  const report = result.report;
  const flaws = result.flaws;
  const [isRawReportOpen, setIsRawReportOpen] = useState(false);
  const [isRawDebugOpen, setIsRawDebugOpen] = useState(false);
  const overlaySrc = payload.overlayObjectURL ?? payload.rectifiedObjectURL ?? payload.sourceObjectURL;
  const reportJson = useMemo(
    () => (isRawReportOpen ? JSON.stringify(report ?? null, null, 2) : ''),
    [isRawReportOpen, report]
  );
  const debugJson = useMemo(
    () => (isRawDebugOpen ? JSON.stringify(result.debug ?? null, null, 2) : ''),
    [isRawDebugOpen, result.debug]
  );
  const methodology = [
    'Outer card bounds are detected from color/profile evidence and normalized to a standard card aspect.',
    'Inner frame boundaries are detected from border-to-design transitions to compute centering.',
    'Visible condition findings are measured from border, edge, corner, and interior anomaly signals on the detected card region.',
    'Final estimate uses conservative grade ceilings from centering, visible defects, and image observability.'
  ];

  return (
    <div className="resultModalBackdrop" onClick={onClose}>
      <section
        className="resultModal"
        role="dialog"
        aria-modal="true"
        aria-label="Grade estimation evidence"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="resultModalHeader">
          <div>
            <div className="resultModalTitle">Estimation Completed</div>
            <div className="small">{payload.filename}</div>
            <div className="small">Generated {new Date(payload.openedAtMs).toLocaleString()}</div>
          </div>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </header>

        <div className="resultModalBody">
          <div className="resultModalImageGrid">
            <figure className="resultModalFigure">
              <figcaption>Detection + centering evidence overlay</figcaption>
              <img src={overlaySrc} alt={`${payload.filename} evidence overlay`} loading="lazy" decoding="async" />
            </figure>
            {payload.rectifiedObjectURL ? (
              <figure className="resultModalFigure">
                <figcaption>Rectified analysis image (exact image used for calculations)</figcaption>
                <img src={payload.rectifiedObjectURL} alt={`${payload.filename} rectified analysis`} loading="lazy" decoding="async" />
              </figure>
            ) : null}
          </div>

          <section className="resultModalSection">
            <h3>Final Result</h3>
            <div className="kv"><div className="small">Final grade</div><div>{result.final.gradeLabel} (PSA {result.final.psaNumeric})</div></div>
            <div className="kv"><div className="small">Confidence</div><div>{result.final.confidence.toFixed(2)}</div></div>
            <div className="kv"><div className="small">Confidence band</div><div>{report?.confidenceBand ?? '-'}</div></div>
            <div className="kv"><div className="small">Manual review required</div><div>{report?.manualReviewRequired ? 'YES' : 'NO'}</div></div>
            <div className="kv"><div className="small">Unscorable</div><div>{result.final.unscorable ? 'YES' : 'NO'}</div></div>
            {result.final.unscorableReasons?.length ? (
              <div className="small">Reasons: {result.final.unscorableReasons.map((reason) => `${reason.code}: ${reason.message}`).join(' | ')}</div>
            ) : null}
          </section>

          <section className="resultModalSection">
            <h3>Centering Evidence + Calculations</h3>
            <div className="kv"><div className="small">Left / Right ratio</div><div>{centering?.lr?.ratio ?? '-'}</div></div>
            <div className="kv"><div className="small">Top / Bottom ratio</div><div>{centering?.tb?.ratio ?? '-'}</div></div>
            <div className="kv"><div className="small">Worst axis used</div><div>{centering?.worst?.axis ?? '-'} {centering?.worst?.ratio ?? ''}</div></div>
            <div className="kv"><div className="small">Centering cap</div><div>{centering?.gradeCap?.gradeLabel ?? '-'}</div></div>
            <div className="kv"><div className="small">Border px (L/R)</div><div>{centering ? `${centering.debug.border.leftPx} / ${centering.debug.border.rightPx}` : '-'}</div></div>
            <div className="kv"><div className="small">Border px (T/B)</div><div>{centering ? `${centering.debug.border.topPx} / ${centering.debug.border.bottomPx}` : '-'}</div></div>
            <div className="kv"><div className="small">Border % (L/R)</div><div>{centering ? `${centering.debug.border.leftPct.toFixed(1)}% / ${centering.debug.border.rightPct.toFixed(1)}%` : '-'}</div></div>
            <div className="kv"><div className="small">Border % (T/B)</div><div>{centering ? `${centering.debug.border.topPct.toFixed(1)}% / ${centering.debug.border.bottomPct.toFixed(1)}%` : '-'}</div></div>
            <div className="kv"><div className="small">Estimated mm (L/R)</div><div>{mm ? `${mm.left.toFixed(2)}mm / ${mm.right.toFixed(2)}mm` : '-'}</div></div>
            <div className="kv"><div className="small">Estimated mm (T/B)</div><div>{mm ? `${mm.top.toFixed(2)}mm / ${mm.bottom.toFixed(2)}mm` : '-'}</div></div>
            <div className="kv"><div className="small">Card rect (x,y,w,h)</div><div>{centering ? `${centering.debug.cardRect.x}, ${centering.debug.cardRect.y}, ${centering.debug.cardRect.w}, ${centering.debug.cardRect.h}` : '-'}</div></div>
            <div className="kv"><div className="small">Inner rect (x,y,w,h)</div><div>{centering ? `${centering.debug.innerRect.x}, ${centering.debug.innerRect.y}, ${centering.debug.innerRect.w}, ${centering.debug.innerRect.h}` : '-'}</div></div>
          </section>

          <section className="resultModalSection">
            <h3>Detection Findings</h3>
            {report?.detectedDefects?.length ? (
              <ul className="resultModalList">
                {report.detectedDefects.map((item) => (
                  <li key={item.id}>
                    <b>{item.flawType}</b> ({item.severity}) at {item.location}; evidence {item.evidenceStrength}
                    {item.measurement ? `, ${item.measurement.display}` : ''}
                    {item.region ? `, region x=${item.region.x}, y=${item.region.y}, w=${item.region.w}, h=${item.region.h}` : ''}
                    {` - ${item.metric}`}
                  </li>
                ))}
              </ul>
            ) : flaws?.items?.length ? (
              <ul className="resultModalList">
                {flaws.items.map((item, index) => (
                  <li key={index}>
                    <b>{item.category}</b>: {item.severity} ({item.points} pts) - {item.metric}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="small">No flaws detected above thresholds.</div>
            )}
            {flaws?.limitingFlaws?.length ? (
              <div className="notice">
                Matrix floor applied from {flaws.limitingFlaws.map((item) => `${item.category} ${item.severity}`).join(', ')}.
              </div>
            ) : null}
          </section>

          <section className="resultModalSection">
            <h3>Image Quality + Observability</h3>
            <div className="kv"><div className="small">Card detected</div><div>{report?.cardDetected ? 'YES' : 'NO'}</div></div>
            <div className="kv"><div className="small">Full front visible</div><div>{report?.fullFrontVisible ? 'YES' : 'NO'}</div></div>
            <div className="kv"><div className="small">Quality score</div><div>{report ? report.imageQuality.imageQualityScore.toFixed(3) : '-'}</div></div>
            <div className="kv"><div className="small">Centering ceiling</div><div>{report?.centeringGradeCeiling.cap.gradeLabel ?? '-'}</div></div>
            <div className="kv"><div className="small">Visible-defect ceiling</div><div>{report?.visibleDefectGradeCeiling.cap.gradeLabel ?? '-'}</div></div>
            <div className="kv"><div className="small">Confidence ceiling</div><div>{report?.confidenceGradeCeiling.cap.gradeLabel ?? '-'}</div></div>
            <div className="small">Centering reason: {report?.centeringGradeCeiling.reason ?? '-'}</div>
            <div className="small">Visible-defect reason: {report?.visibleDefectGradeCeiling.reason ?? '-'}</div>
            <div className="small">Confidence reason: {report?.confidenceGradeCeiling.reason ?? '-'}</div>
            <div className="small" style={{ marginTop: 8 }}>
              {report?.imageQuality.checks?.length ? (
                report.imageQuality.checks.map((check) => `${check.label}: ${check.severity.toUpperCase()}${check.metric ? ` (${check.metric})` : ''} - ${check.note}`).join(' | ')
              ) : 'No image quality checks available.'}
            </div>
          </section>

          <section className="resultModalSection">
            <h3>Methodology + Notes</h3>
            <ul className="resultModalList">
              {methodology.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
            <div className="small">Top reasons: {report?.topReasons?.length ? report.topReasons.join(' | ') : '-'}</div>
            <div className="small">Top change drivers: {report?.topChangeDrivers?.length ? report.topChangeDrivers.join(' | ') : '-'}</div>
            <div className="small">Assumptions: {report?.assumptions?.length ? report.assumptions.join(' | ') : '-'}</div>
            <div className="small">Limitations: {report?.limitations?.length ? report.limitations.join(' | ') : '-'}</div>
          </section>

          <section className="resultModalSection">
            <details onToggle={(event) => setIsRawReportOpen(event.currentTarget.open)}>
              <summary>Raw report JSON</summary>
              {isRawReportOpen ? (
                <pre className="resultModalPre">{reportJson}</pre>
              ) : (
                <div className="small">Expand to render raw JSON.</div>
              )}
            </details>
            <details onToggle={(event) => setIsRawDebugOpen(event.currentTarget.open)}>
              <summary>Raw debug JSON</summary>
              {isRawDebugOpen ? (
                <pre className="resultModalPre">{debugJson}</pre>
              ) : (
                <div className="small">Expand to render raw JSON.</div>
              )}
            </details>
          </section>
        </div>
      </section>
    </div>
  );
}

function sameCentering(
  baseCentering: GradeResult['centering'] | null | undefined,
  manualCentering: ManualCenteringView | null | undefined
): boolean {
  if (!baseCentering && !manualCentering) return true;
  if (!baseCentering || !manualCentering) return false;

  return (
    Math.round(baseCentering.debug.border.leftPx) === Math.round(manualCentering.debug.border.leftPx)
    && Math.round(baseCentering.debug.border.rightPx) === Math.round(manualCentering.debug.border.rightPx)
    && Math.round(baseCentering.debug.border.topPx) === Math.round(manualCentering.debug.border.topPx)
    && Math.round(baseCentering.debug.border.bottomPx) === Math.round(manualCentering.debug.border.bottomPx)
    && Math.round(baseCentering.debug.cardRect.x) === Math.round(manualCentering.debug.cardRect.x)
    && Math.round(baseCentering.debug.cardRect.y) === Math.round(manualCentering.debug.cardRect.y)
    && Math.round(baseCentering.debug.cardRect.w) === Math.round(manualCentering.debug.cardRect.w)
    && Math.round(baseCentering.debug.cardRect.h) === Math.round(manualCentering.debug.cardRect.h)
    && Math.round(baseCentering.debug.innerRect.x) === Math.round(manualCentering.debug.innerRect.x)
    && Math.round(baseCentering.debug.innerRect.y) === Math.round(manualCentering.debug.innerRect.y)
    && Math.round(baseCentering.debug.innerRect.w) === Math.round(manualCentering.debug.innerRect.w)
    && Math.round(baseCentering.debug.innerRect.h) === Math.round(manualCentering.debug.innerRect.h)
  );
}

function deriveCenteringMillimeters(centering: ManualCenteringView | GradeResult['centering'] | null) {
  if (!centering) return null;
  if ('mm' in centering) return centering.mm;

  const cardWidthPx = Math.max(1, centering.debug.cardRect.w);
  const cardHeightPx = Math.max(1, centering.debug.cardRect.h);
  return {
    left: (centering.debug.border.leftPx / cardWidthPx) * 64,
    right: (centering.debug.border.rightPx / cardWidthPx) * 64,
    top: (centering.debug.border.topPx / cardHeightPx) * 89,
    bottom: (centering.debug.border.bottomPx / cardHeightPx) * 89
  };
}
