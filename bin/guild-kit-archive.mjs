// Bounded, regular-file-only archives for first-party release inputs. No extraction runs code.
import { deflateRawSync, inflateRawSync, gzipSync, gunzipSync } from 'node:zlib';

export const ARCHIVE_LIMITS = Object.freeze({ archive: 256 * 1024 * 1024, expanded: 512 * 1024 * 1024,
  file: 192 * 1024 * 1024, entries: 8192 });
const fail = message => { throw new Error('KIT_ARCHIVE_INVALID: ' + message); };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const zero = value => value.every(byte => byte === 0);
const CRC = new Uint32Array(256).map((_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
export function portableName(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || !/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('/')) fail('unsafe member name');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) fail('unsafe member name');
  return parts.join('/');
}
function checkedEntries(entries) {
  if (!entries.length || entries.length > ARCHIVE_LIMITS.entries) fail('member count');
  const names = new Map(); let total = 0;
  for (const entry of entries) {
    const canonical = portableName(entry.name); const key = canonical.toLowerCase();
    if (names.has(key)) fail('duplicate or case-colliding member');
    if (entry.directory && entry.data.length) fail('directory payload');
    if (entry.data.length > ARCHIVE_LIMITS.file || (total += entry.data.length) > ARCHIVE_LIMITS.expanded) fail('expanded size');
    if (entry.mode & 0o7000) fail('special permission bits');
    names.set(key, entry);
  }
  for (const [key] of names) {
    const parts = key.split('/');
    while (parts.pop(), parts.length) if (names.has(parts.join('/')) && !names.get(parts.join('/')).directory) fail('member below a file');
  }
  return entries;
}
function extent(buffer, start, length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > buffer.length) fail('truncated member');
  return buffer.subarray(start, start + length);
}
function string(bytes) {
  try { return utf8.decode(bytes); } catch { fail('invalid UTF-8'); }
}

