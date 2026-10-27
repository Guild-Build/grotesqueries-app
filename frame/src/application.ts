import { decodeGuildBuild, type Bootstrap, type SessionSummary, type ServerMessage } from '@grotesqueries/protocol';
import { HostClient, type ConnectionState } from './client.js';
import { InputMarkerStore } from './input-markers.js';
import { InputSender } from './input.js';
import { RecentSessions, type RecentSession } from './state.js';
import { TerminalStreamView } from './terminal/stream.js';
import { FrameShell } from './shell.js';
import { renderGuildBuild } from './guild-build.js';
import { decodeFleet, readFleetSelection, splitTarget, type FleetHost } from './fleet.js';
import { activateTab, boundLine, closeTab, openTab, readSelection, refusedAtBound, writeSelection, type TabOrder } from './tabs.js';
import '@xterm/xterm/css/xterm.css';
import '../assets/stylesheets/application.css';
import '../assets/stylesheets/guild-build.css';

const app = document.querySelector<HTMLDivElement>('#app'); if (!app) throw new Error('Application root missing');
app.innerHTML = `
<div id="frame" class="shell">
  <header id="title-bar" class="title-bar"><span id="title-name" class="title-name">Automata</span><span id="title-instance" class="title-field" title="Host instance"></span><span id="title-protocol" class="title-field"></span><span id="title-address" class="title-field"></span>
    <div class="layout-actions"><button id="toggle-sessions" type="button" aria-controls="sessions-panel" aria-pressed="true">Sessions</button><button id="toggle-panel" type="button" aria-controls="panel-slot" aria-pressed="true">BuildGuild</button><button id="toggle-zen" type="button" aria-pressed="false">Zen</button><button id="open-settings" type="button" aria-controls="settings-view" aria-pressed="false">Settings</button></div></header>
  <aside id="sessions-panel" class="sidebar" aria-label="Sessions panel">
    <section id="panel-start" class="panel-section"><h1 class="panel-heading">Start</h1>
      <label id="host-picker-label" hidden>Host <select id="host-picker" aria-label="Host"></select></label><p id="fleet-status" class="small-note" hidden></p>
      <form id="start-form" class="launch-form"><select id="profile" aria-label="Launch profile"></select>
        <button id="start" type="submit" aria-label="Start session">Start</button><span id="profile-help" hidden></span></form></section>
    <section id="panel-sessions" class="panel-section panel-grow"><div class="section-heading"><h1 class="panel-heading">Sessions</h1><span id="session-count" class="count">0</span></div>
      <div id="sessions" class="session-list" aria-label="Sessions"></div></section>
    <section id="panel-pages" class="panel-section"><h1 class="panel-heading">Pages</h1><div id="pages" class="panel-list"></div>
      </section>
    <section id="panel-plugins" class="panel-section"><h1 class="panel-heading">Plugins</h1><div id="plugins" class="panel-list"></div></section>
  </aside>
  <div id="left-gutter" class="gutter" role="separator" tabindex="0" aria-label="Resize sessions panel" aria-orientation="vertical" aria-controls="sessions-panel" aria-valuemin="3" aria-valuemax="40" title="Drag or use arrows; double-click to fit content, Home to reset"></div>
  <main class="workspace">
    <div class="tabs-bar"><nav id="tab-strip" class="tab-strip" aria-label="Tabs"></nav><div id="settings-tab" class="tab" hidden><button id="settings-select" type="button">Settings</button><button id="close-settings" type="button" aria-label="Close settings">×</button></div></div>
    <div id="notice" class="notice" role="status" hidden></div>
    <div id="uncertainties" class="uncertainties" aria-label="Input delivery records"></div>
    <div id="session-view" class="session-view">
    <div id="toolbar" class="toolbar" hidden><div class="view-status"><span id="process-state" class="state-badge"></span><span id="view-mode" class="mode-badge">Observing</span></div>
      <div class="actions"><button id="attach" type="button">Retry attachment</button><button id="take" class="primary" type="button">Take control</button><button id="release" type="button">Release control</button><button id="copy" type="button" title="Copy selection (Ctrl+Shift+C)">Copy</button><button id="paste" type="button" title="Paste clipboard (Ctrl+Shift+V)">Paste</button><button id="stop" class="danger" type="button">Stop process</button></div></div>
    <section id="empty" class="empty-state"><span class="empty-mark" aria-hidden="true">&gt;_</span><p class="eyebrow">A WINDOW INTO YOUR WORK</p><h3>A place for your sessions.</h3><p id="empty-message">Start a configured profile, or select a session to observe its terminal.</p></section>
    <section id="terminal-scroll" class="terminal-scroll" aria-label="Terminal workspace" hidden><div id="terminal" class="terminal-host"></div></section>
    <details id="details" class="session-details" hidden><summary>Session details</summary><dl id="metadata"></dl><a id="another-view" target="_blank" rel="noopener">Open another view</a></details>
    </div>
    <section id="settings-view" class="settings-view" aria-label="Settings" hidden>
      <h2>Settings</h2><p class="small-note">Save writes <span id="settings-file">the host configuration</span>. Profiles and limits apply to new sessions; running sessions stay untouched. Only the port waits for the next host start. Frame settings stay in this browser.</p>
      <h4>Frame</h4><table><thead><tr><th>sessions panel, % of window</th><th>panel slot, % of window</th></tr></thead><tbody><tr>
        <td><input id="setting-left" class="short" type="number" min="3" max="40" step="0.1" required aria-label="Sessions panel percent"></td>
        <td><input id="setting-right" class="short" type="number" min="3" max="40" step="0.1" required aria-label="Panel slot percent"></td></tr></tbody></table>
      <div class="settings-actions"><label><input id="setting-click-control" type="checkbox"> Left-click terminal to take control</label>
        <label>Release shortcut <select id="setting-release-shortcut"><option value="escape">Escape</option><option value="ctrl-alt-g">Ctrl+Alt+G</option><option value="none">None (button only)</option></select></label></div>
      <p class="small-note">The release shortcut is consumed by the browser, not sent to the CLI. Choose Ctrl+Alt+G or None if your CLI needs Escape. Selection drags do not take control.</p>
      <h4>Host</h4><div class="table-scroll"><table><thead><tr><th>port</th><th>scrollback lines</th><th>replay per session, MiB</th><th>running sessions</th><th>views</th></tr></thead><tbody><tr>
        <td><input id="setting-port" class="short" type="number" min="1" max="65535" required aria-label="Port"></td>
        <td><input id="setting-scrollback" class="short" type="number" min="0" max="100000" required aria-label="Scrollback lines"></td>
        <td><input id="setting-replay" class="short" type="number" min="0.0009765625" max="64" step="any" required aria-label="Replay MiB"></td>
        <td><input id="setting-running" class="short" type="number" min="1" max="32" required aria-label="Running sessions limit"></td>
        <td><input id="setting-views" class="short" type="number" min="2" max="64" required aria-label="Views limit"></td></tr></tbody></table></div>
      <h4>Profiles</h4><div class="table-scroll"><table class="profiles-table"><thead><tr><th>id</th><th>label</th><th>executable</th><th>arguments</th><th>project directory</th><th>columns</th></tr></thead><tbody id="host-settings-profiles"></tbody></table></div>
      <details class="settings-help"><summary>Launch directory and columns</summary><p>Project directories must exist within: <span id="allowed-directories"></span>. Edit the host allowlist deliberately to authorize other roots. Columns: auto, or 20–300 pinned (current protocol limit). Plugin profiles remain owned by their plugins.</p></details>
      <div class="settings-actions"><button id="save-close-settings" class="primary" type="button" disabled>Save and close</button><button id="save-settings" type="button" disabled>Save</button><button id="reload-settings" type="button">Reload</button></div>
      <p id="settings-status" class="small-note" role="status"></p><p id="preference-status" class="small-note" role="status"></p>
    </section>
  </main>
  <div id="right-gutter" class="gutter" role="separator" tabindex="0" aria-label="Resize panel slot" aria-orientation="vertical" aria-controls="panel-slot" aria-valuemin="3" aria-valuemax="40" title="Drag or use arrow keys to resize; double-click or Home to reset"></div>
  <aside id="panel-slot" class="panel-slot" aria-label="BuildGuild build and tools"></aside>
  <footer id="status-bar" class="status-bar"><span class="host-state"><span id="status-dot" class="status-dot"></span><span id="host-status" role="status">Connecting to host…</span><button id="retry" class="text-button" type="button">Retry</button></span><span id="workspace-state">No session selected</span><span id="grid" class="grid-label"></span><span id="history-state">Host owns process lifetime.</span><span id="input-state">Views open in observation mode.</span><label class="accessibility-option"><input id="screen-reader" type="checkbox"> Screen reader mode</label></footer>
</div>
<dialog id="stop-dialog"><form method="dialog"><p class="eyebrow">PROCESS LIFETIME</p><h3>Stop this process?</h3><p id="stop-description"></p><p>Stop attempts to end this session’s tracked processes. The retained terminal stays available for inspection.</p><div class="dialog-actions"><button value="cancel">Cancel</button><button id="confirm-stop" value="stop" class="danger">Stop process</button></div></form></dialog>`;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const select = element<HTMLSelectElement>('profile');
/**
 * Requirement 4.2.2: a tab is one view on the host, with its own HostClient, TerminalStreamView and InputSender, its own
 * viewId and its own attachment. Its terminal is mounted in its own host element, hidden by CSS while another tab is active.
 */
