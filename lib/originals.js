import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { InputError } from './input.js';

export async function retainUpload(stream, directory, filename, maxBytes, ingest) {
  if (Number(stream.headers?.['content-length']) > maxBytes) throw new InputError('Upload exceeds the file size limit.', 413);
  await mkdir(join(directory, 'originals'), { recursive: true, mode: 0o700 });
  const storageName = randomUUID();
  const path = join(directory, 'originals', storageName);
  const file = await open(path, 'wx', 0o600);
  let bytes = 0;
  let saved = false;
  async function* recording() {
    for await (const chunk of stream) {
      if (bytes + chunk.length > maxBytes) throw new InputError('Upload exceeds the file size limit.', 413);
      await file.writeFile(chunk);
      bytes += chunk.length;
      yield chunk;
    }
  }
  const input = Readable.from(recording(), { highWaterMark: 1 });
  input.headers = stream.headers;
  try {
    const result = await ingest(input, () => ({ storageName, filename: basename(filename), bytes }));
    saved = true;
    return result;
  } catch (error) {
    input.destroy();
    throw error;
  } finally {
    input.destroy();
    await file.close();
    if (!saved) await rm(path, { force: true });
  }
}

export function originalType(filename) {
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.txt': 'text/plain; charset=utf-8',
  })[extname(filename).toLowerCase()] || 'application/octet-stream';
}
