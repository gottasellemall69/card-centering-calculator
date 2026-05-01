export type AIReviewConfidence = 'low' | 'medium' | 'high';

export type AIReviewAgreement = 'agree' | 'minor_disagreement' | 'major_disagreement' | 'unable_to_review';

export type AIReviewSeverity = 'none' | 'slight' | 'minor' | 'moderate' | 'major';

export type AIVisualFinding = {
  category: 'corners' | 'edges' | 'surface' | 'shape' | 'quality' | 'other';
  flawType: string;
  location: string;
  severity: AIReviewSeverity;
  confidence: AIReviewConfidence;
  evidence: string;
  suggestedAction: string;
};

export type AIReviewResult = {
  model: string;
  aiReviewVersion: string;
  overallAgreement: AIReviewAgreement;
  confidence: AIReviewConfidence;
  confidenceScore: number;
  manualReviewRequired: boolean;
  graderRemarks: {
    overallAssessment: string;
    gradeRationale: string;
    keyFindings: string;
    finalRecommendation: string;
  };
  recommendedFinalGrade: {
    gradeLabel: string;
    psaNumeric: number;
    reason: string;
  };
  gradeAdjustment: {
    shouldAdjust: boolean;
    fromNumeric: number;
    toNumeric: number;
    reason: string;
  };
  centeringReview: {
    agreesWithMeasurement: boolean;
    confidence: AIReviewConfidence;
    suspectedIssue: string;
    notes: string[];
  };
  defectReview: {
    missedDefects: AIVisualFinding[];
    possibleFalsePositives: AIVisualFinding[];
    severitySummary: string;
  };
  qualityReview: {
    usableForAiReview: boolean;
    issues: string[];
    note: string;
  };
  topReasons: string[];
  limitations: string[];
};

const visualFindingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'flawType', 'location', 'severity', 'confidence', 'evidence', 'suggestedAction'],
  properties: {
    category: {
      type: 'string',
      enum: ['corners', 'edges', 'surface', 'shape', 'quality', 'other']
    },
    flawType: { type: 'string' },
    location: { type: 'string' },
    severity: {
      type: 'string',
      enum: ['none', 'slight', 'minor', 'moderate', 'major']
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high']
    },
    evidence: { type: 'string' },
    suggestedAction: { type: 'string' }
  }
} as const;

export const AI_REVIEW_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'model',
    'aiReviewVersion',
    'overallAgreement',
    'confidence',
    'confidenceScore',
    'manualReviewRequired',
    'graderRemarks',
    'recommendedFinalGrade',
    'gradeAdjustment',
    'centeringReview',
    'defectReview',
    'qualityReview',
    'topReasons',
    'limitations'
  ],
  properties: {
    model: { type: 'string' },
    aiReviewVersion: { type: 'string' },
    overallAgreement: {
      type: 'string',
      enum: ['agree', 'minor_disagreement', 'major_disagreement', 'unable_to_review']
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high']
    },
    confidenceScore: {
      type: 'number'
    },
    manualReviewRequired: { type: 'boolean' },
    graderRemarks: {
      type: 'object',
      additionalProperties: false,
      required: ['overallAssessment', 'gradeRationale', 'keyFindings', 'finalRecommendation'],
      properties: {
        overallAssessment: { type: 'string' },
        gradeRationale: { type: 'string' },
        keyFindings: { type: 'string' },
        finalRecommendation: { type: 'string' }
      }
    },
    recommendedFinalGrade: {
      type: 'object',
      additionalProperties: false,
      required: ['gradeLabel', 'psaNumeric', 'reason'],
      properties: {
        gradeLabel: { type: 'string' },
        psaNumeric: { type: 'number' },
        reason: { type: 'string' }
      }
    },
    gradeAdjustment: {
      type: 'object',
      additionalProperties: false,
      required: ['shouldAdjust', 'fromNumeric', 'toNumeric', 'reason'],
      properties: {
        shouldAdjust: { type: 'boolean' },
        fromNumeric: { type: 'number' },
        toNumeric: { type: 'number' },
        reason: { type: 'string' }
      }
    },
    centeringReview: {
      type: 'object',
      additionalProperties: false,
      required: ['agreesWithMeasurement', 'confidence', 'suspectedIssue', 'notes'],
      properties: {
        agreesWithMeasurement: { type: 'boolean' },
        confidence: {
          type: 'string',
          enum: ['low', 'medium', 'high']
        },
        suspectedIssue: { type: 'string' },
        notes: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    },
    defectReview: {
      type: 'object',
      additionalProperties: false,
      required: ['missedDefects', 'possibleFalsePositives', 'severitySummary'],
      properties: {
        missedDefects: {
          type: 'array',
          items: visualFindingSchema
        },
        possibleFalsePositives: {
          type: 'array',
          items: visualFindingSchema
        },
        severitySummary: { type: 'string' }
      }
    },
    qualityReview: {
      type: 'object',
      additionalProperties: false,
      required: ['usableForAiReview', 'issues', 'note'],
      properties: {
        usableForAiReview: { type: 'boolean' },
        issues: {
          type: 'array',
          items: { type: 'string' }
        },
        note: { type: 'string' }
      }
    },
    topReasons: {
      type: 'array',
      items: { type: 'string' }
    },
    limitations: {
      type: 'array',
      items: { type: 'string' }
    }
  }
} as const;

export function isAIReviewResult(value: unknown): value is AIReviewResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AIReviewResult>;
  const recommendedNumeric = candidate.recommendedFinalGrade?.psaNumeric;
  const fromNumeric = candidate.gradeAdjustment?.fromNumeric;
  const toNumeric = candidate.gradeAdjustment?.toNumeric;
  return (
    typeof candidate.model === 'string'
    && typeof candidate.aiReviewVersion === 'string'
    && typeof candidate.overallAgreement === 'string'
    && typeof candidate.confidence === 'string'
    && typeof candidate.confidenceScore === 'number'
    && candidate.confidenceScore >= 0
    && candidate.confidenceScore <= 1
    && typeof candidate.manualReviewRequired === 'boolean'
    && !!candidate.graderRemarks
    && typeof candidate.graderRemarks.overallAssessment === 'string'
    && typeof candidate.graderRemarks.gradeRationale === 'string'
    && typeof candidate.graderRemarks.keyFindings === 'string'
    && typeof candidate.graderRemarks.finalRecommendation === 'string'
    && !!candidate.recommendedFinalGrade
    && typeof recommendedNumeric === 'number'
    && recommendedNumeric >= 0
    && recommendedNumeric <= 10
    && !!candidate.gradeAdjustment
    && typeof fromNumeric === 'number'
    && fromNumeric >= 0
    && fromNumeric <= 10
    && typeof toNumeric === 'number'
    && toNumeric >= 0
    && toNumeric <= 10
    && !!candidate.centeringReview
    && !!candidate.defectReview
    && !!candidate.qualityReview
    && Array.isArray(candidate.topReasons)
    && Array.isArray(candidate.limitations)
  );
}
