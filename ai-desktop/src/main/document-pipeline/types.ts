/** Document Pipeline types */

// Document metadata
export interface DocumentMeta {
  id: string;
  fileName: string;
  filePath: string;
  fileType: 'pdf' | 'word' | 'ppt' | 'excel' | 'csv' | 'markdown' | 'txt' | 'image';
  fileSize: number;
  pageCount?: number;
  uploadTime: number;
  parseStatus: 'pending' | 'parsing' | 'completed' | 'failed';
  parseError?: string;
  parseLog?: string[];
  // Parsed content
  sections?: DocumentSection[];
  tables?: ParsedTable[];
  images?: ParsedImage[];
  // Wiki metadata
  wikiCard?: WikiCard;
}

export interface DocumentSection {
  id: string;
  title: string;
  level: number;
  content: string;
  pageStart: number;
  pageEnd: number;
  parentId?: string;
  childrenIds?: string[];
}

export interface ParsedTable {
  id: string;
  page: number;
  caption?: string;
  // Structured representation
  headers: TableHeader[];
  rows: string[][];
  // Cell metadata
  mergedCells: MergedCell[];
  // Serialized forms
  markdown: string;
  html: string;
  csv: string;
  // Position
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface TableHeader {
  text: string;
  level: number; // 0 = top-level, 1 = sub-header
  colSpan: number;
  rowSpan: number;
}

export interface MergedCell {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface ParsedImage {
  id: string;
  page: number;
  caption?: string;
  ocrText?: string;
  ocrConfidence?: number;
  bbox?: { x: number; y: number; width: number; height: number };
  base64?: string;
}

// Vector store types
export interface Chunk {
  id: string;
  documentId: string;
  chunkType: 'text' | 'table' | 'image';
  content: string;
  embedding?: number[];
  metadata: {
    fileName: string;
    pageNumber?: number;
    sectionTitle?: string;
    tableId?: string;
    imageId?: string;
    cellRange?: string;
    chunkIndex: number;
    tokenCount: number;
  };
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
  // Evidence location
  evidence: {
    fileName: string;
    pageNumber?: number;
    sectionTitle?: string;
    tableId?: string;
    cellRange?: string;
    contentType: string;
  };
}

export interface QAAnswer {
  question: string;
  answer: string;
  evidence: EvidenceItem[];
  confidence: number;
  modelUsed: string;
  tokensUsed: { input: number; output: number };
}

export interface EvidenceItem {
  type: 'text' | 'table' | 'image';
  fileName: string;
  pageNumber?: number;
  sectionTitle?: string;
  tableId?: string;
  cellRange?: string;
  imageId?: string;
  excerpt: string;
}

// LLM Wiki types
export interface WikiCard {
  title: string;
  summary: string;
  keyConcepts: WikiConcept[];
  structure: WikiSection[];
  crossRefs: CrossDocRef[];
}

export interface WikiConcept {
  name: string;
  description: string;
  relatedChunks: string[]; // chunk IDs
}

export interface WikiSection {
  title: string;
  level: number;
  summary: string;
  pageRange: [number, number];
  keyPoints: string[];
}

export interface CrossDocRef {
  targetDocId: string;
  targetFileName: string;
  relation: string;
  description: string;
}

// Math modeling C problem specific
export interface CProblemParsed {
  title: string;
  background: string;
  problems: CProblem[];
  attachments: CAttachment[];
  dataFields: CDataField[];
  constraints: string[];
  evaluationMetrics: string[];
  submissionFormat: string;
  paperRequirements: string;
}

export interface CProblem {
  index: number;
  description: string;
  target: string;
  dataMapping: string[];
  solutionHint?: string;
}

export interface CAttachment {
  fileName: string;
  fileType: 'csv' | 'xlsx' | 'txt' | 'other';
  description: string;
  fields?: CDataField[];
}

export interface CDataField {
  name: string;
  type: 'numeric' | 'categorical' | 'datetime' | 'text';
  unit?: string;
  missingRate: number;
  description: string;
  stats?: {
    min?: number;
    max?: number;
    mean?: number;
    std?: number;
    uniqueValues?: number;
  };
}

// Evaluation types
export interface DocumentEvalResult {
  testName: string;
  parseSuccessRate: number;
  recallAtK: { k: number; recall: number }[];
  mrr: number;
  evidenceHitRate: number;
  qaAccuracy: number;
  tableRecognition: {
    rowAccuracy: number;
    colAccuracy: number;
    mergeAccuracy: number;
    headerAccuracy: number;
  };
  performance: {
    avgParseTime: number;
    avgIndexTime: number;
    avgQueryLatency: number;
    totalTokens: number;
  };
}

export interface SkillEvalResult {
  skillName: string;
  triggerAccuracy: number;
  generationSuccessRate: number;
  validationPassRate: number;
  tokenSaved: number; // compared to no-skill approach
  qualityScores: {
    structureCompleteness: number;
    contentAccuracy: number;
    formatCorrectness: number;
    reproducibility: number;
  };
  failureAnalysis: string;
}

export interface CProblemEvalResult {
  parseAccuracy: number;
  dataReadSuccessRate: number;
  codeFirstRunSuccess: boolean;
  chartCount: number;
  chartCorrectRate: number;
  latexCompileSuccess: boolean;
  paperStructureScore: number;
  reproducibilityScore: number;
  humanRating: number;
  failureAnalysis: string;
}
