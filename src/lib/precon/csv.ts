// Small RFC 4180 CSV parser with hard limits. Hand-written because the app needs nothing more than this, and a parser that is
// fed untrusted uploads should be short enough to read in one sitting.

export const MAX_ROWS = 20_000;
export const MAX_COLS = 100;
export const MAX_CELL = 2_000;

export class SheetLimitError extends Error {}

function detectDelimiter(firstLine: string): string {
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const).sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/** Parses CSV text into rows of cells. Blank lines are dropped. Throws SheetLimitError past the limits. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endCell = () => {
    if (cell.length > MAX_CELL) throw new SheetLimitError("A cell is too long.");
    row.push(cell);
    cell = "";
    if (row.length > MAX_COLS) throw new SheetLimitError("Too many columns.");
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS) throw new SheetLimitError("Too many rows.");
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) endCell();
    else if (ch === "\n") endRow();
    else if (ch === "\r") { if (text[i + 1] !== "\n") endRow(); }
    else cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}
