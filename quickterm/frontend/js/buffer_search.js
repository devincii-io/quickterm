// Finding a search result (GET /api/search) in a pane's xterm buffer. The
// backend numbers lines of its own plain-text transcript, while xterm wraps
// long lines over several rows and keeps only its own scrollback, so the line
// number is a hint and the text is what is looked for. Works on anything
// shaped like xterm's IBuffer; pure, tested under node.

// Python counts code points, JavaScript strings count UTF-16 units: an emoji
// before the match would shift every offset by one.
export function codeUnitOffset(text, codePoints) {
  let units = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen >= codePoints) break;
    units += ch.length;
    seen += 1;
  }
  return units;
}

// Rows joined into the lines the program wrote. A row that continues on the
// next one keeps its full width (its last cell is text, not trailing blank);
// the last row of a line is trimmed like the backend trims its lines.
export function logicalLines(buffer) {
  const lines = [];
  let current = null;
  for (let y = 0; y < buffer.length; y++) {
    const row = buffer.getLine(y);
    if (!row) continue;
    const next = buffer.getLine(y + 1);
    const continues = Boolean(next && next.isWrapped);
    const text = row.translateToString(!continues);
    if (row.isWrapped && current) {
      current.text += text;
      current.rows.push(y);
    } else {
      current = { text, rows: [y] };
      lines.push(current);
    }
  }
  return lines;
}

// Where each UTF-16 unit of a logical line sits: row, column and the width of
// its cell. Wide characters own two columns; their second cell is skipped, as
// translateToString skips it.
function unitPositions(buffer, rows) {
  const out = [];
  for (const y of rows) {
    const row = buffer.getLine(y);
    for (let x = 0; x < row.length; x++) {
      const cell = row.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) out.push({ row: y, col: x, width });
    }
  }
  return out;
}

// { row, col, cells } for xterm's select(col, row, cells), or null. `match`
// is { text, start, length, line }: the result's excerpt, the match offset
// and length in code points, and the backend line number as a tie-breaker.
export function findInBuffer(buffer, match) {
  const text = String(match.text || "");
  const startUnit = codeUnitOffset(text, match.start || 0);
  const endUnit = codeUnitOffset(text, (match.start || 0) + Math.max(1, match.length || 0));
  const needle = text.slice(startUnit, endUnit);
  if (!needle) return null;
  const lines = logicalLines(buffer);
  const candidates = [];
  lines.forEach((line, index) => {
    const whole = line.text.indexOf(text);
    if (whole >= 0) candidates.push({ index, offset: whole + startUnit });
  });
  // The excerpt did not survive xterm's own rendering (a line the backend
  // model split differently, a reflow): fall back to the matched words.
  if (!candidates.length) {
    const lower = needle.toLowerCase();
    lines.forEach((line, index) => {
      const at = line.text.toLowerCase().indexOf(lower);
      if (at >= 0) candidates.push({ index, offset: at });
    });
  }
  if (!candidates.length) return null;
  const hint = Number.isFinite(match.line) ? match.line : lines.length;
  let best = candidates[0];
  for (const candidate of candidates) {
    const d = Math.abs(candidate.index - hint);
    const bestD = Math.abs(best.index - hint);
    if (d < bestD || (d === bestD && candidate.index > best.index)) best = candidate;
  }
  const positions = unitPositions(buffer, lines[best.index].rows);
  const first = positions[best.offset];
  const last = positions[best.offset + needle.length - 1];
  if (!first || !last) return null;
  const cols = buffer.getLine(first.row).length || 1;
  const cells = (last.row - first.row) * cols + last.col + last.width - first.col;
  return { row: first.row, col: first.col, cells: Math.max(1, cells) };
}
