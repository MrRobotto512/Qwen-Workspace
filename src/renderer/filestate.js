'use strict';

// Read before overwrite (from Hermes Agent's tools/file_tools_write_guards.py): write_file on a
// file that already exists is refused unless this task has read the whole file — or written it
// itself — and the file has not changed since. A small model rewriting a file from memory drops
// what it never saw (a field-report pattern: a 900-line game replaced by the 200 lines the
// model remembered), and a parallel subagent, or the user in the editor, may have changed it
// meanwhile. Edits are not affected: edit_file only replaces the text it names.
// Pure: no DOM. `files` is the conversation's map: path -> { hash, seenTo, lines }.

(() => {
// FNV-1a, 32 bits: enough to notice a change.
function hash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const lineCount = (text) => {
  const all = String(text ?? '').split(/\r?\n/);
  return all.length - (all[all.length - 1] === '' ? 1 : 0);
};

// A read of lines start..end of `content`. Pages that follow on from the start add up, so a
// file read page by page to its end counts as read in full.
function noteRead(files, path, content, start = 1, end = Infinity) {
  const h = hash(content);
  const lines = lineCount(content);
  const prev = files[path];
  const fresh = !prev || prev.hash !== h;
  const from = fresh ? 0 : prev.seenTo || 0;
  const seenTo = start <= from + 1 ? Math.max(from, Math.min(end, lines)) : from;
  files[path] = { hash: h, seenTo, lines };
  return files[path];
}

// The task wrote this content itself: it knows all of it.
function noteWrite(files, path, content) {
  const lines = lineCount(content);
  files[path] = { hash: hash(content), seenTo: lines, lines };
}

// Why write_file may not overwrite `path` (whose current content is `current`), or null.
function overwriteBlocker(files, path, current) {
  const f = files[path];
  const lines = lineCount(current);
  if (!f) return `Not written: ${path} already exists (${lines} lines) and you have not read it in this task. Writing a whole file from memory loses everything you did not see. Read it first with read_file, then change it with edit_file — or, if you mean to replace all of it, write_file again after reading it.`;
  if (f.hash !== hash(current)) return `Not written: ${path} has changed since you last read it (by the user or another agent). Read it again with read_file and make your change on what is there now — preferably with edit_file.`;
  if ((f.seenTo || 0) < lines) return `Not written: you have read only lines 1-${f.seenTo || 0} of ${path}'s ${lines}. Read the rest (read_file with start_line=${(f.seenTo || 0) + 1}) before replacing the whole file, or change just the part you need with edit_file.`;
  return null;
}

const FileStateExports = { hash, lineCount, noteRead, noteWrite, overwriteBlocker };
if (typeof module !== 'undefined' && module.exports) module.exports = FileStateExports;
if (typeof window !== 'undefined') window.FileState = FileStateExports;
})();
