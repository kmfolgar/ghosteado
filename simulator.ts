/**
 * simulator.ts
 * Schema collection and prompt generation for protected datasets.
 *
 * Ghosteado now treats synthetic data as optional. The default workflow is:
 *   1. Collect a safe, local-only schema summary from the real dataset
 *   2. Generate prompts from that schema when synthetic data is needed
 *   3. Let the user decide when to create synthetic files
 */

import * as fs from "fs";
import * as path from "path";

export type PromptLanguage = "r" | "python" | "both" | "none";

type ColType =
  | "id"
  | "age"
  | "date"
  | "year"
  | "sex"
  | "icd"
  | "count"
  | "rate"
  | "boolean"
  | "category"
  | "name"
  | "float"
  | "integer";

export interface ColumnSummary {
  name: string;
  inferredType: ColType;
}

export interface DatasetFileSummary {
  relativePath: string;
  format: "csv" | "tsv" | "other";
  sizeBytes: number;
  columnCount?: number;
  columns?: ColumnSummary[];
  note?: string;
}

export interface DatasetSchemaSummary {
  datasetName: string;
  workspaceFolderRel: string;
  collectedAt: string;
  fileCount: number;
  tabularFileCount: number;
  truncated: boolean;
  files: DatasetFileSummary[];
}

const SKIP_DIRS = new Set([".git", ".ghosteado", "_simulated", "node_modules"]);
const MAX_SCHEMA_FILES = 250;

export function inferColType(header: string): ColType {
  const h = header.toLowerCase().replace(/[\s_\-]/g, "");
  if (/^id$|_id$|^uid|^uuid|patientid|caseid|recordid|subjectid/.test(h)) return "id";
  if (/\bage\b|edad|age_at/.test(h)) return "age";
  if (/date|fecha|dob|birthdt|diagdt|inciddt/.test(h)) return "date";
  if (/^year$|^yr$|ano|year_/.test(h)) return "year";
  if (/^sex$|^gender$|sexo|genero/.test(h)) return "sex";
  if (/icd|morphology|histology|topography|diagnosis/.test(h)) return "icd";
  if (/count|cases|numero|^n$|^num$|^obs$/.test(h)) return "count";
  if (/rate|incidence|prevalence|proportion|pct|percent|ratio/.test(h)) return "rate";
  if (/flag|^is_|^has_|active|bool/.test(h)) return "boolean";
  if (/name|nombre|apellido|surname|firstname|lastname/.test(h)) return "name";
  if (/country|region|district|province|state|city|site|pais/.test(h)) return "category";
  if (/weight|bmi|height|dose|conc|level|score|index/.test(h)) return "float";
  return "integer";
}

export function collectDatasetSchema(
  datasetRoot: string,
  workspaceFolderRel: string
): DatasetSchemaSummary {
  const walked = walkDatasetFiles(datasetRoot);
  const summaries = walked.files.map((filePath) =>
    summarizeFile(datasetRoot, filePath)
  );

  return {
    datasetName: path.basename(datasetRoot),
    workspaceFolderRel: toPosix(workspaceFolderRel),
    collectedAt: new Date().toISOString(),
    fileCount: summaries.length,
    tabularFileCount: summaries.filter((f) => f.format !== "other").length,
    truncated: walked.truncated,
    files: summaries,
  };
}

export function formatSchemaMarkdown(schema: DatasetSchemaSummary): string {
  const lines: string[] = [
    `# Ghosteado Schema View`,
    "",
    `Dataset: ${schema.datasetName}`,
    `Workspace path: ${schema.workspaceFolderRel}`,
    `Collected: ${schema.collectedAt}`,
    `Files scanned: ${schema.fileCount}`,
    `Tabular files: ${schema.tabularFileCount}`,
  ];

  if (schema.truncated) {
    lines.push(
      "",
      `Note: only the first ${MAX_SCHEMA_FILES} files were scanned for this summary.`
    );
  }

  if (schema.files.length === 0) {
    lines.push("", "No files were found in this dataset folder.");
    return lines.join("\n");
  }

  for (const file of schema.files) {
    lines.push("", `## ${file.relativePath}`, "", `- Format: ${file.format}`, `- Size: ${file.sizeBytes} bytes`);
    if (file.note) lines.push(`- Note: ${file.note}`);

    if (file.columns && file.columns.length > 0) {
      lines.push(`- Columns: ${file.columnCount ?? file.columns.length}`, "");
      lines.push("| Column | Inferred type |");
      lines.push("| --- | --- |");
      for (const column of file.columns) {
        lines.push(`| ${column.name} | ${column.inferredType} |`);
      }
    }
  }

  return lines.join("\n");
}