interface Tab {
  key: string; owner: HostState; hostInstanceId: string; sessionId: string; host: HTMLDivElement;
  client?: HostClient; stream?: TerminalStreamView; input?: InputSender; leaseId?: string;
  attached: boolean; generation: number; connection: ConnectionState; notice: string;
  bootstrapAnswered: boolean; everConnected: boolean; maxViews?: number;
  taking?: boolean; releasing?: boolean; releaseAfterTake?: boolean;
}
interface HostState {
  id: string; label: string; route: string; online: boolean; actions: string[];
  bootstrap?: Bootstrap; inventory: Map<string, SessionSummary>; connection: ConnectionState;
  client?: HostClient; recent?: RecentSessions;
}
let fleetMode = false; let discovering = false;
const hosts = new Map<string, HostState>();
let selectedHost: HostState = { id: 'local', label: 'Local host', route: '', online: true,
  actions: ['observe', 'start', 'control', 'stop', 'settings'], inventory: new Map(), connection: 'connecting' };
hosts.set('local', selectedHost);
let bootstrap: Bootstrap | undefined;
let guildBuildRequest = 0;
let connection: ConnectionState = 'connecting'; let pageNotice = ''; let starting = false; let restored = false;
const tabs = new Map<string, Tab>(); let order: TabOrder = { sessions: [] };
let markers: InputMarkerStore | undefined; let storageProblem = '';
try {
  markers = new InputMarkerStore(localStorage, sessionStorage); selectedHost.recent = new RecentSessions(localStorage);
  order = readSelection(sessionStorage.getItem('gq.selection'));
} catch { storageProblem = 'Browser storage is unavailable. Observation works; input is paused until storage is allowed.'; }
const layout = new FrameShell(() => {
  for (const tab of tabs.values()) tab.stream?.setAccessibility(layout.preferences.screenReader);
  render();
}, (value, route) => { const owner = [...hosts.values()].find(host => host.route === route); if (owner) applyBootstrap(value, owner); });

