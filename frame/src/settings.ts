import { decodeBootstrap, type Bootstrap, type SettingsDocument } from '@grotesqueries/protocol';
import { formatArguments, parseArguments } from './arguments.js';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** Editable host projection. A failed save keeps the draft and never pretends it was applied. */
export class SettingsEditor {
  private host?: Bootstrap;
  private document?: SettingsDocument;
  private busy = false;
  private route = '';
  constructor(private readonly changedHost: (host: Bootstrap, route: string) => void, private readonly saveFrame: () => void,
    private readonly close: () => void) {
    element('save-settings').onclick = () => { void this.save(false); };
    element('save-close-settings').onclick = () => { void this.save(true); };
    element('reload-settings').onclick = () => { void this.load(); };
  }
  updateHost(host: Bootstrap | undefined, route = ''): void {
    if (host?.hostInstanceId !== this.host?.hostInstanceId || route !== this.route) {
      this.document = undefined;
      element('host-settings-profiles').replaceChildren();
      this.status('Host changed. Open or Reload settings for this host.');
      this.buttons(this.busy);
    }
    this.host = host; this.route = route;
  }
  open(): void { if (!this.document) void this.load(); }
  private buttons(busy: boolean): void {
    this.busy = busy;
    for (const id of ['save-settings', 'save-close-settings']) element<HTMLButtonElement>(id).disabled = busy || !this.document;
    element<HTMLButtonElement>('reload-settings').disabled = busy;
  }
  private async request(method: 'GET' | 'PUT', body?: unknown): Promise<SettingsDocument> {
    if (!this.host) throw new Error('Host is not connected.');
    const response = await fetch(this.route + '/api/settings', { method, cache: 'no-store',
      headers: { 'x-automata-token': this.host.token, ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? 'Settings request failed.');
    return value as SettingsDocument;
  }
  async load(): Promise<void> {
    if (this.busy) return; this.buttons(true); const host = this.host?.hostInstanceId, route = this.route;
    try {
      const document = await this.request('GET'); if (host !== this.host?.hostInstanceId || route !== this.route) return;
      this.document = document; this.populate(); this.status(document.restartRequired ? 'Saved port differs from the listening port; restart required for port only.' : '');
    } catch (error) { this.status((error as Error).message); }
    finally { this.buttons(false); }
  }
  private status(text: string): void { element('settings-status').textContent = text; }
  private populate(): void {
    const saved = this.document!; const settings = saved.settings;
    element('settings-file').textContent = saved.file;
    element('allowed-directories').textContent = saved.allowedProjectDirectories.join(' · ');
    for (const [id, value] of [['setting-port', settings.port], ['setting-scrollback', settings.scrollbackLines],
      ['setting-replay', settings.recentOutputBytes / 1048576], ['setting-running', settings.maxRunningSessions], ['setting-views', settings.maxViews]] as const)
      element<HTMLInputElement>(id).value = String(value);
    element('host-settings-profiles').replaceChildren(...settings.profiles.map(profile => {
      const row = document.createElement('tr'); row.dataset.profileId = profile.id;
      const id = document.createElement('td'); id.textContent = profile.id; row.append(id);
      for (const [key, value] of [['label', profile.label], ['executable', profile.executable], ['args', formatArguments(profile.args)],
        ['projectDirectory', profile.projectDirectory], ['columns', profile.columns === null ? 'auto' : String(profile.columns)]] as const) {
        const cell = document.createElement('td'); const input = document.createElement('input'); input.value = value;
        input.dataset.field = key; input.setAttribute('aria-label', `${profile.id} ${key}`); input.autocomplete = 'off';
        if (key === 'columns') { input.className = 'short'; input.title = 'auto, or 20–300 pinned columns (host protocol bound)'; }
        if (key === 'args') input.title = 'Windows-style arguments; double quotes group spaces. No shell expansion.';
        cell.append(input); row.append(cell);
      }
      return row;
    }));
  }
  private async save(close: boolean): Promise<void> {
    if (this.busy || !this.document) return;
    this.buttons(true); const host = this.host?.hostInstanceId, route = this.route;
    try {
      const number = (id: string) => { const input = element<HTMLInputElement>(id); if (!input.reportValidity() || input.value.trim() === '') throw new Error('Correct the highlighted setting.'); return Number(input.value); };
      const settings = { ...this.document.settings, port: number('setting-port'), scrollbackLines: number('setting-scrollback'),
        recentOutputBytes: Math.round(number('setting-replay') * 1048576), maxRunningSessions: number('setting-running'), maxViews: number('setting-views'),
        profiles: [...element('host-settings-profiles').querySelectorAll<HTMLTableRowElement>('tr')].map(row => {
          const value = (key: string) => row.querySelector<HTMLInputElement>(`[data-field="${key}"]`)!.value;
          const columns = value('columns').trim();
          if (columns !== 'auto' && !/^\d+$/.test(columns)) throw new Error('Columns must be auto or an integer from 20 through 300.');
          return { id: row.dataset.profileId!, label: value('label'), executable: value('executable'), args: parseArguments(value('args')),
            projectDirectory: value('projectDirectory'), columns: columns === 'auto' ? null : Number(columns) };
        }) };
      for (const id of ['setting-left', 'setting-right']) number(id);
      const saved = await this.request('PUT', { revision: this.document.revision, settings });
      if (host !== this.host?.hostInstanceId || route !== this.route) throw new Error('Host changed while saving. Reload settings to confirm the result.');
      this.document = saved; this.populate(); this.saveFrame();
      this.status('Saved. New sessions use these settings; running sessions are unchanged.' + (saved.restartRequired ? ' Port applies after host restart.' : ''));
      try {
        const response = await fetch(route + '/api/bootstrap', { cache: 'no-store' }); if (!response.ok) throw new Error();
        const bootstrap = decodeBootstrap(await response.json());
        if (bootstrap.hostInstanceId !== host) throw new Error();
        if (route !== this.route) throw new Error();
        this.changedHost(bootstrap, route);
      } catch { this.status('Settings saved, but inventory refresh failed. Reconnect to see current profiles.'); return; }
      if (close) this.close();
    } catch (error) { this.status((error as Error).message); }
    finally { this.buttons(false); }
  }
}
