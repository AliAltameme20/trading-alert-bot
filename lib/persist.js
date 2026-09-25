// JSON state in data/, committed back to the repo by the GitHub Actions run so it survives
// between runs (GIT_PERSIST=1). Locally it is just files.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`; await writeFile(tmp, JSON.stringify(data, null, 1) + '\n'); await rename(tmp, path);
}
export function commit(message, paths = ['data']) {
  if (process.env.GIT_PERSIST !== '1') return false;
  const git = (...a) => execFileSync('git', a, { stdio: 'pipe' }).toString();
  git('add', ...paths);
  if (!git('status', '--porcelain', ...paths).trim()) return false;
  git('commit', '-m', `${message} [skip ci]`);
  for (let attempt = 0; attempt < 4; attempt++) {
    try { git('push'); return true; } catch { git('pull', '--rebase', '--autostash'); }
  }
  throw new Error('Could not push state after 4 attempts — refusing to continue without durable state');
}
