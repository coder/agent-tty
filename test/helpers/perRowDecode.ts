// The decode that the ghostty-web harness used before it read the viewport
// once: every row goes through activeBuffer.getLine(row), which re-reads the
// whole viewport out of the wasm module. A test runs it against the terminal
// that the harness decodes and compares the results, so a change in how the
// harness indexes or interprets the one viewport read shows as a difference.
//
// The string is an expression that evaluates to a function in the page. A
// function value would carry the transpiler's helpers into the page, which
// does not have them. Call it as
// (PER_ROW_DECODE)(terminal, includeScrollback) and it returns the payload
// fields of window.__agentTty.getSnapshot({ includeCells: true }).
export const PER_ROW_DECODE = `((terminal, includeScrollback) => {
  terminal.scrollToBottom();
  const wasmTerm = terminal.wasmTerm;
  const { cols, rows } = wasmTerm.getDimensions();
  const buffer = terminal.buffer.active;
  const top = buffer.length - rows;
  const nullCell = buffer.getNullCell();
  const hex = (value) => '#' + value.toString(16).padStart(6, '0');
  const widthOf = (line, col) => {
    const width = line?.getCell(col)?.getWidth();
    return Number.isInteger(width) && width >= 0 ? width : 1;
  };
  // A spacer column (width 0) adds nothing, a blank is a NUL that reads as a
  // space, and only the trailing ASCII spaces of the line go.
  const textOf = (line, graphemeAt) => {
    let text = '';
    for (let col = 0; col < cols; col += 1) {
      const grapheme = graphemeAt(col);
      if (widthOf(line, col) !== 0) {
        text += grapheme === '\\u0000' ? ' ' : grapheme;
      }
    }
    return text.replace(/ +$/, '');
  };
  const decodeCell = (cell, grapheme) => {
    const inverse = cell.isInverse() === 1;
    const fg = cell.getFgColor();
    const bg = cell.getBgColor();
    return {
      char: cell.getChars() === '' ? '' : grapheme,
      fg: hex(inverse ? bg : fg),
      bg: hex(inverse ? fg : bg),
      ...(cell.isBold() === 1 && { bold: true }),
      ...(cell.isItalic() === 1 && { italic: true }),
      ...(cell.isUnderline() === 1 && { underline: true }),
      ...(cell.isStrikethrough() === 1 && { strikethrough: true }),
    };
  };
  const visibleLines = [];
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    const line = buffer.getLine(top + row);
    visibleLines.push({
      row,
      text: textOf(line, (col) => wasmTerm.getGraphemeString(row, col)),
    });
    cells.push({
      lineNumber: row,
      cells: Array.from({ length: cols }, (_, col) =>
        decodeCell(
          line?.getCell(col) ?? nullCell,
          wasmTerm.getGraphemeString(row, col),
        ),
      ),
    });
  }
  const scrollbackLines = [];
  for (let row = 0; includeScrollback && row < top; row += 1) {
    const line = buffer.getLine(row);
    scrollbackLines.push({
      row,
      text: textOf(line, (col) => wasmTerm.getScrollbackGraphemeString(row, col)),
    });
  }
  return { cols, rows, visibleLines, scrollbackLines, cells };
})`;