/** ZIP32 only: store/deflate, regular files/directories, no encryption or descriptors. */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > ARCHIVE_LIMITS.archive || buffer.length < 22) fail('ZIP input size');
  const end = buffer.length - 22;
  if (buffer.readUInt32LE(end) !== 0x06054b50 || buffer.readUInt16LE(end + 20) !== 0 ||
    buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) fail('ZIP end record');
  const count = buffer.readUInt16LE(end + 10), centralSize = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (count !== buffer.readUInt16LE(end + 8) || !count || count > ARCHIVE_LIMITS.entries || start + centralSize !== end) fail('ZIP directory size');
  const entries = [], ranges = []; let offset = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    extent(buffer, offset, 46);
    if (buffer.readUInt32LE(offset) !== 0x02014b50) fail('ZIP central signature');
    const madeBy = buffer.readUInt16LE(offset + 4), needed = buffer.readUInt16LE(offset + 6), flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10), crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24), nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32), disk = buffer.readUInt16LE(offset + 34);
    const attributes = buffer.readUInt32LE(offset + 38), local = buffer.readUInt32LE(offset + 42);
    if (needed > 20 || (flags & ~0x0800) || ![0, 8].includes(method) || disk || extraLength || commentLength ||
      compressed > ARCHIVE_LIMITS.archive || size > ARCHIVE_LIMITS.file || (expanded += size) > ARCHIVE_LIMITS.expanded) fail('unsupported ZIP member');
    const nameBytes = extent(buffer, offset + 46, nameLength), name = string(nameBytes);
    portableName(name);
    const directory = name.endsWith('/');
    const unixMode = attributes >>> 16, type = unixMode & 0o170000;
    if (type && type !== (directory ? 0o040000 : 0o100000)) fail('nonregular ZIP member');
    if (!directory && (attributes & 0x10)) fail('ZIP directory mismatch');
    extent(buffer, local, 30);
    if (buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 4) !== needed ||
      buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method ||
      buffer.readUInt32LE(local + 14) !== crc || buffer.readUInt32LE(local + 18) !== compressed ||
      buffer.readUInt32LE(local + 22) !== size || buffer.readUInt16LE(local + 26) !== nameLength || buffer.readUInt16LE(local + 28) !== 0 ||
      !extent(buffer, local + 30, nameLength).equals(nameBytes)) fail('ZIP local/central mismatch');
    const payloadStart = local + 30 + nameLength, payload = extent(buffer, payloadStart, compressed);
    if (payloadStart + compressed > start) fail('ZIP overlaps directory');
    let data;
    try { data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload, { maxOutputLength: Math.max(1, size) }); }
    catch { fail('ZIP decompression'); }
    if (data.length !== size || crc32(data) !== crc) fail('ZIP content checksum');
    entries.push({ name, data, mode: unixMode ? unixMode & 0o7777 : directory ? 0o755 : 0o644, directory });
    ranges.push([local, payloadStart + compressed]);
    offset += 46 + nameLength;
  }
  if (offset !== end) fail('ZIP directory extent');
  ranges.sort((a, b) => a[0] - b[0]);
  let position = 0;
  for (const [from, to] of ranges) { if (from !== position) fail('ZIP overlapping or unaccounted data'); position = to; }
  if (position !== start) fail('ZIP local extent');
  return checkedEntries(entries);
}
const u16 = number => { const value = Buffer.alloc(2); value.writeUInt16LE(number); return value; };
const u32 = number => { const value = Buffer.alloc(4); value.writeUInt32LE(number >>> 0); return value; };
export function writeZip(input) {
  const entries = checkedEntries(input); const local = [], central = []; let offset = 0;
  for (const entry of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = Buffer.from(entry.name), deflated = deflateRawSync(entry.data, { level: 9 });
    const method = deflated.length < entry.data.length ? 8 : 0, payload = method ? deflated : entry.data, crc = crc32(entry.data);
    local.push(Buffer.concat([u32(0x04034b50), u16(20), u16(0x800), u16(method), u16(0), u16(0x5c21),
      u32(crc), u32(payload.length), u32(entry.data.length), u16(name.length), u16(0), name, payload]));
    const mode = (entry.directory ? 0o040000 : 0o100000) | entry.mode;
    central.push(Buffer.concat([u32(0x02014b50), u16(0x031e), u16(20), u16(0x800), u16(method), u16(0), u16(0x5c21),
      u32(crc), u32(payload.length), u32(entry.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32((mode << 16) | (entry.directory ? 0x10 : 0)), u32(offset), name]));
    offset += local.at(-1).length;
  }
  const centralSize = central.reduce((sum, value) => sum + value.length, 0);
  const result = Buffer.concat([...local, ...central, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralSize), u32(offset), u16(0)]);
  if (result.length > ARCHIVE_LIMITS.archive) fail('ZIP output size');
  return result;
}
const tarString = bytes => string(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
function octal(bytes) {
  const value = tarString(bytes).trim();
  if (!/^[0-7]*$/.test(value)) fail('TAR numeric field');
  const number = parseInt(value || '0', 8);
  if (!Number.isSafeInteger(number)) fail('TAR numeric bound');
  return number;
}
export function readTarGzip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > ARCHIVE_LIMITS.archive) fail('TAR input size');
  let tar;
  try { tar = gunzipSync(buffer, { maxOutputLength: ARCHIVE_LIMITS.expanded }); } catch { fail('TAR decompression'); }
  if (tar.length % 512 || tar.length < 1024) fail('TAR block size');
  const entries = []; let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = extent(tar, offset, 512);
    if (zero(header)) {
      if (tar.length - offset < 1024 || !zero(tar.subarray(offset))) fail('TAR trailer');
      return checkedEntries(entries);
    }
    if (entries.length >= ARCHIVE_LIMITS.entries) fail('TAR member count');
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (octal(header.subarray(148, 156)) !== checksum) fail('TAR header checksum');
    const magic = header.subarray(257, 263).toString('ascii');
    if (magic !== 'ustar\0' && magic !== 'ustar ') fail('TAR format');
    const prefix = magic === 'ustar\0' ? tarString(header.subarray(345, 500)) : '';
    const name = (prefix ? prefix + '/' : '') + tarString(header.subarray(0, 100)); portableName(name);
    const type = header[156], directory = type === 53;
    if (![0, 48, 53].includes(type) || (directory !== name.endsWith('/')) || !zero(header.subarray(157, 257))) fail('nonregular TAR member');
    const size = octal(header.subarray(124, 136)), mode = octal(header.subarray(100, 108));
    if (size > ARCHIVE_LIMITS.file) fail('TAR member size');
    entries.push({ name, data: Buffer.from(extent(tar, offset + 512, size)), mode: mode & 0o7777, directory });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  fail('TAR missing trailer');
}
function putOctal(header, offset, size, value) {
  const text = value.toString(8).padStart(size - 1, '0');
  if (text.length >= size) fail('TAR output numeric bound');
  header.write(text + '\0', offset, size, 'ascii');
}
export function writeTarGzip(input) {
  const entries = checkedEntries(input); const chunks = [];
  for (const entry of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const header = Buffer.alloc(512); let name = entry.name, prefix = '';
    if (name.length > 100) {
      const slash = name.lastIndexOf('/', entry.directory ? name.length - 2 : name.length - 1);
      prefix = name.slice(0, slash); name = name.slice(slash + 1);
      if (name.length > 100 || prefix.length > 155) fail('TAR output name length');
    }
    header.write(name, 0, 100, 'ascii'); putOctal(header, 100, 8, entry.mode); putOctal(header, 108, 8, 0); putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, entry.data.length); putOctal(header, 136, 12, 0);
    header.fill(32, 148, 156); header[156] = entry.directory ? 53 : 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii'); header.write('root', 265, 32, 'ascii'); header.write('root', 297, 32, 'ascii');
    header.write(prefix, 345, 155, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, entry.data, Buffer.alloc((512 - entry.data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const result = gzipSync(Buffer.concat(chunks), { level: 9 });
  if (result.length > ARCHIVE_LIMITS.archive) fail('TAR output size');
  return result;
}
