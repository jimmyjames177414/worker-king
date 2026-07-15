import { routeRequest, type CapabilityManifestEntry } from '@workerking/shared';

/**
 * The chat command palette: typing "/" turns the composer into a capability
 * picker. `parsePaletteQuery` and `insertionFor` are pure (unit-tested); the
 * CommandPalette class owns the dropdown DOM and keyboard navigation.
 */

/** Query after a leading "/", or null when the input isn't in palette mode. */
export function parsePaletteQuery(input: string): string | null {
  if (!input.startsWith('/')) return null;
  return input.slice(1);
}

/** Text to drop into the composer when a capability is picked. */
export function insertionFor(entry: CapabilityManifestEntry): string {
  if (entry.kind === 'command') return `/${entry.name} `;
  return `Use ${entry.name}: `;
}

/** Rank capabilities for a palette query (empty query → first N by name). */
export function paletteMatches(
  query: string,
  entries: CapabilityManifestEntry[],
  limit = 8,
): CapabilityManifestEntry[] {
  if (!query.trim()) {
    return [...entries].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
  }
  return routeRequest(query, entries, { limit }).map((r) => r.entry);
}

export class CommandPalette {
  private readonly el: HTMLElement;
  private items: CapabilityManifestEntry[] = [];
  private active = 0;
  private open = false;

  constructor(
    private readonly input: HTMLInputElement,
    mount: HTMLElement,
    private readonly getEntries: () => CapabilityManifestEntry[],
  ) {
    this.el = document.createElement('div');
    this.el.className = 'palette';
    this.el.style.display = 'none';
    mount.appendChild(this.el);

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this.onKeydown(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.hide(), 120));
  }

  private refresh(): void {
    const query = parsePaletteQuery(this.input.value);
    if (query === null) return this.hide();
    this.items = paletteMatches(query, this.getEntries());
    this.active = 0;
    this.render();
  }

  private render(): void {
    if (!this.items.length) return this.hide();
    this.open = true;
    this.el.style.display = 'block';
    this.el.replaceChildren();
    this.items.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = `palette__item${i === this.active ? ' palette__item--active' : ''}`;
      const kind = document.createElement('span');
      kind.className = 'palette__kind';
      kind.textContent = entry.kind;
      const name = document.createElement('span');
      name.className = 'palette__name';
      name.textContent = entry.name;
      const desc = document.createElement('span');
      desc.className = 'palette__desc';
      desc.textContent = entry.description;
      row.append(kind, name, desc);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.pick(entry);
      });
      this.el.appendChild(row);
    });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.active = (this.active + 1) % this.items.length;
      this.render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active = (this.active - 1 + this.items.length) % this.items.length;
      this.render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = this.items[this.active];
      if (entry) this.pick(entry);
    } else if (e.key === 'Escape') {
      this.hide();
    }
  }

  private pick(entry: CapabilityManifestEntry): void {
    this.input.value = insertionFor(entry);
    this.hide();
    this.input.focus();
  }

  private hide(): void {
    this.open = false;
    this.el.style.display = 'none';
  }
}
