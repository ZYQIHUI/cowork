/**
 * Document Parser — multi-format parsing via pandoc, Python helpers, and OCR.
 *
 * Formats supported:
 *   docx/pptx → pandoc → markdown
 *   pdf       → Python (pdfplumber / pymupdf) → sections + tables + images
 *   xlsx/csv  → Python (pandas) → markdown tables per sheet
 *   images    → Python (pytesseract / paddleocr) → OCR text
 *
 * Fallback: when Python 3 is not available on PATH, everything goes through
 * pandoc (or is skipped with a status message).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logError } from '../utils/logger';
import type {
  DocumentMeta,
  DocumentSection,
  ParsedTable,
  ParsedImage,
  TableHeader,
} from './types';

// ── Python detection ──

let pythonAvailable: boolean | null = null;

function isPythonAvailable(): boolean {
  if (pythonAvailable !== null) return pythonAvailable;
  const result = spawnSync('python3', ['--version'], {
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status === 0) {
    pythonAvailable = true;
    return true;
  }
  const result2 = spawnSync('python', ['--version'], {
    timeout: 5000,
    windowsHide: true,
  });
  pythonAvailable = result2.status === 0;
  return pythonAvailable;
}

// ── Pandoc detection ──

let pandocAvailable: boolean | null = null;

function isPandocAvailable(): boolean {
  if (pandocAvailable !== null) return pandocAvailable;
  const result = spawnSync('pandoc', ['--version'], {
    timeout: 5000,
    windowsHide: true,
  });
  pandocAvailable = result.status === 0;
  return pandocAvailable;
}

// ── Helpers ──

function runPandoc(inputPath: string, fromFormat: string): string {
  const result = spawnSync(
    'pandoc',
    [inputPath, '-f', fromFormat, '-t', 'markdown', '--wrap=none'],
    { timeout: 60000, encoding: 'utf-8', windowsHide: true },
  );
  if (result.error) throw new Error(`pandoc error: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`pandoc exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Write a multi-line Python script to a temporary file and execute it.
 * This avoids shell-quoting nightmares with inline scripts.
 */