export function generateSimulationPrompt(
  schema: DatasetSchemaSummary,
  options: {
    language: PromptLanguage;
    rows: number;
    analysisPath: string;
    syntheticFolderRel: string;
  }
): string {
  const language = options.language === "none" ? "both" : options.language;
  const today = new Date().toISOString().split("T")[0];
  const languageLabel =
    language === "both" ? "R and Python" : language === "r" ? "R" : "Python";

  const headerLines: string[] = [
    "# Ghosteado Synthetic Data Prompt",
    `# Dataset: ${schema.datasetName}`,
    `# Created: ${today}`,
    `# Languages: ${languageLabel}`,
    "",
    "You are helping create synthetic data for a protected project.",
    "",
    "Rules:",
    "- Do not invent or recover real records.",
    "- Use only the schema information below.",
    "- Preserve file names and relative paths.",
    `- Write synthetic outputs under \`${toPosix(options.syntheticFolderRel)}\`.`,
    `- Project analysis code reads data through \`${toPosix(options.analysisPath)}\`.`,
    "- Inside the Ghosteado container, synthetic files are mounted onto that same analysis path.",
    "- Outside the container, the same analysis path resolves to the real dataset on the host.",
    "- If a file format is not tabular or no columns are listed, create a safe placeholder that keeps the file contract obvious without exposing real values.",
    "",
    "Important disclaimer:",
    "If no synthetic data exists, the container can still generate code from schema, but it cannot run end-to-end data reads. That is fine if the goal is code generation first. If you want runnable code in-container, synthetic data needs to exist and be mounted there.",
    "",
    "Deliverables:",
    `- Create synthetic data for ${options.rows} rows per tabular file unless the file shape suggests a smaller fixed lookup table.`,
    language === "both"
      ? "- Provide both R and Python examples that can read from the analysis path and regenerate the synthetic files."
      : language === "r"
      ? "- Provide R code that can regenerate the synthetic files."
      : "- Provide Python code that can regenerate the synthetic files.",
    "- Keep column names unchanged.",
    "- Use realistic ranges and distributions based on the inferred types.",
    "- Make the synthetic data good enough for code generation, testing, and demos.",
  ];

  const fileSections = schema.files.map((file) => formatFilePromptSection(file));

  return [...headerLines, "", "Dataset schema:", "", ...fileSections, ""].join("\n");
}

function formatFilePromptSection(file: DatasetFileSummary): string {
  const lines: string[] = [
    `## ${file.relativePath}`,
    `- Format: ${file.format}`,
    `- Size: ${file.sizeBytes} bytes`,
  ];

  if (file.note) lines.push(`- Note: ${file.note}`);

  if (file.columns && file.columns.length > 0) {
    lines.push(`- Columns: ${file.columnCount ?? file.columns.length}`, "", "| Column | Inferred type |", "| --- | --- |");
    for (const column of file.columns) {
      lines.push(`| ${column.name} | ${column.inferredType} |`);
    }
  }

  return lines.join("\n");
}

function walkDatasetFiles(datasetRoot: string): {
  files: string[];
  truncated: boolean;
} {
  const results: string[] = [];
  const stack: string[] = [datasetRoot];
  let truncated = false;

  while (stack.length > 0 && results.length < MAX_SCHEMA_FILES) {
    const currentDir = stack.pop();
    if (!currentDir) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= MAX_SCHEMA_FILES) {
        truncated = true;
        break;
      }
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  if (results.length >= MAX_SCHEMA_FILES && stack.length > 0) {
    truncated = true;
  }

  results.sort((a, b) => a.localeCompare(b));
  return { files: results, truncated };
}

function summarizeFile(datasetRoot: string, filePath: string): DatasetFileSummary {
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(filePath).size;
  } catch {
    sizeBytes = 0;
  }

  const rel = toPosix(path.relative(datasetRoot, filePath));
  const ext = path.extname(filePath).toLowerCase();

  if (ext !== ".csv" && ext !== ".tsv") {
    return {
      relativePath: rel,
      format: "other",
      sizeBytes,
      note: "Schema columns were not extracted for this file type.",
    };
  }

  const firstLine = readFirstLine(filePath);
  if (!firstLine) {
    return {
      relativePath: rel,
      format: ext === ".tsv" ? "tsv" : "csv",
      sizeBytes,
      note: "Could not read a header row from this file.",
    };
  }

  const delimiter = ext === ".tsv" ? "\t" : ",";
  const headers = firstLine
    .split(delimiter)
    .map((header) => header.trim().replace(/^"|"$/g, ""))
    .filter((header) => header.length > 0);

  if (headers.length === 0) {
    return {
      relativePath: rel,
      format: ext === ".tsv" ? "tsv" : "csv",
      sizeBytes,
      note: "A tabular file was found, but no header columns were detected.",
    };
  }

  return {
    relativePath: rel,
    format: ext === ".tsv" ? "tsv" : "csv",
    sizeBytes,
    columnCount: headers.length,
    columns: headers.map((header) => ({
      name: header,
      inferredType: inferColType(header),
    })),
  };
}

function readFirstLine(filePath: string): string | null {
  try {
    const buf = Buffer.alloc(4096);
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return null;
  }
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
