import type { GradeResult } from '@/lib/grader';

export type FlatGradeRow = {
  image_name: string;
  card_detected: 'YES' | 'NO';
  full_front_visible: 'YES' | 'NO';
  image_quality_score: string;
  front_centering_lr: string;
  front_centering_tb: string;
  effective_front_centering: string;
  defect_points_total: string;
  centering_grade_ceiling: string;
  visible_defect_grade_ceiling: string;
  confidence_grade_ceiling: string;
  final_grade_label: string;
  final_grade_numeric: string;
  confidence: string;
  confidence_band: string;
  manual_review_required: 'YES' | 'NO';
  corner_findings: string;
  edge_findings: string;
  surface_findings: string;
  top_reasons: string;
  limitations: string;
};

export function flattenGradeResult(filename: string, result: GradeResult): FlatGradeRow {
  const report = result.report;
  const joinFindings = (items: Array<{ flawType: string; severity: string; location: string }> | undefined) =>
    items?.map((item) => `${item.flawType}:${item.severity}@${item.location}`)?.join(' | ') ?? '';

  return {
    image_name: filename,
    card_detected: report?.cardDetected ? 'YES' : 'NO',
    full_front_visible: report?.fullFrontVisible ? 'YES' : 'NO',
    image_quality_score: report ? report.imageQuality.imageQualityScore.toFixed(3) : '',
    front_centering_lr: report?.frontCenteringLR ?? result.centering?.lr.ratio ?? '',
    front_centering_tb: report?.frontCenteringTB ?? result.centering?.tb.ratio ?? '',
    effective_front_centering: report?.effectiveFrontCentering ?? result.centering?.worst.ratio ?? '',
    defect_points_total: String(report?.defectPointsTotal ?? result.flaws?.effectivePoints ?? result.flaws?.totalPoints ?? ''),
    centering_grade_ceiling: report?.centeringGradeCeiling.cap.gradeLabel ?? result.centering?.gradeCap.gradeLabel ?? '',
    visible_defect_grade_ceiling: report?.visibleDefectGradeCeiling.cap.gradeLabel ?? result.flaws?.gradeCap.gradeLabel ?? '',
    confidence_grade_ceiling: report?.confidenceGradeCeiling.cap.gradeLabel ?? '',
    final_grade_label: result.final.gradeLabel,
    final_grade_numeric: String(result.final.psaNumeric),
    confidence: result.final.confidence.toFixed(3),
    confidence_band: report?.confidenceBand ?? '',
    manual_review_required: report?.manualReviewRequired ? 'YES' : 'NO',
    corner_findings: joinFindings(report?.cornerFindings),
    edge_findings: joinFindings(report?.edgeFindings),
    surface_findings: joinFindings(report?.surfaceFindings),
    top_reasons: report?.topReasons?.join(' | ') ?? '',
    limitations: report?.limitations?.join(' | ') ?? ''
  };
}

export function serializeGradeRowsToCsv(rows: FlatGradeRow[]): string {
  if (!rows.length) {
    return '';
  }

  const headers = Object.keys(rows[0]) as Array<keyof FlatGradeRow>;
  const csvLines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))
  ];
  return csvLines.join('\n');
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
