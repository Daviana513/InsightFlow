export type CandidateRow = Record<string, string>;

function textValue(value: unknown): string {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function parseCsv(text: string): CandidateRow[] {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some(Boolean)) lines.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some(Boolean)) lines.push(row);

  const headers = (lines.shift() || []).map((value, index) =>
    index === 0 ? value.replace(/^\uFEFF/, "").trim() : value.trim(),
  );
  return lines.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

export function parseCandidateData(name: string, text: string): CandidateRow[] {
  if (name.toLowerCase().endsWith(".csv")) return parseCsv(text);
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as Record<string, unknown>).rows || (parsed as Record<string, unknown>).items || (parsed as Record<string, unknown>).records)
      : null;
  if (!Array.isArray(rows)) throw new Error("JSON 需要是记录数组，或包含 rows、items、records 数组。");
  return rows.map((entry) => Object.fromEntries(
    Object.entries((entry || {}) as Record<string, unknown>).map(([key, value]) => [key, textValue(value)]),
  ));
}

export function guessField(headers: string[], names: string[]): string {
  const lowered = new Map(headers.map((header) => [header.toLowerCase(), header]));
  for (const name of names) if (lowered.has(name)) return lowered.get(name) || "";
  return headers.find((header) => names.some((name) => header.toLowerCase().includes(name))) || "";
}

export function toCsv(rows: CandidateRow[]): string {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return [headers, ...rows.map((row) => headers.map((header) => row[header] || ""))]
    .map((values) => values.map(escape).join(","))
    .join("\r\n");
}
