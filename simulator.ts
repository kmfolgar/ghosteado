/**
 * simulator.ts
 * Deterministic fake CSV generator.
 * Infers column types from header names and produces realistic-looking
 * but entirely synthetic data. Same seed → same output always.
 */

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Column type inference ─────────────────────────────────────────────────────
type ColType =
  | "id" | "age" | "date" | "year" | "sex"
  | "icd" | "count" | "rate" | "boolean"
  | "category" | "name" | "float" | "integer";

export function inferColType(header: string): ColType {
  const h = header.toLowerCase().replace(/[\s_\-]/g, "");
  if (/^id$|_id$|^uid|^uuid|patientid|caseid|recordid|subjectid/.test(h)) return "id";
  if (/\bage\b|edad|age_at/.test(h))                                       return "age";
  if (/date|fecha|dob|birthdt|diagdt|inciddt/.test(h))                     return "date";
  if (/^year$|^yr$|año|year_/.test(h))                                     return "year";
  if (/^sex$|^gender$|sexo|genero/.test(h))                                return "sex";
  if (/icd|morphology|histology|topography|diagnosis/.test(h))             return "icd";
  if (/count|cases|numero|^n$|^num$|^obs$/.test(h))                        return "count";
  if (/rate|incidence|prevalence|proportion|pct|percent|ratio/.test(h))    return "rate";
  if (/flag|^is_|^has_|active|bool/.test(h))                               return "boolean";
  if (/name|nombre|apellido|surname|firstname|lastname/.test(h))           return "name";
  if (/country|region|district|province|state|city|site|pais/.test(h))    return "category";
  if (/weight|bmi|height|dose|conc|level|score|index/.test(h))             return "float";
  return "integer";
}

// ── Value generators ──────────────────────────────────────────────────────────
const COUNTRIES   = ["France","Germany","Spain","Italy","UK","USA","Mexico","Guatemala","Brazil","Japan"];
const SEXES       = ["Male","Female"];
const ICD10       = ["C00","C15","C16","C18","C22","C34","C50","C61","C64","C73","C83","C91"];
const FIRST_NAMES = ["Ana","Carlos","Maria","Juan","Elena","Luis","Sofia","David","Laura","Pablo"];
const LAST_NAMES  = ["García","López","Martínez","Sánchez","Pérez","González","Rodríguez","Fernández"];

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export function generateValue(colType: ColType, rowIdx: number, rng: () => number): string {
  switch (colType) {
    case "id":       return `ID-${String(rowIdx + 1).padStart(5, "0")}`;
    case "age":      return String(Math.floor(rng() * 80) + 1);
    case "year":     return String(Math.floor(rng() * 25) + 2000);
    case "date": {
      const base = new Date(2000, 0, 1).getTime();
      const range = 25 * 365 * 24 * 60 * 60 * 1000;
      return fmtDate(new Date(base + Math.floor(rng() * range)));
    }
    case "sex":      return pick(SEXES, rng);
    case "icd":      return pick(ICD10, rng);
    case "count":    return String(Math.floor(rng() * 500));
    case "rate":     return (rng() * 100).toFixed(2);
    case "boolean":  return rng() > 0.5 ? "TRUE" : "FALSE";
    case "name":     return `${pick(FIRST_NAMES, rng)} ${pick(LAST_NAMES, rng)}`;
    case "category": return pick(COUNTRIES, rng);
    case "float":    return (rng() * 200).toFixed(3);
    case "integer":  return String(Math.floor(rng() * 1000));
  }
}

// ── AI pre-prompt generator ───────────────────────────────────────────────────

/**
 * Generates a ready-to-paste prompt that the user can give to any AI agent
 * (Copilot Chat, Cursor, Claude, etc.) to have it write a realistic
 * simulation script tailored to their exact dataset structure.
 *
 * @param csvName  Original CSV filename (e.g. "patients.csv")
 * @param headers  Column names from the real file header row
 * @param rows     Desired number of rows for the simulated dataset
 * @param language "r" | "python" | "both" — which language the AI should use
 */