// The sessions panel's own socket (4.2.2): bootstrap, inventory, session messages and Start. It attaches no session.
function panelClient(owner: HostState): HostClient {
  return owner.client = new HostClient({ bootstrap: value => applyBootstrap(value, owner), message: message => receive(message, owner), status: (state, detail) => {
  owner.connection = state;
  if (owner === selectedHost) {
    connection = state; element('host-status').textContent = detail; element('status-dot').classList.toggle('offline', state !== 'connected');
    if (owner.bootstrap) layout.updateHost(owner.bootstrap, state === 'connected', owner.route);
  }
  if (state === 'connected' && !restored && (fleetMode || bootstrap)) { restored = true; restoreTabs(); }
  renderSidebar(); render();
} }, owner.route);
}
let client = panelClient(selectedHost);
function selectHost(owner: HostState): void {
  selectedHost = owner; bootstrap = owner.bootstrap; connection = owner.connection;
  client = owner.client ?? panelClient(owner);
  element<HTMLSelectElement>('host-picker').value = owner.id;
  element('host-status').textContent = connection === 'connected' ? 'Host connected' : 'Host unavailable';
  element('status-dot').classList.toggle('offline', connection !== 'connected');
  if (bootstrap) showBootstrap(bootstrap); else { select.replaceChildren(); element('title-instance').textContent = owner.label; layout.updateHost(undefined, false, owner.route); }
  renderSidebar(); render();
}
const targetKey = (owner: HostState, instance: string, id: string) => fleetMode ? `${owner.id}/${instance}/${id}` : id;
const active = (): Tab | undefined => order.active ? tabs.get(order.active) : undefined;
function show(tab: Tab | undefined, message: string): void { if (tab) tab.notice = message; else pageNotice = message; render(); }
function session(tab: Tab | undefined): SessionSummary | undefined { return tab && tab.owner.online && tab.hostInstanceId === tab.owner.bootstrap?.hostInstanceId ? tab.owner.inventory.get(tab.sessionId) : undefined; }
function remembered(tab: Tab | undefined): RecentSession | undefined { return tab && tab.owner.recent?.load().find(entry => entry.hostInstanceId === tab.hostInstanceId && entry.session.id === tab.sessionId); }
function remember(owner = selectedHost): void {
  if (!owner.recent || !owner.bootstrap) return;
  try { owner.recent.remember(owner.bootstrap.hostInstanceId, [...owner.inventory.values()]); } catch { storageProblem = 'Recent-session storage failed. Input markers still require a successful write before input.'; }
}
function saveOrder(): void {
  try { sessionStorage.setItem(fleetMode ? 'gq.fleet.selection' : 'gq.selection', writeSelection({ ...order, hostInstanceId: bootstrap?.hostInstanceId ?? order.hostInstanceId })); }
  catch { storageProblem = 'Selection storage failed. Human input requires working browser storage.'; }
}
function applyBootstrap(value: Bootstrap, owner = selectedHost): void {
  if (owner.bootstrap && owner.bootstrap.hostInstanceId !== value.hostInstanceId) {
    pageNotice = 'Host restarted. Previous sessions are unavailable; no process was relaunched.';
    for (const tab of tabs.values()) if (tab.owner === owner && tab.hostInstanceId !== value.hostInstanceId) unavailable(tab);
  }
  owner.bootstrap = value; owner.inventory = new Map(value.sessions.map(item => [item.id, item]));
  if (owner === selectedHost) { bootstrap = value; showBootstrap(value); }
  for (const tab of tabs.values()) if (tab.owner === owner && tab.hostInstanceId === value.hostInstanceId && !tab.client && owner.inventory.has(tab.sessionId)) connectTab(tab);
  remember(owner); renderSidebar(); render();
}
function showBootstrap(value: Bootstrap): void {
  // Requirement 4.1.2: each profile's kind beside its label, and its plugin's name when a plugin names it (story 42).
  select.replaceChildren(...value.profiles.map(profile => { const option = document.createElement('option'); option.value = profile.id;
    const plugin = value.plugins.find(item => item.profiles.includes(profile.id) || item.commands.includes(profile.id));
    option.textContent = `${profile.label}${plugin ? ' · ' + plugin.name : ''}${profile.kind === 'job' ? ' · job' : ''}`; return option; }));
  if (!value.profiles.length) { const option = document.createElement('option'); option.textContent = 'No profiles configured'; select.append(option); }
  element('title-instance').textContent = (fleetMode ? selectedHost.label + ' · ' : 'host ') + value.hostInstanceId.slice(0, 4) + '…' + value.hostInstanceId.slice(-4);
  element('title-instance').title = value.hostInstanceId; element('title-protocol').textContent = 'protocol ' + value.protocol;
  layout.updateHost(value, connection === 'connected', selectedHost.route);
  profileHelp(); renderPlugins();
}
/** Requirement 4.2.6: the stored tabs come back on reload, then the hash route opens or activates one, as the selection did. */
function restoreTabs(): void {
  if (!fleetMode && !bootstrap) return;
  const stored = order; order = { sessions: [] };
  for (const key of stored.sessions) {
    const target = fleetMode ? splitTarget(key) : undefined;
    const owner = target ? hosts.get(target.worker) : selectedHost; if (!owner) continue;
    order = openTab(order, key); mount(target?.session ?? key, target?.instance ?? stored.hostInstanceId ?? bootstrap!.hostInstanceId, owner);
  }
  order = stored.active ? activateTab(order, stored.active) : order;
  followHash();
  saveOrder(); renderSidebar(); render();
}
/** Requirement 4.1.2: Pages, inert, one row per plugin page; Plugins, one row per plugin with its contract. */
function renderPlugins(): void {
  void updateGuildBuild();
  const row = (label: string, detail: string) => { const item = document.createElement('div'); item.className = 'panel-row';
    const name = document.createElement('span'); name.textContent = label; const note = document.createElement('span'); note.className = 'row-id'; note.textContent = detail;
    item.append(name, note); return item; };
  const plugins = bootstrap?.plugins ?? [];
  element('pages').replaceChildren(...plugins.flatMap(plugin => plugin.pages.map(page => row(page.label, plugin.name))));
  element('plugins').replaceChildren(...plugins.map(plugin => row(plugin.name, 'contract ' + plugin.contract)));
  if (!element('pages').childElementCount) element('pages').append(row('none: no plugin loaded', ''));
  if (!plugins.length) element('plugins').append(row('0 loaded', ''));
}
async function updateGuildBuild(): Promise<void> {
  const request = ++guildBuildRequest;
  const value = bootstrap; const owner = selectedHost;
  if (!value) { renderGuildBuild(element('panel-slot'), null, 'Build information is unavailable while the host is disconnected.'); return; }
  renderGuildBuild(element('panel-slot'), null, 'Checking this installation’s build information…');
  try {
    const response = await fetch(owner.route + '/api/guild-build', { headers: { 'x-automata-token': value.token }, cache: 'no-store' });
    if (!response.ok) throw new Error('Build information unavailable.');
    const result = decodeGuildBuild(await response.json());
    if (request === guildBuildRequest && selectedHost === owner && bootstrap === value) renderGuildBuild(element('panel-slot'), result.guildBuild);
  } catch {
    if (request === guildBuildRequest && selectedHost === owner && bootstrap === value) {
      renderGuildBuild(element('panel-slot'), null, 'This host has no readable build information. Browse the catalog or update the host to use preconfigured builds.');
    }
  }
}
/** The panel's messages: inventory and session rows. Each tab reads its own socket's control, input and stream messages. */
function receive(message: ServerMessage, owner = selectedHost): void {
  if (message.type === 'inventory') {
    const next = new Map(message.sessions.map(item => [item.id, item]));
    for (const previous of owner.inventory.values()) if (!next.has(previous.id) && previous.processState === 'exited') {
      try { owner.recent?.dismiss(owner.bootstrap!.hostInstanceId, previous.id); } catch { /* Show any storage failure on explicit dismissal. */ }
    }
    owner.inventory = next; remember(owner); renderSidebar();
  }
  if (message.type === 'session') { owner.inventory.set(message.session.id, message.session); remember(owner); renderSidebar(); }
  if (message.type === 'error' && message.requestId === undefined && !message.sessionId) pageNotice = message.message;
  for (const tab of tabs.values()) reconcile(tab);
  render();
}
/** A tab's session left the inventory or exited: its lease and pending input end, as for the one selection before. */
function reconcile(tab: Tab): void {
  if (tab.hostInstanceId !== tab.owner.bootstrap?.hostInstanceId || !tab.client) return;
  const item = session(tab);
  if (!item) { tab.input?.lose('Session unavailable. Pending delivery records remain for inspection.'); tab.leaseId = undefined; tab.attached = false; tab.stream?.freeze(); }
  if (item?.processState === 'exited') {
    if (item.failureCode !== 'STOP_FAILED') tab.leaseId = undefined;
    tab.input?.lose('Process exited; pending delivery records remain for inspection.');
  }
}
function receiveTab(tab: Tab, message: ServerMessage): void {
  if (message.type === 'control' && message.sessionId === tab.sessionId) {
    if (message.controllerViewId === tab.client?.viewId && message.leaseId) { tab.leaseId = message.leaseId;
      if (tab.releaseAfterTake) void releaseControl(tab);
      else if (!tab.releasing) tab.input?.activate(tab.hostInstanceId, message.sessionId, message.leaseId, fleetMode ? tab.owner.id : undefined); }
    else { tab.input?.lose('Control was released with pending input. Delivery is uncertain; inspect before repeating it.'); tab.leaseId = undefined; }
  }
  if (message.type === 'input-ack') tab.input?.acknowledge(message);
  if (message.type === 'error') {
    // Correlated requests belong to their scoped Promise handlers. An old result cannot freeze a replacement or another session.
    if (message.requestId !== undefined || (message.sessionId && message.sessionId !== tab.sessionId)) return;
    if (message.inputId !== undefined && !tab.input?.reject(message)) return;
    tab.notice = message.message;
    if (message.code === 'RESTORE_FAILED' || message.code === 'RESTORE_TIMEOUT' || message.code === 'RESTORATION_LIMIT') { tab.attached = false; tab.stream?.freeze(); }
  }
  // Requirement 4.2.3: a hidden tab's stream accepts its messages and sends its credits as the active one's does.
  if (['output', 'grid', 'snapshot-begin', 'snapshot-chunk', 'snapshot-end', 'snapshot-cancel'].includes(message.type)) {
    tab.stream?.accept(message as Parameters<TerminalStreamView['accept']>[0]); return;
  }
  reconcile(tab); render();
}
/** A tab's terminal host and, when its session is live on this host, its own socket. Not yet in the strip. */
function mount(sessionId: string, hostInstanceId: string, owner = selectedHost): Tab {
  const key = targetKey(owner, hostInstanceId, sessionId); const existing = tabs.get(key); if (existing) return existing;
  const host = document.createElement('div'); host.className = 'terminal-host tab-view'; host.dataset.sessionId = sessionId; host.hidden = true;
  element('terminal').append(host);
  const tab: Tab = { key, owner, hostInstanceId, sessionId, host, attached: false, generation: 0, connection: 'unavailable', notice: '',
    bootstrapAnswered: false, everConnected: false };
  tabs.set(key, tab);
  if (owner.online && hostInstanceId === owner.bootstrap?.hostInstanceId && owner.inventory.has(sessionId)) connectTab(tab);
  return tab;
}
function connectTab(tab: Tab): void {
  const view: HostClient = tab.client = new HostClient({
    bootstrap: value => {
      tab.bootstrapAnswered = true; tab.maxViews = value.limits.capacity.maxViews; tab.leaseId = undefined;
      // A restarted host: the session is gone; HostClient goes on to open its socket, so the close waits a microtask.
      if (value.hostInstanceId !== tab.hostInstanceId) { queueMicrotask(() => { unavailable(tab); render(); }); return; }
      if (markers) tab.input = new InputSender({ markers, limits: value.limits, send: message => view.send(message), changed: render });
    },
    message: message => receiveTab(tab, message),
    status: state => {
      tab.connection = state;
      // Ledger 0.5(1): refused at the bound. One line, the tab's client closed (after lost() has armed its retry), not added.
      if (refusedAtBound(tab, state)) { pageNotice = boundLine(tab.maxViews ?? tab.owner.bootstrap?.limits.capacity.maxViews ?? 0); queueMicrotask(() => drop(tab)); render(); return; }
      if (state !== 'connected') { tab.generation++; tab.input?.lose('Connection lost. Input delivery is uncertain; inspect the terminal before new input.'); tab.leaseId = undefined; tab.attached = false; tab.stream?.freeze(); }
      else {
        if (!tab.everConnected) { tab.everConnected = true; if (!order.sessions.includes(tab.key)) { order = openTab(order, tab.key); saveOrder(); } }
        if (session(tab)) void attach(tab);
      }
      renderSidebar(); render();
    } }, tab.owner.route);
  void view.connect();
}
/** A tab whose session the host no longer has: no socket, no stream, kept in the strip as unavailable. */
function unavailable(tab: Tab): void {
  tab.client?.close(); tab.client = undefined; tab.generation++;
  tab.input?.lose('Previous session unavailable. Inspect retained delivery records.'); tab.leaseId = undefined; tab.attached = false;
  tab.stream?.dispose(); tab.stream = undefined; tab.connection = 'unavailable';
}
/** Requirement 4.2.4: closing a tab closes its socket; the host detaches that view and revokes its lease. Nothing else is sent. */
function drop(tab: Tab): void {
  tab.client?.close(); tab.input?.lose('View closed with pending input. Delivery is uncertain; inspect before repeating it.');
  tab.stream?.dispose(); tab.host.remove(); tabs.delete(tab.key);
  order = closeTab(order, tab.key); saveOrder(); renderSidebar(); render();
}
/** Requirement 4.2.1: open a session's tab or activate its open tab. A new tab joins the strip once its socket connects. */
function open(sessionId: string, hostInstanceId = bootstrap?.hostInstanceId, owner = selectedHost): void {
  if (!hostInstanceId) return;
  layout.showSession();
  pageNotice = '';
  const key = targetKey(owner, hostInstanceId, sessionId); selectHost(owner);
  if (order.sessions.includes(key)) order = activateTab(order, key);
  else {
    const tab = mount(sessionId, hostInstanceId, owner);
    if (!tab.client) order = openTab(order, key);
  }
  saveOrder(); renderSidebar(); render();
}
async function attach(tab: Tab): Promise<void> {
  const bootstrap = tab.owner.bootstrap;
  const view = tab.client; const item = session(tab);
  if (!bootstrap || !view?.connected || !item || tab.attached) return;
  const round = ++tab.generation; const sessionId = tab.sessionId;
  let restorationRound = 1;
  const initialAttachRound = restorationRound;
  let restorationNotice = false;
  tab.input?.lose('View detached with pending input. Delivery is uncertain; inspect before repeating it.'); tab.leaseId = undefined;
  tab.stream?.dispose(); tab.attached = true; tab.notice = '';
  const limits = { ...bootstrap.limits, terminal: { ...bootstrap.limits.terminal, scrollbackLines: item.scrollbackLines ?? bootstrap.limits.terminal.scrollbackLines } };
  const stream: TerminalStreamView = tab.stream = new TerminalStreamView(tab.host, { sessionId, cols: item.cols, rows: item.rows, fixedCols: item.fixedCols, limits,
    send: message => view.send(message), changed: () => {
      if (round !== tab.generation) return;
      if (stream.ready && restorationNotice) { restorationNotice = false; tab.notice = ''; }
      render();
    }, input: data => { if (!tab.releasing && !tab.releaseAfterTake) tab.input?.submit(data); },
    resize: (cols, rows) => { if (tab.leaseId) void sessionAction(tab, { type: 'resize', sessionId, leaseId: tab.leaseId, cols, rows }); },
    resync: reason => { if (round !== tab.generation) return;
      const currentRestore = ++restorationRound;
      void view.request({ type: 'resync', sessionId, sequence: stream.sequence, reason }).catch(error => {
        if (round === tab.generation && restorationRound === currentRestore && !stream.ready) { tab.attached = false; show(tab, error.message); }
      }); },
    problem: message => { if (round === tab.generation) { restorationNotice = true; show(tab, message); } } });
  stream.setAccessibility(element<HTMLInputElement>('screen-reader').checked);
  render();
  try { await view.request({ type: 'attach', sessionId }); } catch (error) {
    if (round === tab.generation && restorationRound === initialAttachRound && !stream.ready) { tab.attached = false; show(tab, (error as Error).message); }
  }
}
function profileHelp(): void {
  element('profile-help').textContent = bootstrap?.profiles.length ? 'Start opens a new process. Select an existing session to reattach.' : 'Add a direct executable profile to grotesqueries.json and restart the host.';
}
function renderSidebar(): void {
  const list = element('sessions'); const shown = active();
  element('session-count').textContent = String([...hosts.values()].reduce((sum, owner) => sum + owner.inventory.size, 0));
  list.replaceChildren();
  for (const owner of hosts.values()) {
  const current = [...owner.inventory.values()];
  const old = owner.recent?.load().filter(entry => entry.hostInstanceId !== owner.bootstrap?.hostInstanceId || !owner.inventory.has(entry.session.id)) ?? [];
  const rows = [...current.map(item => ({ item, instance: owner.bootstrap!.hostInstanceId, available: owner.online })), ...old.map(entry => ({ item: entry.session, instance: entry.hostInstanceId, available: false }))];
  if (fleetMode) { const heading = document.createElement('button'); heading.type = 'button'; heading.className = 'host-group'; heading.dataset.workerId = owner.id;
    heading.textContent = `${owner.label} · ${owner.id} · ${owner.online ? 'online' : 'offline'}`; heading.onclick = () => selectHost(owner); list.append(heading); }
  if (!rows.length) { const text = document.createElement('p'); text.className = 'session-empty'; text.textContent = 'No sessions yet.'; list.append(text); }
  for (const { item, instance, available } of rows) {
    const row = document.createElement('div'); row.className = 'session-row'; row.dataset.sessionId = item.id;
    const key = targetKey(owner, instance, item.id); row.dataset.workerId = owner.id; row.dataset.target = key;
    row.setAttribute('aria-current', String(shown?.key === key));
    const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'session-select';
    choose.title = `${item.projectDirectory}\n${item.id}`; choose.setAttribute('aria-label', 'Open ' + item.label);
    const dot = document.createElement('span'); dot.className = 'session-dot ' + (available ? item.processState : 'unavailable');
    const title = document.createElement('span'); title.className = 'session-label'; title.textContent = item.label;
    const plugin = owner.bootstrap?.plugins.find(plugin => [...plugin.profiles, ...plugin.commands].includes(item.profileId));
    const tag = document.createElement('span'); tag.className = 'profile-tag'; tag.textContent = plugin?.name ?? 'core';
    const state = document.createElement('span'); state.className = 'row-state ' + (available ? item.processState : 'unavailable');
    state.textContent = !available ? 'unavailable' : item.stopPending ? 'stopping' : item.processState === 'exited' ? `exited ${item.exitCode ?? '?'}`
      : item.controllerViewId ? (tabs.get(key)?.leaseId ? 'controlling' : 'controlled') : 'observing';
    choose.append(dot, title, tag, state); choose.onclick = () => open(item.id, instance, owner); row.append(choose);
    const job = owner.bootstrap?.profiles.find(profile => profile.id === item.profileId)?.kind === 'job';
    const forget = !available || item.processState === 'exited' && !item.stopPending && item.failureCode !== 'STOP_FAILED';
    if (forget || available && !job) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'session-remove'; remove.textContent = '×';
      remove.title = (forget ? 'Forget ' : 'Stop ') + item.label; remove.setAttribute('aria-label', remove.title);
      remove.disabled = !!item.stopPending;
      remove.onclick = () => { if (forget) void forgetSession(item.id, instance, available, owner); else { open(item.id, instance, owner); requestStop(tabs.get(key)); } };
      row.append(remove);
    }
    list.append(row);
  }
  }
}
async function forgetSession(id: string, instance: string, available: boolean, owner = selectedHost): Promise<void> {
  try {
    if (available) {
      const response = await fetch(owner.route + '/api/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'x-automata-token': owner.bootstrap!.token } });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Session could not be forgotten.');
    }
    if (owner.bootstrap?.hostInstanceId === instance) owner.inventory.delete(id);
    owner.recent?.dismiss(instance, id);
    const tab = tabs.get(targetKey(owner, instance, id)); if (tab?.hostInstanceId === instance) drop(tab);
    renderSidebar(); render();
  } catch (error) { show(active(), (error as Error).message); }
}
/** Requirement 4.2.1: one tab per open session, with its label, its process state and a close mark. */
let tabStrip = '';
function renderTabs(shown: Tab | undefined): void {
  // J8-S3-F1: rebuilt only when what it shows changes; a rebuild on every render() replaced a tab under the pointer.
  const label = (sessionId: string) => { const tab = tabs.get(sessionId); return (fleetMode && tab ? tab.owner.label + ' · ' : '') + (session(tab)?.label ?? remembered(tab)?.session.label ?? 'Session unavailable'); };
  const signature = JSON.stringify([shown?.key, order.sessions.map(sessionId => [sessionId, label(sessionId), session(tabs.get(sessionId))?.processState])]);
  if (signature === tabStrip) return; tabStrip = signature;
  element('tab-strip').replaceChildren(...order.sessions.map(sessionId => {
    const tab = tabs.get(sessionId); const item = session(tab); const name = document.createElement('span'); name.textContent = label(sessionId);
    const strip = document.createElement('div'); strip.className = 'tab'; strip.dataset.sessionId = tab?.sessionId ?? sessionId; strip.dataset.target = sessionId; strip.setAttribute('aria-current', String(tab === shown));
    const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'tab-select';
    const state = document.createElement('span'); state.className = 'row-state ' + (item?.processState ?? 'unavailable'); state.textContent = item?.processState ?? 'unavailable';
    choose.append(name, state); choose.onclick = () => { layout.showSession(); order = activateTab(order, sessionId); if (tab) selectHost(tab.owner); saveOrder(); renderSidebar(); render(); };
    const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close'; close.textContent = '×';
    close.setAttribute('aria-label', 'Close tab ' + label(sessionId)); close.onclick = () => { const current = tabs.get(sessionId); if (current) drop(current); };
    strip.append(choose, close); return strip;
  }));
}
function renderWarnings(): void {
  const region = element('uncertainties'); region.replaceChildren();
  try {
    // Every open tab's own live epoch is not a warning; only records no tab of this page is still delivering.
    const live = new Set([...tabs.values()].map(tab => tab.input?.activeMarkerKey));
    const unresolved = markers?.loadUnresolved().filter(marker => !live.has(marker.key)) ?? [];
    for (const marker of unresolved.slice(0, 64)) {
      const row = document.createElement('div'); row.className = 'delivery-record';
      const text = document.createElement('span'); text.textContent = `Input delivery uncertain${marker.workerId ? ' · worker ' + marker.workerId : ''} · session ${marker.sessionId.slice(0, 8)} · view ${marker.documentId.slice(0, 8)} · ${marker.count} input item${marker.count === 1 ? '' : 's'}. Inspect before repeating.`;
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss this record';
      dismiss.onclick = () => { try { markers!.dismiss(marker.key); renderWarnings(); } catch { show(active(), 'Delivery record storage failed. The marker remains.'); } };
      row.append(text, dismiss); region.append(row);
    }
    if (unresolved.length > 64) { const text = document.createElement('p'); text.textContent = `${unresolved.length - 64} additional unresolved records remain stored.`; region.append(text); }
  } catch { storageProblem = 'Delivery record storage cannot be read. Human input is paused.'; }
}
/** Requirement 4.2.6: the toolbar, status bar and notices read the active tab. */
function render(): void {
  const tab = active(); const item = session(tab); const old = remembered(tab); const display = item ?? old?.session;
  const stream = tab?.stream; const input = tab?.input;
  const cleanup = item?.failureCode === 'STOP_FAILED';
  const controlling = !!tab?.leaseId && !!item && (item.processState === 'running' || cleanup) && !!tab.client?.connected;
  const inputReady = controlling && !tab?.releasing && !tab?.releaseAfterTake && item?.processState === 'running' && !!input?.usable && !!stream?.ready && !storageProblem.includes('cannot be read');
  for (const each of tabs.values()) {
    each.host.hidden = each !== tab || layout.settingsOpen;
    // J8-S2-L1: a hidden tab is observing, so its renderer never fits its display: none host or sends a resize; it keeps
    // its lease, and fits to its pane again when shown (view.ts:40-45).
    each.stream?.setMode(each === tab && !layout.settingsOpen && inputReady ? 'controlling' : 'observing');
  }
  button('start').disabled = starting || connection !== 'connected' || !selectedHost.online || !selectedHost.actions.includes('start') || !bootstrap?.profiles.length;
  button('retry').hidden = connection === 'connected'; select.disabled = starting || !bootstrap?.profiles.length;
  element('toolbar').hidden = !tab; element('details').hidden = !tab;
  element('empty').hidden = !!stream && !!item; element('terminal-scroll').hidden = !stream || !item;
  renderTabs(layout.settingsOpen ? undefined : tab);
  // Requirement 4.1.5: a job is observed only; its tab offers no Take control, Release, Paste or Stop (decision 6).
  const job = !!item && tab?.owner.bootstrap?.profiles.find(profile => profile.id === item.profileId)?.kind === 'job';
  element('process-state').textContent = item?.stopPending ? 'Stop pending' : item?.processState ?? 'Unavailable';
  element('view-mode').textContent = job ? 'Job, observing' : controlling ? cleanup && item?.processState === 'exited' ? 'Controlling cleanup' : inputReady ? 'Controlling' : 'Input paused' : item?.controllerViewId ? 'Observing · another view controls' : 'Observing';
  element('view-mode').classList.toggle('controlling', inputReady);
  // Requirement 4.1.4, decision 8: whose grid it is, in the status bar, only while the session is live and someone controls it.
  element('grid').textContent = item?.processState !== 'running' ? '' : controlling ? `${item.cols}×${item.rows}, your grid`
    : item.controllerViewId ? `${item.cols}×${item.rows}, controller's grid` : '';
  button('take').hidden = controlling || job; button('release').hidden = !controlling || job; button('paste').hidden = job; button('stop').hidden = job;
  button('take').disabled = !tab?.owner.actions.includes('control') || !item || item.processState !== 'running' && !cleanup || !stream?.ready || tab?.connection !== 'connected' || !!item.stopPending;
  button('release').disabled = !controlling;
  button('take').disabled ||= !!tab?.taking || !!tab?.releasing;
  button('release').disabled ||= !!tab?.releasing;
  button('release').title = layout.preferences.releaseShortcut === 'none' ? 'Release control; the process keeps running'
    : `Release control (${layout.preferences.releaseShortcut === 'escape' ? 'Escape' : 'Ctrl+Alt+G'}); the process keeps running`;
  button('stop').disabled = !controlling || !tab?.owner.actions.includes('stop') || !!item?.stopPending; button('paste').disabled = !inputReady; button('copy').disabled = !stream?.ready;
  button('stop').textContent = cleanup ? 'Retry Stop' : 'Stop process';
  button('attach').hidden = !item || !!tab?.attached; button('attach').disabled = tab?.connection !== 'connected';
  element('workspace-state').textContent = item ? stream?.ready ? `${item.label} · ${item.id.slice(0, 8)}` : 'Restoring terminal…' : tab ? 'Unavailable · previous host or evicted session' : 'No session selected';
  element('history-state').textContent = stream?.historyIncomplete || stream?.historyReason ? `History incomplete${stream.historyReason ? ' · ' + stream.historyReason : ''}. Current screen is retained.` : 'Host owns process lifetime.';
  element('input-state').textContent = input?.pendingCount ? `${input.pendingCount} input receipt${input.pendingCount === 1 ? '' : 's'} pending` : inputReady ? 'Ctrl+C interrupts · Ctrl+Shift+C copies' : 'Views open in observation mode.';
  element('empty-message').textContent = tab && !item ? 'This session is unavailable. A restarted host does not relaunch previous processes. Start a profile deliberately to begin new work.' : 'Start a configured profile, or select a session to observe its terminal.';
  const limitedCleanup = item?.failureCode === 'CLEANUP_SCOPE_LIMITED';
  const sessionNotice = item?.failureCode && !limitedCleanup ? `Session failure: ${item.failureCode}. Inspect and Stop deliberately.` : '';
  const message = [input?.problem ?? (storageProblem || tab?.notice || pageNotice || sessionNotice), limitedCleanup
    ? 'Native alpha: Stop verifies tracked processes only. A daemon that detaches before it is observed may remain running.' : ''].filter(Boolean).join(' ');
  element('notice').hidden = !message; element('notice').textContent = message;
  const details = element('metadata'); details.replaceChildren();
  for (const [label, value] of [['Session ID', tab?.sessionId], ['Profile', display?.profileId], ['Created', display?.createdAt],
    ['Process', item?.processState ?? 'Unavailable'], ['Exit code', item?.exitCode ?? '—'], ['Attached views', item?.attachedViews ?? 0],
    ['Agent state', 'Unknown'], ['Provider conversation ID', item?.providerConversationId ?? 'Not available'], ['Host instance', tab?.hostInstanceId],
    ...(fleetMode ? [['Worker', tab?.owner.id], ['Native harness adapter', 'To be implemented'], ['Radio', 'External — to be implemented']] : [])]) {
    const dt = document.createElement('dt'); dt.textContent = String(label); const dd = document.createElement('dd'); dd.textContent = String(value ?? '—'); details.append(dt, dd);
  }
  const link = element<HTMLAnchorElement>('another-view'); link.href = '/#' + (tab?.key ?? ''); link.hidden = !item;
  renderWarnings();
}
element<HTMLFormElement>('start-form').onsubmit = event => {
  event.preventDefault(); if (starting || !client.connected || !select.value) return;
  const owner = selectedHost, target = client, instance = owner.bootstrap!.hostInstanceId;
  starting = true; pageNotice = ''; render();
  void target.request({ type: 'start', profileId: select.value, cols: 120, rows: 40 }).then(message => {
    if (message.type !== 'start-result' || owner.bootstrap?.hostInstanceId !== instance) return;
    owner.inventory.set(message.session.id, message.session); remember(owner); open(message.session.id, instance, owner);
  }).catch(error => show(undefined, error.message)).finally(() => { starting = false; render(); });
};
function sessionAction(tab: Tab, message: Parameters<HostClient['request']>[0], focus = false): Promise<void> {
  const round = tab.generation; const view = tab.client;
  if (!view) return Promise.resolve();
  return view.request(message).then(() => { if (round === tab.generation && focus) tab.stream?.focus(); })
    .catch(error => { if (round === tab.generation) show(tab, error.message); });
}
async function takeControl(tab: Tab): Promise<void> {
  if (tab.taking || tab.releasing || tab.leaseId || active() !== tab || layout.settingsOpen || button('take').disabled) return;
  const round = tab.generation; tab.taking = true; tab.releaseAfterTake = false; render();
  try {
    await tab.client!.request({ type: 'take-control', sessionId: tab.sessionId });
    if (round === tab.generation && active() === tab && !layout.settingsOpen && !tab.releaseAfterTake && !tab.releasing && tab.leaseId) tab.stream?.focus();
  } catch (error) { if (round === tab.generation) show(tab, (error as Error).message); }
  finally { tab.taking = false; if (!tab.leaseId && !tab.releasing) tab.releaseAfterTake = false; render(); }
}
async function releaseControl(tab: Tab): Promise<void> {
  if (tab.releasing) return;
  if (tab.taking && !tab.leaseId) { tab.releaseAfterTake = true; render(); return; }
  const view = tab.client, leaseId = tab.leaseId, round = tab.generation;
  if (!view || !leaseId) return;
  tab.releasing = true;
  tab.input?.lose('Control released with pending input. Delivery is uncertain; inspect before repeating it.'); render();
  try { await view.request({ type: 'release-control', sessionId: tab.sessionId, leaseId }); }
  catch (error) {
    if (round === tab.generation) { show(tab, `Release could not be confirmed: ${(error as Error).message}. Reconnecting as observer.`); void view.connect(true); }
  } finally { tab.releasing = false; tab.releaseAfterTake = false; render(); }
}
function installControlGestures(): void {
  const surface = element('terminal-scroll');
  let down: { id: number; x: number; y: number; tab: Tab } | undefined; let clicked: Tab | undefined;
  const plain = (event: MouseEvent) => !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0;
  surface.addEventListener('pointerdown', event => {
    const tab = active(); clicked = undefined;
    down = tab && event.isTrusted && plain(event) && event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY, tab } : undefined;
  }, true);
  surface.addEventListener('pointerup', event => {
    clicked = down && down.id === event.pointerId && plain(event) && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 4 ? down.tab : undefined;
    down = undefined;
  }, true);
  surface.addEventListener('pointermove', event => {
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) down = undefined;
  }, true);
  surface.addEventListener('pointercancel', () => { down = undefined; clicked = undefined; }, true);
  surface.addEventListener('click', event => {
    const tab = clicked; clicked = undefined;
    if (!tab || !event.isTrusted || !plain(event) || !layout.preferences.clickToControl || active() !== tab || layout.settingsOpen ||
      !(event.target instanceof Element) ||
      session(tab)?.processState !== 'running' || button('take').hidden) return;
    // The viewport's blank surface is still terminal, including beside a pinned grid.
    // Native/overlay scrollbar gutters are navigation, not an acquisition gesture.
    const viewport = event.target.closest<HTMLElement>('.xterm-viewport, .terminal-scroll');
    if (viewport) {
      const rect = viewport.getBoundingClientRect();
      if (viewport.scrollHeight > viewport.clientHeight && event.clientX >= rect.right - Math.max(8, rect.width - viewport.clientWidth) ||
        viewport.scrollWidth > viewport.clientWidth && event.clientY >= rect.bottom - Math.max(8, rect.height - viewport.clientHeight)) return;
    }
    void takeControl(tab);
  }, true);
  surface.addEventListener('keydown', event => {
    const tab = active();
    if (!tab || !event.isTrusted || event.isComposing || event.keyCode === 229 || layout.settingsOpen ||
      (!tab.leaseId && !tab.taking && !tab.releasing)) return;
    const shortcut = layout.preferences.releaseShortcut;
    const matches = shortcut === 'escape' ? event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
      : shortcut === 'ctrl-alt-g' && event.code === 'KeyG' && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && !event.getModifierState('AltGraph');
    if (!matches) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat) void releaseControl(tab);
  }, true);
}
installControlGestures();
button('take').onclick = () => { const tab = active(); if (tab) void takeControl(tab); };
button('release').onclick = () => { const tab = active(); if (tab) void releaseControl(tab); };
button('attach').onclick = () => { const tab = active(); if (tab) void attach(tab); };
button('retry').onclick = () => { void discover(); void client.connect(true);
  for (const tab of tabs.values()) if (tab.owner === selectedHost && tab.hostInstanceId === selectedHost.bootstrap?.hostInstanceId && tab.connection !== 'connected') void tab.client?.connect(true); };
