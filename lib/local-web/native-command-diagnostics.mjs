// Process-cleanup metadata only. No error text, cause, command, output or process rows.
const phases = new Set(['snapshot', 'stop']);
const kinds = new Set(['timeout', 'buffer', 'exit', 'signal', 'command', 'invalid-json', 'invalid-row']);
const codes = new Set(['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'EACCES', 'ENOENT', 'EPERM', 'EINVAL', 'ENOMEM', 'EBADF', 'EPIPE', 'ETIMEDOUT', 'ENOBUFS', 'EAGAIN', 'UNKNOWN']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT']);
const stopCodes = new Set(['STOP_SNAPSHOT_QUERY_FAILED', 'STOP_TREE_FAILED', 'STOP_METADATA_FAILED', 'STOP_ROOT_IDENTITY_CHANGED',
  'STOP_TREE_TIMEOUT', 'PTY_DRAIN_TIMEOUT', 'STOP_SYSTEMROOT_INVALID', 'STOP_INVALID_OWNED_PROCESS', 'STOP_SNAPSHOT_BUDGET_INVALID', 'STOP_UNKNOWN']);
const fields = ['phase', 'kind', 'elapsedMs', 'timeoutMs', 'code', 'signal', 'killed', 'stdoutBytes', 'stderrBytes'];
function dataRecord(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) return undefined;
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
export function sanitizeNativeCommand(value) {
  try {
    value = dataRecord(value, fields);
    if (!value || Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) return undefined;
    if (!phases.has(value.phase) || !kinds.has(value.kind) || !integer(value.elapsedMs, 0, 120000) || !integer(value.timeoutMs, 1, 5000) ||
      !(value.code === null || integer(value.code, -2147483648, 0xffffffff) || codes.has(value.code)) ||
      !(value.signal === null || signals.has(value.signal)) || typeof value.killed !== 'boolean' ||
      !integer(value.stdoutBytes, 0, 16 * 1024 * 1024) || !integer(value.stderrBytes, 0, 16 * 1024 * 1024)) return undefined;
    return Object.fromEntries(fields.map(key => [key, value[key]]));
  } catch { return undefined; }
}
export function sanitizeNativeStopFailure(value) {
  try {
    value = dataRecord(value, ['code', 'command']);
    if (!value || !stopCodes.has(value.code)) return undefined;
    const command = Object.hasOwn(value, 'command') ? sanitizeNativeCommand(value.command) : undefined;
    if (Object.hasOwn(value, 'command') && !command) return undefined;
    return { code: value.code, ...(command ? { command } : {}) };
  } catch { return undefined; }
}
export function nativeStopFailure(error) {
  try {
    const candidate = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? /^([A-Z0-9_]+)(?::|$)/.exec(error.message)?.[1] : undefined;
    const code = stopCodes.has(candidate) ? candidate : 'STOP_UNKNOWN', command = sanitizeNativeCommand(error?.diagnostics);
    return { code, ...(command ? { command } : {}) };
  } catch { return { code: 'STOP_UNKNOWN' }; }
}
