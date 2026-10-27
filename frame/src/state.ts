import type { SessionSummary } from '@grotesqueries/protocol';
import type { StorageLike } from './input-markers.js';
export interface RecentSession { hostInstanceId: string; session: SessionSummary }
/** Display metadata only; remembered rows never launch or grant authority. */
export class RecentSessions {
  constructor(private readonly storage: StorageLike, private readonly key = 'gq.recent') {}
  load(): RecentSession[] {
    try {
      const value = JSON.parse(this.storage.getItem(this.key) ?? '[]');
      if (!Array.isArray(value)) return [];
      return value.slice(0, 16).filter(entry => typeof entry.hostInstanceId === 'string' && typeof entry.session?.id === 'string' &&
        typeof entry.session?.label === 'string' && entry.session.label.length <= 256 && typeof entry.session?.projectDirectory === 'string' &&
        entry.session.projectDirectory.length <= 4096 && typeof entry.session?.profileId === 'string');
    } catch { return []; }
  }
  remember(hostInstanceId: string, sessions: SessionSummary[]): void {
    const fresh = sessions.map(session => ({ hostInstanceId, session: { ...session, controllerViewId: null, attachedViews: 0,
      providerConversationId: null } }));
    const old = this.load().filter(entry => !fresh.some(item => item.hostInstanceId === entry.hostInstanceId && item.session.id === entry.session.id));
    this.storage.setItem(this.key, JSON.stringify([...fresh, ...old].slice(0, 16)));
  }
  dismiss(hostInstanceId: string, sessionId: string): void {
    this.storage.setItem(this.key, JSON.stringify(this.load().filter(entry => entry.hostInstanceId !== hostInstanceId || entry.session.id !== sessionId)));
  }
}
