/**
 * Shell — the command rail, the view router, and the connection status pill.
 *
 * The six views all exist in the DOM; navigating swaps which one is visible
 * rather than stacking slide-overs. `onNavigate` tells the caller which view was
 * entered and whether the user asked for it (a click) or the app drove it
 * (activity auto-switch), which is what releases the auto-drive.
 */

export type ViewId = 'chat' | 'history' | 'watches' | 'tasks' | 'activity' | 'settings';

export type NavSource = 'user' | 'auto';

const TITLES: Record<ViewId, string> = {
  chat: 'WorkerKing',
  history: 'History',
  watches: 'Watches',
  tasks: 'Tasks',
  activity: 'Activity',
  settings: 'Settings',
};

export class Shell {
  private readonly navs = new Map<ViewId, HTMLElement>();
  private readonly views = new Map<ViewId, HTMLElement>();
  private readonly listeners = new Set<(id: ViewId, source: NavSource) => void>();
  private readonly titleEl: HTMLElement | null;
  private readonly statusEl: HTMLElement | null;
  private readonly statusText: HTMLElement | null;
  private readonly statusPop: HTMLElement | null;
  private readonly statusHead: HTMLElement | null;
  private current: ViewId = 'chat';

  constructor(private readonly root: Document | HTMLElement = document) {
    this.titleEl = this.q('#view-title');
    this.statusEl = this.q('#status');
    this.statusText = this.q('#status-text');
    this.statusPop = this.q('#status-pop');
    this.statusHead = this.q('#status-head');

    this.root.querySelectorAll<HTMLElement>('[data-nav]').forEach((btn) => {
      const id = btn.dataset['nav'] as ViewId;
      this.navs.set(id, btn);
      btn.addEventListener('click', () => this.setView(id, 'user'));
    });
    this.root.querySelectorAll<HTMLElement>('[data-view]').forEach((section) => {
      this.views.set(section.dataset['view'] as ViewId, section);
    });
    // In-content links to a view (e.g. the composer disclaimer → Activity).
    this.root.querySelectorAll<HTMLElement>('[data-nav-link]').forEach((link) => {
      link.addEventListener('click', () => this.setView(link.dataset['navLink'] as ViewId, 'user'));
    });

    this.q('#status-pill')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.statusPop?.classList.toggle('status__pop--open');
    });
    document.addEventListener('click', (e) => {
      if (!this.statusEl?.contains(e.target as Node)) this.closeStatus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeStatus();
    });

    this.setView('chat', 'auto');
  }

  private q<T extends HTMLElement>(selector: string): T | null {
    return this.root.querySelector<T>(selector);
  }

  /** The currently visible view. */
  get view(): ViewId {
    return this.current;
  }

  setView(id: ViewId, source: NavSource = 'user'): void {
    if (!this.views.has(id)) return;
    this.current = id;
    for (const [key, section] of this.views) section.classList.toggle('view--active', key === id);
    for (const [key, btn] of this.navs) btn.classList.toggle('nav--active', key === id);
    if (this.titleEl) this.titleEl.textContent = TITLES[id];
    this.closeStatus();
    for (const cb of this.listeners) cb(id, source);
  }

  /** Fired on every view change, including the app-driven ones. */
  onNavigate(cb: (id: ViewId, source: NavSource) => void): void {
    this.listeners.add(cb);
  }

  /** Rail count pill; 0 hides it. */
  setBadge(id: ViewId, count: number): void {
    const badge = this.navs.get(id)?.querySelector<HTMLElement>('.nav__badge');
    if (!badge) return;
    badge.textContent = count > 0 ? String(count) : '';
    badge.classList.toggle('nav__badge--on', count > 0);
  }

  /** Rail pulsing dot (Activity is busy). */
  setLive(id: ViewId, live: boolean): void {
    this.navs
      .get(id)
      ?.querySelector<HTMLElement>('.nav__live')
      ?.classList.toggle('nav__live--on', live);
  }

  setConnected(connected: boolean, label?: string): void {
    this.statusEl?.classList.toggle('status--down', !connected);
    if (this.statusText)
      this.statusText.textContent = label ?? (connected ? 'Connected' : 'Offline');
    if (this.statusHead) {
      this.statusHead.textContent = connected ? 'Daemon online' : 'Daemon unreachable';
    }
  }

  /** Popover detail rows — both values come straight from the `welcome` payload. */
  setDaemonInfo(daemonVersion: string, host: string): void {
    const set = (selector: string, value: string) => {
      const el = this.q(selector);
      if (el) el.textContent = value;
    };
    set('#status-daemon', daemonVersion);
    set('#status-host', host);
  }

  /** Surface the last daemon-reported error in the popover (empty clears it). */
  setNotice(text: string): void {
    const note = this.q('#status-note');
    if (!note) return;
    note.textContent = text;
    note.classList.toggle('status__note--on', text.length > 0);
  }

  onReconnect(cb: () => void): void {
    this.q('#status-reconnect')?.addEventListener('click', () => {
      this.closeStatus();
      cb();
    });
  }

  private closeStatus(): void {
    this.statusPop?.classList.remove('status__pop--open');
  }
}