button('copy').onclick = () => { void active()?.stream?.copy().catch(() => show(active(), 'Clipboard copy failed. Select text and use the browser copy command.')); };
button('paste').onclick = () => { void active()?.stream?.paste().catch(() => show(active(), 'Clipboard paste permission unavailable. Use the browser paste command.')); };
const dialog = element<HTMLDialogElement>('stop-dialog'); let stopTarget: { tab: Tab; sessionId: string; leaseId?: string } | undefined;
function requestStop(tab: Tab | undefined): void {
  if (!tab || dialog.open) return;
  stopTarget = { tab, sessionId: tab.sessionId, leaseId: tab.leaseId };
  element('stop-description').textContent = `${session(tab)?.label ?? 'Session'} · ${tab.sessionId.slice(0, 8)}` +
    (tab.leaseId ? '' : '. Control will be requested; another controller will not be displaced.');
  dialog.returnValue = ''; dialog.showModal();
}
async function confirmedStop(target: NonNullable<typeof stopTarget>): Promise<void> {
  const { tab, sessionId } = target;
  try {
    // A row may open a new view. Wait only for that explicitly requested attachment; never launch or force control.
    const until = Date.now() + 10000;
    while (!tab.stream?.ready || !tab.client?.connected) {
      if (Date.now() > until || tabs.get(tab.key) !== tab || !session(tab)) throw new Error('Session is not ready to stop. Reattach and retry.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const client = tab.client; const generation = tab.generation;
    let leaseId = target.leaseId;
    if (!leaseId) {
      await client.request({ type: 'take-control', sessionId });
      if (tab.client !== client || tab.generation !== generation || tabs.get(tab.key) !== tab) throw new Error('View changed; Stop was not sent.');
      leaseId = tab.leaseId;
    }
    if (!leaseId) throw new Error('Control is required to stop this process.');
    await client.request({ type: 'stop', sessionId, leaseId });
  } catch (error) { show(tab, (error as Error).message); }
}
button('stop').onclick = () => requestStop(active());
dialog.onclose = () => { const target = stopTarget; stopTarget = undefined; if (dialog.returnValue === 'stop' && target) void confirmedStop(target); };
setInterval(() => { for (const tab of tabs.values()) tab.input?.tick(); }, 500);
let pendingHash = location.hash.slice(1);
function followHash(): void {
  const key = pendingHash; if (!key) return;
  const target = fleetMode ? splitTarget(key) : undefined;
  const owner = target ? hosts.get(target.worker) : selectedHost;
  if (owner?.online && owner.bootstrap && (!target || target.instance === owner.bootstrap.hostInstanceId) && owner.inventory.has(target?.session ?? key))
    { pendingHash = ''; open(target?.session ?? key, owner.bootstrap.hostInstanceId, owner); }
}
window.addEventListener('hashchange', () => { pendingHash = location.hash.slice(1); followHash(); });
element<HTMLSelectElement>('host-picker').onchange = event => { const owner = hosts.get((event.target as HTMLSelectElement).value); if (owner) selectHost(owner); };
function applyCatalogHost(value: FleetHost): void {
  let owner = hosts.get(value.id);
  if (!owner) {
    owner = { id: value.id, label: value.label, route: value.route ?? '', online: false, actions: value.actions, inventory: new Map(), connection: 'unavailable' };
    try { owner.recent = new RecentSessions(localStorage, 'gq.recent.fleet.' + value.id); } catch { /* Existing storage warning remains authoritative. */ }
    hosts.set(value.id, owner);
  }
  const wasOnline = owner.online; const changed = !!value.route && owner.route !== value.route;
  owner.label = value.label; owner.actions = value.actions; owner.online = value.online;
  if (changed) {
    owner.client?.close(); owner.client = undefined; owner.bootstrap = undefined; owner.inventory = new Map(); owner.route = value.route!;
    for (const tab of tabs.values()) if (tab.owner === owner) unavailable(tab);
    if (owner === selectedHost) { bootstrap = undefined; select.replaceChildren(); layout.updateHost(undefined, false, owner.route); }
  }
  if (!value.online) owner.connection = 'unavailable';
  if (value.online && (changed || !wasOnline || !owner.client)) {
    if (!owner.client) panelClient(owner); void owner.client!.connect(true);
    for (const tab of tabs.values()) if (tab.owner === owner && tab.client && tab.connection !== 'connected') void tab.client.connect(true);
  }
  // A tab may reconnect before the slower catalog poll marks its host online.
  // Finish observation restoration when that fence clears; never reacquire control.
  if (value.online) for (const tab of tabs.values())
    if (tab.owner === owner && tab.client?.connected && session(tab) && !tab.attached) void attach(tab);
}
async function discover(): Promise<void> {
  if (discovering) return; discovering = true;
  try {
    const response = await fetch('/api/fleet', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.status === 404 && !fleetMode) { void client.connect(); return; }
    if (!response.ok) throw new Error('Fleet coordinator is unavailable.');
    const catalog = decodeFleet(await response.json());
    if (!fleetMode) {
      fleetMode = true; client.close(); hosts.clear();
      try { order = readFleetSelection(sessionStorage.getItem('gq.fleet.selection')); } catch { order = { sessions: [] }; }
      element('host-picker-label').hidden = false; element('fleet-status').hidden = false;
    }
    for (const host of catalog.hosts) applyCatalogHost(host);
    for (const [id, owner] of hosts) if (!catalog.hosts.some(host => host.id === id)) {
      owner.online = false; owner.connection = 'unavailable'; owner.client?.close();
      for (const tab of tabs.values()) if (tab.owner === owner) unavailable(tab);
      hosts.delete(id); // Old tabs retain their unavailable owner; current admissions do not retain removed hosts.
    }
    element('fleet-status').textContent = catalog.developmentAccept ? 'Development admission · loopback only' : 'Public-key worker admission';
    const picker = element<HTMLSelectElement>('host-picker'); picker.replaceChildren(...[...hosts.values()].map(owner => {
      const option = document.createElement('option'); option.value = owner.id; option.textContent = `${owner.label} · ${owner.id}${owner.online ? '' : ' · offline'}`; return option;
    }));
    const current = hosts.get(selectedHost.id) ?? hosts.values().next().value;
    if (current) {
      // Polling inventory must not overwrite a human's selected profile or settings draft.
      if (current !== selectedHost) selectHost(current);
      else { bootstrap = current.bootstrap; connection = current.connection; client = current.client ?? panelClient(current); picker.value = current.id; }
    } else {
      bootstrap = undefined; connection = 'unavailable'; select.replaceChildren();
      layout.updateHost(undefined, false, ''); renderPlugins();
      element('title-instance').textContent = 'No admitted hosts';
      element('host-status').textContent = 'No admitted hosts'; element('status-dot').classList.add('offline');
      pageNotice = 'No workers admitted. Configure the coordinator before joining workers.';
    }
    followHash(); renderSidebar(); render();
  } catch (error) {
    pageNotice = (error as Error).message;
    if (fleetMode) { for (const owner of hosts.values()) { owner.online = false; owner.connection = 'unavailable'; } connection = 'unavailable'; }
    renderSidebar(); render();
  } finally { discovering = false; }
}
element('title-address').textContent = location.host;
render(); void discover(); setInterval(() => { if (fleetMode) void discover(); }, 2000);
