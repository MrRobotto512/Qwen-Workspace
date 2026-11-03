'use strict';

// On Windows, `python3` usually is not a real Python: it is missing, or the Microsoft Store
// stub in WindowsApps that opens the Store instead of running anything. Skills and models write
// `python3 script.py` anyway (it is right on macOS and Linux), so QWS runs those commands with a
// Python that works there: the project's virtualenv, else the `py -3` launcher, else `python`.

// `python3`/`pip3` at a command position (start, or after ; & | && || ( or a space-separated
// chain) — not inside a word like mypython3 or a path like C:\python3\x.
const PY3 = /(^|[\s;&|(])(python3|pip3)(?:\.exe)?(?=\s|$|[;&|)])/gi;

function rewritePython3(command, python) {
  if (!python) return { command, changed: false };
  let changed = false;
  const out = String(command).replace(PY3, (_m, pre, word) => {
    changed = true;
    return `${pre}${word.toLowerCase() === 'pip3' ? `${python} -m pip` : python}`;
  });
  return { command: out, changed };
}

const isStoreStub = (p) => /\\WindowsApps\\/i.test(p);
const realPaths = (whereOut) => String(whereOut || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.exe$/i.test(l));

// Which Python stands in for python3. `venv` is the project's virtualenv python.exe (or null);
// the others are the output of `where python3`, `where py`, `where python` ('' when not found).
// Null means leave the command alone: python3 is real here, or nothing better exists.
function choosePython({ venv, wherePython3, wherePy, wherePython }) {
  if (realPaths(wherePython3).some((p) => !isStoreStub(p))) return null;
  if (venv) return /\s/.test(venv) ? `"${venv}"` : venv;
  if (realPaths(wherePy).length) return 'py -3';
  if (realPaths(wherePython).some((p) => !isStoreStub(p))) return 'python';
  return null;
}

module.exports = { rewritePython3, choosePython, isStoreStub };
