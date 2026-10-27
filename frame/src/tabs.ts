/** The open tabs of one page and which one is active: the pure part of requirement 4.2, with no socket or DOM. */
export interface TabOrder { hostInstanceId?: string; sessions: string[]; active?: string }

/** Requirement 4.2.1: open a session's tab, or activate it if one is open. */
export function openTab(order: TabOrder, sessionId: string): TabOrder {
  return { ...order, sessions: order.sessions.includes(sessionId) ? order.sessions : [...order.sessions, sessionId], active: sessionId };
}
export function activateTab(order: TabOrder, sessionId: string): TabOrder {
  return order.sessions.includes(sessionId) ? { ...order, active: sessionId } : order;
}
/** Closing the active tab activates its right neighbour, else its left one, else none. */
export function closeTab(order: TabOrder, sessionId: string): TabOrder {
  const index = order.sessions.indexOf(sessionId); if (index === -1) return order;
  const sessions = order.sessions.filter(id => id !== sessionId);
  const active = order.active !== sessionId ? order.active : sessions[index] ?? sessions[index - 1];
  return { ...order, sessions, active };
}
/** Ledger 0.5(1): the one line for a tab the host refused; `maxViews` is bootstrap's `limits.capacity.maxViews`. */
export function boundLine(maxViews: number): string {
  return `The host refused this tab's connection: its view bound is ${maxViews} (this page's panel counts), or the host closed it; close a tab, or Retry`;
}
/**
 * Ledger 0.5(1): a new tab whose bootstrap answered and whose socket then closed before it ever connected was refused at
 * the bound. A tab that once connected and then lost its socket is reconnecting, not refused.
 */
export function refusedAtBound(tab: { bootstrapAnswered: boolean; everConnected: boolean }, state: string): boolean {
  return tab.bootstrapAnswered && !tab.everConnected && (state === 'reconnecting' || state === 'unavailable');
}
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/**
 * Requirement 4.2.6: `gq.selection` holds the open tabs and the active one. Job file 7.8(e): a job 7 value
 * `{ hostInstanceId, sessionId }` reads as one open tab, active. Anything else reads as no tabs.
 */
export function readSelection(raw: string | null): TabOrder {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (typeof value?.hostInstanceId !== 'string' || !uuid.test(value.hostInstanceId)) return { sessions: [] };
    if (typeof value.sessionId === 'string' && uuid.test(value.sessionId)) return { hostInstanceId: value.hostInstanceId, sessions: [value.sessionId], active: value.sessionId };
    const sessions = Array.isArray(value.sessions) ? [...new Set<string>(value.sessions.filter((id: unknown) => typeof id === 'string' && uuid.test(id)))].slice(0, 64) : [];
    return { hostInstanceId: value.hostInstanceId, sessions, active: sessions.includes(value.active) ? value.active : sessions[0] };
  } catch { return { sessions: [] }; }
}
export function writeSelection(order: TabOrder): string {
  return JSON.stringify({ hostInstanceId: order.hostInstanceId, sessions: order.sessions, active: order.active });
}
