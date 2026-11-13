'use strict';

/**
 * Write an entire streamed installer chunk at an explicit file position.
 * FileHandle.write() may legally write fewer bytes than requested, so callers
 * must continue until every byte has reached the file or fail closed.
 */
async function writeBufferFully(handle, buffer, position) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Installer chunk must be a Buffer.');
  if (!Number.isSafeInteger(position) || position < 0) throw new TypeError('Installer write position is invalid.');

  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const result = await handle.write(buffer, offset, remaining, position + offset);
    const bytesWritten = result?.bytesWritten;
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error('Installer file write did not make forward progress.');
    }
    offset += bytesWritten;
  }
  return offset;
}

module.exports = { writeBufferFully };
