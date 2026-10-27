import { constants } from 'node:fs';
import { mkdir, chmod, open, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('Storage must be a real directory.');
  await chmod(path, 0o700);
}

export async function readText(path, maxBytes = 1024 * 1024) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    if (!(await file.stat()).isFile()) throw new Error('Expected a regular JSON file.');
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maxBytes) throw new Error('JSON file exceeds its size limit.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); }
    catch { throw new Error('Local file is not valid UTF-8. Restore a valid backup.'); }
  } finally { await file.close(); }
}

export async function readJson(path, maxBytes = 1024 * 1024) {
    const text = await readText(path, maxBytes);
    if (text === null) return null;
    let value;
    try { value = JSON.parse(text); }
    catch { throw new Error('Local JSON is malformed. Restore a valid backup; do not discard route state.'); }
    if (value === null) throw new Error('JSON null is not a saved record.');
    return value;
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicJson(directory, name, value, maxBytes = 1024 * 1024) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > maxBytes) throw new Error('Output exceeds its size limit.');
  await privateDirectory(directory);
  const temporary = join(directory, `.write-${randomUUID()}`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally { await file?.close(); await rm(temporary, { force: true }); }
}

export async function acquireLock(directory) {
  await privateDirectory(directory);
  const path = join(directory, '.lock');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Route lock exists. Confirm the old process stopped before removing .lock.');
    throw error;
  }
  const owner = { pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() };
  try { await atomicJson(path, 'owner.json', owner, 4096); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return async () => {
    const saved = await readJson(join(path, 'owner.json'), 4096);
    if (saved?.nonce !== owner.nonce) throw new Error('Lock ownership changed.');
    await rm(path, { recursive: true });
  };
}
