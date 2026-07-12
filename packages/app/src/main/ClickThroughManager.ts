import { ipcMain, type BrowserWindow } from 'electron';

/**
 * ClickThroughManager — toggles the overlay between click-through and solid.
 *
 * The overlay defaults to click-through (`setIgnoreMouseEvents(true, {forward:true})`)
 * so clicks reach the desktop, while `forward: true` still delivers hover events
 * to the renderer. When the pointer enters the avatar's bounds the renderer sends
 * `wk:set-click-through false` (solid, so the avatar is clickable/draggable); on
 * leave it sends `true` again.
 *
 * The state is re-asserted on focus/show/display changes because Windows can drop
 * the ignore-mouse flag across those transitions (a known Electron papercut).
 */
export function registerClickThrough(overlay: BrowserWindow): void {
  let solid = false;

  const apply = (): void => {
    if (solid) overlay.setIgnoreMouseEvents(false);
    else overlay.setIgnoreMouseEvents(true, { forward: true });
  };

  ipcMain.on('wk:set-click-through', (event, clickThrough: boolean) => {
    // Only honor messages from the overlay window itself.
    if (event.sender !== overlay.webContents) return;
    solid = !clickThrough;
    apply();
  });

  // Re-assert on transitions where Windows can drop the ignore-mouse flag.
  overlay.on('focus', apply);
  overlay.on('show', apply);
  overlay.on('restore', apply);
  overlay.webContents.on('did-finish-load', apply);
}