export function generateAIPrompt(
  csvName: string,
  headers: string[],
  rows: number,
  language: "r" | "python" | "both"
): string {
  const today   = new Date().toISOString().split("T")[0];
  const langStr = language === "both" ? "R and Python" : language === "r" ? "R" : "Python";

  const tableRows = headers.map((h) => {
    const ct = inferColType(h);
    const hint: Record<string, string> = {
      id:       "Sequential unique identifier — e.g. ID-00001",
      age:      "Integer — realistic age range for your population",
      year:     "Integer — calendar year (e.g. 2000–2024)",
      date:     "Date — YYYY-MM-DD format, realistic date range",
      sex:      "Categorical — e.g. Male / Female",
      icd:      "Categorical — ICD-10 codes relevant to your domain",
      count:    "Non-negative integer — use Poisson or negative-binomial distribution",
      rate:     "Float — proportion or rate, appropriate range and decimal places",
      boolean:  "Boolean — TRUE / FALSE or 1 / 0",
      name:     "String — realistic person name (use faker or similar)",
      category: "Categorical — domain-relevant category labels",
      float:    "Float — continuous measurement, realistic range and precision",
      integer:  "Integer — generic numeric variable",
    };
    return `| ${h} | ${ct} | ${hint[ct] ?? "numeric"} |`;
  });

  const langInstructions = language === "both"
    ? [
        `Write **two scripts**: one in R and one in Python.`,
        `- R:      save to \`_simulated/simulate_${csvName.replace(/\.csv$/i, "")}.R\``,
        `- Python: save to \`_simulated/simulate_${csvName.replace(/\.csv$/i, "")}.py\``,
      ].join("\n")
    : language === "r"
    ? `Write an **R script** and save the output to \`_simulated/${csvName}\`.`
    : `Write a **Python script** (pandas + numpy) and save the output to \`_simulated/${csvName}\`.`;

  return [
    `# Ghosteado — AI Simulation Prompt`,
    `# Dataset : ${csvName}`,
    `# Created : ${today}`,
    `# Language: ${langStr}`,
    `#`,
    `# HOW TO USE:`,
    `#   Copy everything below the dashed line and paste it into`,
    `#   your AI agent (Copilot Chat, Cursor, Claude, etc.)`,
    ``,
    `---`,
    ``,
    `I have a sensitive dataset called **${csvName}** that I cannot share directly.`,
    `Please create a **realistic simulated version** of it based only on the structure below.`,
    ``,
    `## Dataset structure`,
    ``,
    `- File: \`${csvName}\``,
    `- Rows: ${rows}`,
    `- Columns: ${headers.length}`,
    ``,
    `| Column | Inferred type | Notes |`,
    `|--------|--------------|-------|`,
    ...tableRows,
    ``,
    `## Your task`,
    ``,
    langInstructions,
    ``,
    `**Requirements:**`,
    `1. Use a fixed random seed (42) so results are reproducible`,
    `2. Choose statistically appropriate distributions for each column type`,
    `   (e.g. Poisson for counts, Beta for proportions, realistic ranges for ages/years)`,
    `3. Categorical columns should have realistic category frequencies, not just uniform sampling`,
    `4. Dates should fall in a plausible range for the domain`,
    `5. The simulated data should look real enough that code written against it works on the real data`,
    `6. Print a confirmation message when the file is written`,
    ``,
    `**Context:** This simulated file will be used as a safe substitute for AI-assisted coding.`,
    `The real data is confidential. Do not guess or invent real values — generate plausible synthetic data only.`,
    ``,
  ].join("\n");
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ── Main: build simulated CSV string ─────────────────────────────────────────
export function simulateCsv(headers: string[], rows: number, seed: number): string {
  const colTypes = headers.map(inferColType);
  const lines: string[] = [headers.map(csvEscape).join(",")];

  for (let r = 0; r < rows; r++) {
    // Each row gets its own seeded RNG derived from (seed, rowIndex, colIndex)
    // so column values are independent but fully deterministic
    const rowValues = colTypes.map((ct, c) => {
      const cellSeed = seed ^ (r * 2654435761) ^ (c * 1013904223);
      const rng = makeRng(cellSeed);
      return generateValue(ct, r, rng);
    });
    lines.push(rowValues.map(csvEscape).join(","));
  }

  return lines.join("\n") + "\n";
}
