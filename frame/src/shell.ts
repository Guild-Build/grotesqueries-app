import type { Bootstrap } from '@grotesqueries/protocol';
import { DEFAULT_PREFERENCES, panelWidth, PREFERENCES_KEY, readPreferences, writePreferences, type Preferences } from './preferences.js';
import { SettingsEditor } from './settings.js';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Local presentation settings and a separate authenticated host-settings editor. Never owns a PTY. */
export class FrameShell {
  preferences: Preferences;
  settingsOpen = false;
  private settingsPresent = false;
  private zen = false;
  private storage?: Storage;
  private storageNotice = '';
  private readonly editor: SettingsEditor;
  constructor(private readonly changed: () => void, changedHost: (host: Bootstrap, route: string) => void) {
    try { this.storage = localStorage; this.preferences = readPreferences(this.storage.getItem(PREFERENCES_KEY)); }
    catch { this.preferences = { ...DEFAULT_PREFERENCES }; this.storageNotice = 'Browser preferences cannot be read; defaults are in use.'; }
    this.editor = new SettingsEditor(changedHost, () => {
      this.preferences.leftWidth = panelWidth(Number(element<HTMLInputElement>('setting-left').value), DEFAULT_PREFERENCES.leftWidth);
      this.preferences.rightWidth = panelWidth(Number(element<HTMLInputElement>('setting-right').value), DEFAULT_PREFERENCES.rightWidth);
      this.preferences.clickToControl = element<HTMLInputElement>('setting-click-control').checked;
      const shortcut = element<HTMLSelectElement>('setting-release-shortcut').value;
      this.preferences.releaseShortcut = shortcut === 'ctrl-alt-g' || shortcut === 'none' ? shortcut : 'escape';
      this.save();
    }, () => { this.settingsPresent = false; this.showSettings(false); });
    for (const [id, key] of [['toggle-sessions', 'sessions'], ['toggle-panel', 'panel']] as const) {
      element(id).onclick = () => { this.preferences[key] = this.zen || !this.preferences[key]; this.zen = false; this.save(); };
    }
    element('toggle-zen').onclick = () => { this.zen = !this.zen; this.update(); this.changed(); };
    for (const id of ['open-settings', 'settings-select']) element(id).onclick = () => this.showSettings(true);
    element('close-settings').onclick = () => { this.settingsPresent = false; this.showSettings(false); element('open-settings').focus(); };
    element<HTMLInputElement>('screen-reader').onchange = () => { this.preferences.screenReader = element<HTMLInputElement>('screen-reader').checked; this.save(); };
    this.resize('left-gutter', 'leftWidth', 1); this.resize('right-gutter', 'rightWidth', -1);
    this.update();
  }
  showSettings(open: boolean): void {
    if (open && !this.settingsOpen) {
      element<HTMLInputElement>('setting-left').value = String(this.preferences.leftWidth);
      element<HTMLInputElement>('setting-right').value = String(this.preferences.rightWidth);
      element<HTMLInputElement>('setting-click-control').checked = this.preferences.clickToControl;
      element<HTMLSelectElement>('setting-release-shortcut').value = this.preferences.releaseShortcut;
    }
    this.settingsOpen = open; if (open) { this.settingsPresent = true; this.editor.open(); }
    this.update(); this.changed();
  }
  showSession(): void { this.settingsOpen = false; this.update(); }
  private save(): void {
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      this.storage.setItem(PREFERENCES_KEY, writePreferences(this.preferences));
      this.storageNotice = 'Frame settings saved in this browser.';
    } catch { this.storageNotice = 'Frame settings apply for this page only; browser storage could not save them.'; }
    this.update(); this.changed();
  }
  private update(): void {
    const sessions = this.preferences.sessions && !this.zen, panel = this.preferences.panel && !this.zen;
    const root = element('frame'); root.classList.toggle('no-sessions', !sessions); root.classList.toggle('no-panel', !panel);
    root.style.setProperty('--side-width', this.preferences.leftWidth + 'vw');
    root.style.setProperty('--panel-width', this.preferences.rightWidth + 'vw');
    for (const [id, visible] of [['sessions-panel', sessions], ['left-gutter', sessions], ['panel-slot', panel], ['right-gutter', panel]] as const) element(id).hidden = !visible;
    for (const [id, enabled] of [['toggle-sessions', sessions], ['toggle-panel', panel], ['toggle-zen', this.zen], ['open-settings', this.settingsOpen]] as const) element(id).setAttribute('aria-pressed', String(enabled));
    element<HTMLInputElement>('screen-reader').checked = this.preferences.screenReader;
    element('session-view').hidden = this.settingsOpen; element('settings-view').hidden = !this.settingsOpen;
    element('settings-tab').hidden = !this.settingsPresent; element('settings-tab').setAttribute('aria-current', String(this.settingsOpen));
    element('preference-status').textContent = this.storageNotice;
    for (const [id, key] of [['left-gutter', 'leftWidth'], ['right-gutter', 'rightWidth']] as const) element(id).setAttribute('aria-valuenow', String(this.preferences[key]));
  }
  private resize(id: string, key: 'leftWidth' | 'rightWidth', direction: number): void {
    const gutter = element(id); let drag: { pointer: number; x: number; width: number } | undefined;
    gutter.onpointerdown = event => {
      if (event.button !== 0) return; event.preventDefault(); gutter.focus();
      drag = { pointer: event.pointerId, x: event.clientX, width: this.preferences[key] };
      gutter.setPointerCapture(event.pointerId); document.body.classList.add('resizing');
    };
    gutter.onpointermove = event => {
      if (!drag || drag.pointer !== event.pointerId) return;
      this.preferences[key] = panelWidth(drag.width + (event.clientX - drag.x) * direction * 100 / window.innerWidth, DEFAULT_PREFERENCES[key]); this.update();
    };
    const finish = () => { if (!drag) return; drag = undefined; document.body.classList.remove('resizing'); this.save(); };
    gutter.onpointerup = finish; gutter.onpointercancel = finish; gutter.onlostpointercapture = finish;
    gutter.ondblclick = () => {
      this.preferences[key] = key === 'leftWidth' ? panelWidth((Math.max(170, ...[...document.querySelectorAll<HTMLElement>('.session-row')].map(row => row.scrollWidth)) + 24) * 100 / window.innerWidth, 17) : DEFAULT_PREFERENCES[key];
      this.save();
    };
    gutter.onkeydown = event => {
      let next: number;
      if (event.key === 'Home') next = DEFAULT_PREFERENCES[key];
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = this.preferences[key] + (event.key === 'ArrowRight' ? 1 : -1) * direction;
      else return;
      event.preventDefault(); this.preferences[key] = panelWidth(next, DEFAULT_PREFERENCES[key]); this.save();
    };
  }
  updateHost(host: Bootstrap | undefined, _connected: boolean, route = ''): void { this.editor.updateHost(host, route); }
}