function runPythonScriptFile(
  script: string,
  args: string[],
  store: { appendLog: (id: string, msg: string) => void },
  docId: string,
): string | null {
  if (!isPythonAvailable()) return null;

  const tmpDir = path.join(
    process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
    'ai-desktop-parser',
  );
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const scriptPath = path.join(tmpDir, `parse_${randomUUID().slice(0, 8)}.py`);
  fs.writeFileSync(scriptPath, script, 'utf-8');

  try {
    const cmd = process.platform === 'win32' ? 'python' : 'python3';
    store.appendLog(docId, `Running Python: ${cmd} ${scriptPath} ${args.join(' ')}`);
    const result = spawnSync(cmd, [scriptPath, ...args], {
      timeout: 300000,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      logError(`[DocumentParser] Python error: ${result.error ?? result.stderr}`);
      return null;
    }
    return result.stdout.trim();
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

// ── PDF Python script ──

const PDF_PARSE_SCRIPT = `
import sys, json
USE_PDFPLUMBER = False
USE_PYMUPDF = False
USE_PYPDF = False
try:
    import pdfplumber
    USE_PDFPLUMBER = True
except ImportError:
    try:
        import fitz  # PyMuPDF
        USE_PYMUPDF = True
    except ImportError:
        try:
            from pypdf import PdfReader
            USE_PYPDF = True
        except ImportError:
            print(json.dumps({"error": "No PDF library available (install pdfplumber, PyMuPDF, or pypdf)"}))
            sys.exit(1)

def parse_with_pdfplumber(filepath):
    sections = []
    tables = []
    images = []
    with pdfplumber.open(filepath) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            # Split into paragraphs
            paragraphs = [p.strip() for p in text.split('\\n\\n') if p.strip()]
            for para in paragraphs:
                lines = para.split('\\n')
                if len(lines) == 1 and lines[0].strip():
                    # Could be a section title (simple heuristic)
                    sec_id = f"sec-{len(sections)}"
                    sections.append({
                        "id": sec_id,
                        "title": lines[0].strip(),
                        "level": 1,
                        "content": "",
                        "pageStart": page_num,
                        "pageEnd": page_num,
                    })
                else:
                    if sections:
                        sections[-1]["content"] += para + "\\n\\n"
                    else:
                        sections.append({
                            "id": "sec-0",
                            "title": "Untitled",
                            "level": 1,
                            "content": para,
                            "pageStart": page_num,
                            "pageEnd": page_num,
                        })

            # Find tables
            page_tables = page.find_tables()
            for t_idx, t in enumerate(page_tables):
                data = t.extract()
                if not data or len(data) < 1:
                    continue
                headers_raw = data[0] if data else []
                headers = [{"text": str(h) if h else "", "level": 0, "colSpan": 1, "rowSpan": 1} for h in headers_raw]
                rows = [[str(c) if c is not None else "" for c in row] for row in data[1:]]
                # Build markdown repr
                md_lines = []
                if headers_raw:
                    md_lines.append("| " + " | ".join(str(h) for h in headers_raw) + " |")
                    md_lines.append("|" + " | ".join(["---"] * len(headers_raw)) + "|")
                for row in rows:
                    md_lines.append("| " + " | ".join(row) + " |")
                tables.append({
                    "id": f"table-p{page_num}-{t_idx}",
                    "page": page_num,
                    "headers": headers,
                    "rows": rows,
                    "markdown": "\\n".join(md_lines),
                    "html": "",
                    "csv": "\\n".join(",".join(str(h) for h in headers_raw) for headers_raw in [[str(h) for h in headers_raw]] + rows),
                    "mergedCells": [],
                    "bbox": {"x": t.bbox[0], "y": t.bbox[1], "width": t.bbox[2]-t.bbox[0], "height": t.bbox[3]-t.bbox[1]} if t.bbox else None,
                })

            # Image regions
            for img_idx, img in enumerate(getattr(page, 'images', [])):
                images.append({
                    "id": f"img-p{page_num}-{img_idx}",
                    "page": page_num,
                    "bbox": {"x": img.get("x0", 0), "y": img.get("top", 0), "width": img.get("width", 0), "height": img.get("height", 0)},
                })

    return {
        "sections": sections,
        "tables": tables,
        "images": images,
        "pageCount": len(pdf.pages) if hasattr(pdf, 'pages') else 0,
    }

def parse_with_pymupdf(filepath):
    doc = fitz.open(filepath)
    sections = []
    images_out = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")
        paragraphs = [p.strip() for p in text.split('\\n\\n') if p.strip()]
        for para in paragraphs:
            if not para:
                continue
            lines = para.split('\\n')
            if len(lines) == 1 and len(lines[0]) < 120 and not lines[0].endswith('.'):
                sec_id = f"sec-{len(sections)}"
                sections.append({
                    "id": sec_id, "title": lines[0].strip(), "level": 1,
                    "content": "", "pageStart": page_num + 1, "pageEnd": page_num + 1,
                })
            else:
                if sections:
                    sections[-1]["content"] += para + "\\n\\n"
                else:
                    sections.append({
                        "id": "sec-0", "title": "Untitled", "level": 1,
                        "content": para, "pageStart": page_num + 1, "pageEnd": page_num + 1,
                    })
        # Extract images
        for img_info in page.get_image_info():
            images_out.append({
                "id": f"img-p{page_num+1}-{len(images_out)}",
                "page": page_num + 1,
                "bbox": {"x": img_info["bbox"][0], "y": img_info["bbox"][1], "width": img_info["bbox"][2]-img_info["bbox"][0], "height": img_info["bbox"][3]-img_info["bbox"][1]},
            })
    doc.close()
    return {"sections": sections, "tables": [], "images": images_out, "pageCount": len(doc)}

def parse_with_pypdf(filepath):
    from pypdf import PdfReader
    reader = PdfReader(filepath)
    page_count = len(reader.pages)
    full_text = ""
    for page_num, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        full_text += text + "\\n\\n"
    sections = []
    paragraphs = [p.strip() for p in full_text.split('\\n\\n') if p.strip()]
    for para in paragraphs:
        lines = para.split('\\n')
        if len(lines) == 1 and len(lines[0]) < 120:
            sec_id = f"sec-{len(sections)}"
            sections.append({
                "id": sec_id, "title": lines[0].strip(), "level": 1,
                "content": "", "pageStart": 1, "pageEnd": page_count,
            })
        else:
            if sections:
                sections[-1]["content"] += para + "\\n\\n"
            else:
                sections.append({
                    "id": "sec-0", "title": "正文", "level": 1,
                    "content": para, "pageStart": 1, "pageEnd": page_count,
                })
    return {"sections": sections, "tables": [], "images": [], "pageCount": page_count}

if __name__ == "__main__":
    filepath = sys.argv[1]
    try:
        if USE_PDFPLUMBER:
            result = parse_with_pdfplumber(filepath)
        elif USE_PYMUPDF:
            result = parse_with_pymupdf(filepath)
        else:
            result = parse_with_pypdf(filepath)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
`;

// ── Excel/CSV Python script ──

const EXCEL_PARSE_SCRIPT = `
import sys, json
import pandas as pd

filepath = sys.argv[1]
ext = filepath.rsplit('.', 1)[-1].lower()
tables = []

try:
    if ext in ('csv', 'tsv'):
        dfs = {"Sheet1": pd.read_csv(filepath)}
    else:
        xl = pd.ExcelFile(filepath)
        dfs = {name: pd.read_excel(filepath, sheet_name=name) for name in xl.sheet_names}

    for sheet_name, df in dfs.items():
        if df.empty:
            continue
        # Build headers
        headers = [{"text": str(h), "level": 0, "colSpan": 1, "rowSpan": 1} for h in df.columns]
        # Convert rows to string arrays
        rows = [[str(v) if not pd.isna(v) else "" for v in row] for row in df.values]
        # Markdown
        md_lines = ["| " + " | ".join(str(h) for h in df.columns) + " |"]
        md_lines.append("|" + " | ".join(["---"] * len(df.columns)) + "|")
        for row in rows:
            md_lines.append("| " + " | ".join(row) + " |")
        csv_str = df.to_csv(index=False)
        tables.append({
            "id": f"table-{sheet_name.lower().replace(' ','_')}",
            "page": 0,
            "caption": sheet_name,
            "headers": headers,
            "rows": rows,
            "mergedCells": [],
            "markdown": "\\n".join(md_lines),
            "html": df.to_html(index=False),
            "csv": csv_str,
        })

    print(json.dumps({"tables": tables, "sheetCount": len(dfs)}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}, ensure_ascii=False))
`;

// ── OCR Python script ──

const OCR_SCRIPT = `
import sys, json, base64

filepath = sys.argv[1]
try:
    from PIL import Image
    img = Image.open(filepath)
    width, height = img.size
except Exception as e:
    print(json.dumps({"error": f"Cannot open image: {e}"}))
    sys.exit(1)

ocr_text = ""
confidence = 0.0

# Try PaddleOCR first (better for CJK), then pytesseract
try:
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=True, lang='ch', show_log=False)
    result = ocr.ocr(filepath, cls=True)
    lines = []
    if result and result[0]:
        for line in result[0]:
            text = line[1][0]
            conf = line[1][1]
            lines.append(text)
            confidence = float(conf) if conf else 0.0
        ocr_text = '\\n'.join(lines)
    # Average confidence
    if result and result[0]:
        confs = [line[1][1] for line in result[0] if line[1][1]]
        confidence = sum(confs) / len(confs) if confs else 0.0
except ImportError:
    try:
        import pytesseract
        from PIL import Image
        ocr_text = pytesseract.image_to_string(img, lang='chi_sim+eng')
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
        confs = [int(c) for c in data['conf'] if c != '-1']
        confidence = sum(confs) / len(confs) / 100.0 if confs else 0.0
    except ImportError:
        print(json.dumps({"error": "No OCR library available (install paddleocr or pytesseract)"}))
        sys.exit(1)

# Base64 encode the image
with open(filepath, 'rb') as f:
    img_base64 = base64.b64encode(f.read()).decode('utf-8')

print(json.dumps({
    "ocrText": ocr_text,
    "ocrConfidence": round(confidence, 4),
    "base64": img_base64,
    "width": width,
    "height": height,
}, ensure_ascii=False))
`;

// ── Parser class ──

export class DocumentParser {
  private store: {
    appendLog: (id: string, msg: string) => void;
    updateStatus: (id: string, status: DocumentMeta['parseStatus'], error?: string) => void;
    updateParsedContent: (
      id: string,
      updates: Partial<Pick<DocumentMeta, 'sections' | 'tables' | 'images' | 'pageCount'>>,
    ) => void;
  };

  constructor(store: {
    appendLog: (id: string, msg: string) => void;
    updateStatus: (id: string, status: DocumentMeta['parseStatus'], error?: string) => void;
    updateParsedContent: (
      id: string,
      updates: Partial<Pick<DocumentMeta, 'sections' | 'tables' | 'images' | 'pageCount'>>,
    ) => void;
  }) {
    this.store = store;
  }

  /** Parse a document based on its file type. Updates the store as it goes. */
  async parse(doc: DocumentMeta): Promise<void> {
    this.store.updateStatus(doc.id, 'parsing');
    this.store.appendLog(doc.id, `Starting parse for ${doc.fileName} (type: ${doc.fileType})`);

    try {
      switch (doc.fileType) {
        case 'pdf':
          await this.parsePdf(doc);
          break;
        case 'word':
        case 'ppt':
        case 'markdown':
        case 'txt':
          await this.parseViaPandoc(doc);
          break;
        case 'excel':
        case 'csv':
          await this.parseSpreadsheet(doc);
          break;
        case 'image':
          await this.parseImage(doc);
          break;
        default:
          this.store.appendLog(doc.id, `Unsupported file type: ${doc.fileType}`);
          this.store.updateStatus(doc.id, 'failed', `Unsupported file type: ${doc.fileType}`);
          return;
      }

      this.store.updateStatus(doc.id, 'completed');
      this.store.appendLog(doc.id, `Parse completed for ${doc.fileName}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.appendLog(doc.id, `Parse error: ${msg}`);
      this.store.updateStatus(doc.id, 'failed', msg);
      logError(`[DocumentParser] Failed to parse ${doc.fileName}: ${msg}`);
    }
  }

  // ── PDF parsing ──

  private async parsePdf(doc: DocumentMeta): Promise<void> {
    this.store.appendLog(doc.id, 'Attempting PDF parse with Python (pdfplumber/PyMuPDF)');

    const output = runPythonScriptFile(
      PDF_PARSE_SCRIPT,
      [doc.filePath],
      this.store,
      doc.id,
    );

    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (parsed.error) {
          throw new Error(parsed.error);
        }
        // Map sections
        const sections: DocumentSection[] = (parsed.sections ?? []).map(
          (s: Record<string, unknown>, i: number) => ({
            id: (s.id as string) ?? `sec-${i}`,
            title: (s.title as string) ?? '',
            level: (s.level as number) ?? 1,
            content: (s.content as string) ?? '',
            pageStart: (s.pageStart as number) ?? 0,
            pageEnd: (s.pageEnd as number) ?? 0,
          }),
        );
        // Map tables
        const tables: ParsedTable[] = (parsed.tables ?? []).map(
          (t: Record<string, unknown>) => ({
            id: (t.id as string) ?? randomUUID(),
            page: (t.page as number) ?? 0,
            caption: t.caption as string | undefined,
            headers: (t.headers as TableHeader[]) ?? [],
            rows: (t.rows as string[][]) ?? [],
            mergedCells: (t.mergedCells as ParsedTable['mergedCells']) ?? [],
            markdown: (t.markdown as string) ?? '',
            html: (t.html as string) ?? '',
            csv: (t.csv as string) ?? '',
            bbox: t.bbox as ParsedTable['bbox'],
          }),
        );
        // Map images
        const images: ParsedImage[] = (parsed.images ?? []).map(
          (img: Record<string, unknown>, i: number) => ({
            id: (img.id as string) ?? `img-${i}`,
            page: (img.page as number) ?? 0,
            bbox: img.bbox as ParsedImage['bbox'],
          }),
        );

        this.store.updateParsedContent(doc.id, {
          sections,
          tables,
          images,
          pageCount: parsed.pageCount as number | undefined,
        });
        this.store.appendLog(
          doc.id,
          `PDF parsed: ${sections.length} sections, ${tables.length} tables, ${images.length} images, ${parsed.pageCount ?? '?'} pages`,
        );
        return;
      } catch (parseErr) {
        this.store.appendLog(doc.id, `Failed to parse Python output: ${String(parseErr)}`);
      }
    }

    // Fallback: try pandoc
    this.store.appendLog(doc.id, 'Python PDF parse failed or unavailable, trying pandoc fallback');
    await this.pandocFallback(doc, 'pdf');
  }

  // ── Pandoc-based parsing (docx, pptx, md, txt) ──

  private async parseViaPandoc(doc: DocumentMeta): Promise<void> {
    if (!isPandocAvailable()) {
      this.store.appendLog(doc.id, 'pandoc not available, skipping parse');
      this.store.updateStatus(doc.id, 'failed', 'pandoc not available');
      return;
    }

    const formatMap: Record<string, string> = {
      word: 'docx',
      ppt: 'pptx',
      markdown: 'markdown',
      txt: 'markdown', // pandoc treats plain text as markdown
    };

    const fromFormat = formatMap[doc.fileType] ?? 'markdown';
    this.store.appendLog(doc.id, `Running pandoc -f ${fromFormat}`);

    try {
      const md = runPandoc(doc.filePath, fromFormat);
      const sections = this.splitMarkdownIntoSections(md);
      this.store.updateParsedContent(doc.id, { sections });
      this.store.appendLog(doc.id, `Pandoc produced ${sections.length} sections`);
    } catch (err) {
      this.store.appendLog(doc.id, `pandoc failed: ${String(err)}`);
      this.store.updateStatus(doc.id, 'failed', String(err));
    }
  }

  // ── Spreadsheet parsing ──

  private async parseSpreadsheet(doc: DocumentMeta): Promise<void> {
    this.store.appendLog(doc.id, 'Parsing spreadsheet with Python/pandas');

    const output = runPythonScriptFile(
      EXCEL_PARSE_SCRIPT,
      [doc.filePath],
      this.store,
      doc.id,
    );

    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (parsed.error) throw new Error(parsed.error);
        const tables: ParsedTable[] = (parsed.tables ?? []).map(
          (t: Record<string, unknown>) => ({
            id: (t.id as string) ?? randomUUID(),
            page: 0,
            caption: t.caption as string | undefined,
            headers: (t.headers as TableHeader[]) ?? [],
            rows: (t.rows as string[][]) ?? [],
            mergedCells: [],
            markdown: (t.markdown as string) ?? '',
            html: (t.html as string) ?? '',
            csv: (t.csv as string) ?? '',
          }),
        );
        this.store.updateParsedContent(doc.id, { tables });
        this.store.appendLog(doc.id, `Spreadsheet parsed: ${tables.length} sheets/tables`);
        return;
      } catch (parseErr) {
        this.store.appendLog(doc.id, `Failed to parse spreadsheet output: ${String(parseErr)}`);
      }
    }

    // Fallback: pandoc
    this.store.appendLog(doc.id, 'Python spreadsheet parse failed, trying pandoc');
    await this.pandocFallback(doc, doc.fileType);
  }

  // ── Image / OCR parsing ──

  private async parseImage(doc: DocumentMeta): Promise<void> {
    this.store.appendLog(doc.id, 'Running OCR on image');

    const output = runPythonScriptFile(
      OCR_SCRIPT,
      [doc.filePath],
      this.store,
      doc.id,
    );

    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (parsed.error) throw new Error(parsed.error);

        const imgResult: ParsedImage = {
          id: `img-${doc.id}-main`,
          page: 0,
          ocrText: parsed.ocrText ?? '',
          ocrConfidence: parsed.ocrConfidence,
          base64: parsed.base64,
          bbox: parsed.width
            ? { x: 0, y: 0, width: parsed.width, height: parsed.height }
            : undefined,
        };

        this.store.updateParsedContent(doc.id, { images: [imgResult] });
        this.store.appendLog(
          doc.id,
          `OCR complete, confidence: ${imgResult.ocrConfidence ?? 'N/A'}`,
        );
        return;
      } catch (parseErr) {
        this.store.appendLog(doc.id, `Failed to parse OCR output: ${String(parseErr)}`);
      }
    }

    this.store.appendLog(doc.id, 'OCR failed or Python unavailable - storing image as-is');
    // Store metadata without OCR text
    try {
      const buf = fs.readFileSync(doc.filePath);
      const base64 = buf.toString('base64');
      this.store.updateParsedContent(doc.id, {
        images: [{ id: `img-${doc.id}-main`, page: 0, base64 }],
      });
    } catch {
      this.store.updateStatus(doc.id, 'failed', 'Failed to read image file');
      return;
    }
    this.store.updateStatus(doc.id, 'completed');
  }

  // ── Fallback ──

  private async pandocFallback(doc: DocumentMeta, fromFormat: string): Promise<void> {
    if (!isPandocAvailable()) {
      this.store.appendLog(doc.id, 'pandoc not available for fallback');
      this.store.updateStatus(doc.id, 'failed', 'No parser available (pandoc not found)');
      return;
    }
    const formatMap: Record<string, string> = {
      pdf: 'pdf',
      excel: 'docx',
      xlsx: 'docx',
      csv: 'csv',
    };
    const fmt = formatMap[fromFormat] ?? 'markdown';
    try {
      const md = runPandoc(doc.filePath, fmt);
      const sections = this.splitMarkdownIntoSections(md);
      this.store.updateParsedContent(doc.id, { sections });
      this.store.appendLog(doc.id, `Pandoc fallback produced ${sections.length} sections`);
      this.store.updateStatus(doc.id, 'completed');
    } catch (err) {
      this.store.appendLog(doc.id, `Pandoc fallback also failed: ${String(err)}`);
      this.store.updateStatus(doc.id, 'failed', `Pandoc fallback failed: ${String(err)}`);
    }
  }

  // ── Markdown section splitter ──

  private splitMarkdownIntoSections(md: string): DocumentSection[] {
    const sections: DocumentSection[] = [];
    const lines = md.split('\n');

    // We accumulate a "draft" section before committing it
    let draftTitle = '';
    let draftLevel = 0;
    let draftLines: string[] = [];
    let draftIndex = 0;

    function flushDraft(): void {
      const content = draftLines.join('\n').trim();
      if (draftTitle.trim() || content.trim()) {
        sections.push({
          id: `sec-${draftIndex}`,
          title: draftTitle,
          level: draftLevel,
          content,
          pageStart: 0,
          pageEnd: 0,
        });
      }
      draftLines = [];
    }

    for (const line of lines) {
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
      if (headingMatch) {
        flushDraft();
        draftIndex = sections.length;
        draftTitle = headingMatch[2].trim();
        draftLevel = headingMatch[1].length;
      } else {
        if (draftTitle === '' && draftLines.length === 0 && sections.length === 0) {
          // Preamble before any heading
          draftTitle = 'Preamble';
          draftLevel = 0;
          draftIndex = 0;
        }
        draftLines.push(line);
      }
    }
    flushDraft();

    return sections.filter(
      (s) => s.title.trim() || s.content.trim(),
    );
  }
}
