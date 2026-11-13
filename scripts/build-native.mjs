import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'native', 'EStopOverlay.cs');
const OUT_DIR = join(ROOT, 'bin');
const OUT_EXE = join(OUT_DIR, 'EStopOverlay.exe');
const STAMP_FILE = join(OUT_DIR, 'EStopOverlay.sha256');

const CSC_CANDIDATES = [
  join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

export function findCsc() {
  for (const candidate of CSC_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find .NET Framework csc.exe (expected v4.0.30319)');
}

export function sourceHash() {
  return createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
}

export function needsBuild() {
  if (!existsSync(OUT_EXE) || !existsSync(STAMP_FILE)) return true;
  const saved = readFileSync(STAMP_FILE, 'utf8').trim();
  return saved !== sourceHash();
}

export function buildOverlay({ force = false } = {}) {
  if (!force && !needsBuild()) {
    return { built: false, exe: OUT_EXE, hash: sourceHash() };
  }
  const csc = findCsc();
  mkdirSync(OUT_DIR, { recursive: true });
  const args = [
    '/nologo',
    '/optimize+',
    '/target:winexe',
    `/out:${OUT_EXE}`,
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll',
    SOURCE,
  ];
  execFileSync(csc, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const hash = sourceHash();
  writeFileSync(STAMP_FILE, `${hash}\n`, 'utf8');
  return { built: true, exe: OUT_EXE, hash };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const force = process.argv.includes('--force');
  const res = buildOverlay({ force });
  console.log(res.built ? `Built ${res.exe} (${res.hash.slice(0, 12)})` : `Up to date: ${res.exe} (${res.hash.slice(0, 12)})`);
}
