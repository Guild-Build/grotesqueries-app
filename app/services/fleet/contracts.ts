import { decodeBootstrap, PROTOCOL_VERSION, type Bootstrap } from '@grotesqueries/protocol';
import type { WebSocket } from 'ws';

export const FLEET_VERSION = 1;
export const MAX_FRAME = 8 * 1024 * 1024;
export const MAX_QUEUE = 16 * 1024 * 1024;
export type Action = 'observe' | 'start' | 'control' | 'stop' | 'settings';
export const ACTIONS: readonly Action[] = ['observe', 'start', 'control', 'stop', 'settings'];
export interface Admission { id: string; label: string; publicKey?: string; actions?: readonly Action[] }
export type PublicBootstrap = Omit<Bootstrap, 'token'>;
export type Envelope =
  | { type: 'join'; version: number; workerId: string; instanceId: string }
  | { type: 'challenge'; nonce: string }
  | { type: 'proof'; signature: string }
  | { type: 'accepted' }
  | { type: 'inventory'; bootstrap: PublicBootstrap }
  | { type: 'open'; channelId: string; instanceId: string }
  | { type: 'frame'; channelId: string; data: string }
  | { type: 'close'; channelId: string }
  | { type: 'request'; requestId: string; instanceId: string; method: 'GET' | 'PUT' | 'DELETE'; path: string; body: string }
  | { type: 'response'; requestId: string; status: number; body: string };

export function identity(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
export function uuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value); }
export function publicBootstrap(value: unknown): PublicBootstrap {
  const result = decodeBootstrap(value);
  if (result.protocol !== PROTOCOL_VERSION) throw new Error('FLEET_PROTOCOL_MISMATCH');
  const { token: _credential, ...safe } = result; return safe;
}
export function decodeEnvelope(raw: string): Envelope {
  if (Buffer.byteLength(raw) > MAX_FRAME) throw new Error('FLEET_FRAME_LIMIT');
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FLEET_INVALID_MESSAGE');
  const fields: Record<string, string[]> = { join: ['version', 'workerId', 'instanceId'], challenge: ['nonce'], proof: ['signature'], accepted: [],
    inventory: ['bootstrap'], open: ['channelId', 'instanceId'], frame: ['channelId', 'data'], close: ['channelId'],
    request: ['requestId', 'instanceId', 'method', 'path', 'body'], response: ['requestId', 'status', 'body'] };
  if (typeof value.type !== 'string' || !Object.hasOwn(fields, value.type)) throw new Error('FLEET_INVALID_MESSAGE');
  const expected = ['type', ...fields[value.type]];
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error('FLEET_INVALID_FIELDS');
  for (const key of ['channelId', 'instanceId', 'requestId']) if (key in value && !uuid(value[key])) throw new Error('FLEET_INVALID_ID');
  if ('workerId' in value && !identity(value.workerId)) throw new Error('FLEET_INVALID_ID');
  if ('version' in value && value.version !== FLEET_VERSION) throw new Error('FLEET_PROTOCOL_MISMATCH');
  for (const key of ['nonce', 'signature', 'data', 'path', 'body']) if (key in value && typeof value[key] !== 'string') throw new Error('FLEET_INVALID_TEXT');
  if ('nonce' in value && !/^[a-f0-9]{64}$/.test(value.nonce as string)) throw new Error('FLEET_INVALID_NONCE');
  if ('signature' in value && (value.signature as string).length > 256) throw new Error('FLEET_INVALID_SIGNATURE');
  if ('status' in value && (!Number.isInteger(value.status) || Number(value.status) < 200 || Number(value.status) > 599)) throw new Error('FLEET_INVALID_STATUS');
  if ('method' in value && !['GET', 'PUT', 'DELETE'].includes(String(value.method))) throw new Error('FLEET_INVALID_METHOD');
  if ('path' in value && !httpRoute(String(value.method), String(value.path))) throw new Error('FLEET_INVALID_ROUTE');
  if (value.type === 'inventory') {
    if (!value.bootstrap || typeof value.bootstrap !== 'object' || Object.hasOwn(value.bootstrap, 'token')) throw new Error('FLEET_PRIVATE_BOOTSTRAP');
    publicBootstrap({ ...value.bootstrap, token: 'validation-only-not-a-credential' });
  }
  return value as unknown as Envelope;
}
export function send(socket: WebSocket, message: Envelope): void {
  const text = JSON.stringify(message);
  if (socket.readyState !== 1 || Buffer.byteLength(text) > MAX_FRAME || socket.bufferedAmount + Buffer.byteLength(text) > MAX_QUEUE) throw new Error('FLEET_BACKPRESSURE');
  socket.send(text);
}
export function proofText(nonce: string, workerId: string, instanceId: string): Buffer {
  return Buffer.from(`automata-fleet:${FLEET_VERSION}\n${nonce}\n${workerId}\n${instanceId}`, 'utf8');
}
export function httpRoute(method: string, path: string): Action | undefined {
  if (method === 'GET' && ['/api/bootstrap', '/health'].includes(path)) return 'observe';
  if ((method === 'GET' || method === 'PUT') && path === '/api/settings') return 'settings';
  if (method === 'DELETE' && path.startsWith('/api/sessions/') && uuid(path.slice('/api/sessions/'.length))) return 'stop';
  return undefined;
}
export function actionForFrame(raw: string): Action {
  const value = JSON.parse(raw) as { type?: unknown };
  if (value.type === 'start') return 'start';
  if (value.type === 'stop') return 'stop';
  if (['take-control', 'release-control', 'input', 'resize'].includes(String(value.type))) return 'control';
  if (['ready', 'attach', 'detach', 'resync', 'snapshot-applied', 'applied', 'ping'].includes(String(value.type))) return 'observe';
  throw new Error('FLEET_INVALID_ACTION');
}
