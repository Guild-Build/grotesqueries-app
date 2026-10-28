// Bounded, read-only PE32+ x64 inspection. Certificate entries use file offsets, not RVAs.
export function inspectWindowsPE(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const invalid = () => { throw new Error('WINDOWS_PE_INVALID'); };
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) invalid();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== 0x8664) invalid();
  const optional = pe + 24, size = bytes.readUInt16LE(pe + 20), sections = bytes.readUInt16LE(pe + 6);
  if (size < 152 || optional + size > bytes.length || bytes.readUInt16LE(optional) !== 0x20b || sections < 1 || sections > 96) invalid();
  const directories = bytes.readUInt32LE(optional + 108);
  if (directories < 5 || directories > Math.floor((size - 112) / 8)) invalid();
  const sectionTable = optional + size, headersEnd = sectionTable + sections * 40;
  if (headersEnd > bytes.length) invalid();
  let payloadEnd = headersEnd;
  for (let index = 0; index < sections; index++) {
    const entry = sectionTable + index * 40, rawSize = bytes.readUInt32LE(entry + 16), rawOffset = bytes.readUInt32LE(entry + 20);
    if (rawSize && (rawOffset < headersEnd || rawOffset + rawSize > bytes.length)) invalid();
    if (rawSize) payloadEnd = Math.max(payloadEnd, rawOffset + rawSize);
  }
  const certificateDirectoryOffset = optional + 112 + 4 * 8;
  return { certificateDirectoryOffset, certificateOffset: bytes.readUInt32LE(certificateDirectoryOffset),
    certificateSize: bytes.readUInt32LE(certificateDirectoryOffset + 4), checksumOffset: optional + 64, payloadEnd };
}

/** An artifact assertion only: this does not inspect Windows trust or installed catalog databases. */
export function assertNoEmbeddedAuthenticode(input) {
  const { certificateOffset, certificateSize } = inspectWindowsPE(input);
  if (certificateOffset !== 0 || certificateSize !== 0) throw new Error('WINDOWS_EMBEDDED_AUTHENTICODE_PRESENT');
}

/** Remove only a trailing certificate from a copied Node executable, never mutate the input. */
export function stripAuthenticodeSignature(input) {
  const bytes = Buffer.from(input);
  const { certificateDirectoryOffset, certificateOffset, certificateSize, checksumOffset, payloadEnd } = inspectWindowsPE(bytes);
  if (!certificateOffset && !certificateSize) return bytes;
  if (!certificateOffset || !certificateSize || certificateOffset % 8 || certificateOffset < payloadEnd || certificateOffset + certificateSize !== bytes.length) {
    throw new Error('WINDOWS_CERTIFICATE_LAYOUT_UNSUPPORTED');
  }
  bytes.fill(0, certificateDirectoryOffset, certificateDirectoryOffset + 8); bytes.writeUInt32LE(0, checksumOffset);
  return bytes.subarray(0, certificateOffset);
}
