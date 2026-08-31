# Issue #752: niri drag diagnostics

Status: diagnostic-only probe. It does not change drag positioning or select a single-window mode.

The probe compares three sources while the pet is dragged:

- pointer coordinates delivered to the hit renderer (`screen*`, `client*`, and cumulative `movement*`);
- Electron's main-process `screen.getCursorScreenPoint()` result;
- requested logical bounds and the render window's native bounds.

Normal launches keep the existing IPC payloads and behavior. The renderer collects and sends samples only when `CLAWD_WINDOW_DEBUG=1` is present at startup. Move records are limited to one every 250ms, plus an unconditional start and end record.

## Reporter test procedure

Quit every running Clawd instance from the tray first. Then run the diagnostic AppImage from a terminal:

```bash
chmod +x ./Clawd-on-Desk-issue-752-x86_64.AppImage
CLAWD_WINDOW_DEBUG=1 ./Clawd-on-Desk-issue-752-x86_64.AppImage 2>&1 | tee clawd-issue-752.log
```

The environment flag survives Clawd's automatic XWayland relaunch, and the replacement process inherits the terminal output.

Perform these actions slowly:

1. Plain left-drag the pet about 300px to the right and hold for two seconds before releasing.
2. Plain left-drag about 300px to the left.
3. Plain left-drag vertically.
4. Move the visible Clawd window with niri's compositor shortcut, then try another plain left-drag and click.

Capture the compositor view after step 4:

```bash
niri msg windows > niri-windows-after.txt
grep "drag-diagnostic" clawd-issue-752.log > clawd-issue-752-drag.log
```

Return:

- `clawd-issue-752-drag.log`;
- `niri-windows-after.txt`;
- the startup line that says whether Clawd relaunched under XWayland;
- a short note saying whether the pet window moved during each step and whether clicking still worked after the compositor move.

The diagnostic lines contain screen/window coordinates but no prompts, file paths, commands, session IDs, or agent content. Omit `CLAWD_WINDOW_DEBUG=1` on the next launch to disable the probe.

## Reading the result

Each line starts with `Clawd: drag-diagnostic` and contains JSON.

- If `pointerScreenDelta` or `pointer.movementTotal*` changes while `electronCursorDelta` stays at `{ "x": 0, "y": 0 }`, the stale Electron global-cursor hypothesis is confirmed.
- If both pointer and Electron coordinates move but `nativeBounds` stays fixed, the next target is client-requested X11 window positioning under xwayland-satellite.
- If pointer coordinates also remain stale, a pointer-coordinate patch is not viable; investigate compositor-managed movement or a separate native/single-surface mode.
- `niri msg windows` plus the post-compositor-move click check determines whether render and hit ownership actually split. Workspace switching alone does not establish that.
