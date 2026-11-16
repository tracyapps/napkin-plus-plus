/*
 * napkin++ — line folding.
 *
 * Snippets are not prose: a 60-line curl/JSON blob should collapse to the part
 * you actually need. Brace folding for JS/CSS/JSON, indentation folding for
 * Python/YAML, both computed without a parser dependency.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NapkinFold = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function splitLines(input) {
    return text(input).replace(/\r\n/g, '\n').split('\n');
  }

  function indentOf(line) {
    const m = /^[ \t]*/.exec(line);
    return m ? m[0].length : 0;
  }

  function closing(ch) {
    return ch === '{' ? '}' : ch === '[' ? ']' : ch === '(' ? ')' : '';
  }

  /**
   * Foldable regions as 0-based inclusive line ranges.
   * A region always starts at the line that opens it; collapsing hides
   * start+1 .. end.
   */
  function computeFolds(input) {
    const lines = splitLines(input);
    const folds = [];
    const stack = [];
    let inBlockComment = false;

    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      let quote = '';
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        const next = line[i + 1];
        if (inBlockComment) {
          if (ch === '*' && next === '/') {
            inBlockComment = false;
            i += 1;
          }
          continue;
        }
        if (quote) {
          if (ch === '\\') {
            i += 1;
            continue;
          }
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '/' && next === '/') break;
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          i += 1;
          continue;
        }
        if (ch === '#' && i === 0) break;
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
          stack.push({ ch, line: li });
        } else if (ch === '}' || ch === ']' || ch === ')') {
          const open = stack.pop();
          if (!open) continue;
          if (closing(open.ch) !== ch) continue;
          if (li > open.line) folds.push({ start: open.line, end: li, kind: 'brace' });
        }
      }
    }

    for (let li = 0; li < lines.length - 1; li += 1) {
      const line = lines[li];
      if (!/:\s*(?:#.*)?$/.test(line)) continue;
      if (/[([{]\s*$/.test(line)) continue;
      if (/^\s*[)\]}]/.test(line)) continue;
      const base = indentOf(line);
      let end = -1;
      for (let j = li + 1; j < lines.length; j += 1) {
        if (!lines[j].trim()) continue;
        if (indentOf(lines[j]) <= base) break;
        end = j;
      }
      if (end > li) folds.push({ start: li, end, kind: 'indent' });
    }

    folds.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const fold of folds) {
      const last = merged[merged.length - 1];
      if (last && fold.start === last.start && fold.end <= last.end) continue;
      if (last && fold.start <= last.end && fold.end > last.end) {
        last.end = fold.end;
        continue;
      }
      merged.push({ ...fold });
    }
    return merged;
  }

  function foldMap(folds) {
    const map = new Map();
    for (const fold of folds) {
      const existing = map.get(fold.start);
      if (!existing || fold.end > existing.end) map.set(fold.start, fold);
    }
    return map;
  }

  /** Merged 0-based inclusive ranges hidden by the given collapsed starts. */
  function hiddenRanges(folds, collapsed) {
    const ranges = [];
    for (const fold of folds) {
      if (!collapsed.has(fold.start)) continue;
      if (fold.end <= fold.start) continue;
      ranges.push({ start: fold.start + 1, end: fold.end });
    }
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    return merged;
  }

  function hiddenCount(ranges) {
    return ranges.reduce((n, r) => n + Math.max(0, r.end - r.start + 1), 0);
  }

  /** Short label shown in the gutter: first non-empty line, trimmed. */
  function foldLabel(lines, fold) {
    const line = text(lines[fold.start]).trim();
    return line.length > 46 ? line.slice(0, 46) + '…' : line;
  }

  return {
    splitLines,
    computeFolds,
    foldMap,
    hiddenRanges,
    hiddenCount,
    foldLabel,
    indentOf,
  };
});
