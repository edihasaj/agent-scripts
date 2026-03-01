---
summary: 'Headless Mac Studio setup and remote workflow over Tailscale/SSH/tmux.'
read_when:
  - Setting up or operating a Mac Studio without a display.
  - Running long builds/agents on a remote Mac from another machine.
---

# Mac Studio Headless Setup

Use Studio as always-on worker. MacBook as control plane.

## 1) One-time setup on Mac Studio

1. Install + sign in Tailscale.
2. Enable Remote Login (SSH):
   ```bash
   sudo systemsetup -setremotelogin on
   ```
3. Optional: enable Screen Sharing (for GUI-only tasks).
   - System Settings -> General -> Sharing -> Screen Sharing: On
4. Keep machine awake on power:
   ```bash
   sudo pmset -c sleep 0
   sudo pmset -c displaysleep 30
   pmset -g
   ```
5. Plug HDMI dummy adapter if GUI apps need a real display surface.

## 2) Connect from MacBook

1. Find Studio in tailnet:
   ```bash
   tailscale status | rg -i "studio"
   ```
2. SSH in:
   ```bash
   ssh <user>@<studio-host-or-100.x.y.z>
   ```
3. Start persistent session:
   ```bash
   tmux new -As studio
   ```

## 3) Daily remote workflow

1. Do heavy work on Studio (builds/tests/long agents).
2. Keep jobs in tmux panes/windows.
3. Reattach anytime:
   ```bash
   ssh <user>@<studio-host>
   tmux attach -t studio
   ```

## 4) GUI access when needed

```bash
open vnc://<studio-host>
```

If login screen/blank canvas issues: confirm Screen Sharing enabled, keep dummy plug attached.

## 5) Quick checks

```bash
tailscale status
pmset -g
tmux ls
```

If Studio unreachable: check power, network, Tailscale login state.

## 6) Windows machine option (Tailscale + SSH + display)

Use same pattern for a Windows laptop/desktop when needed.

1. Install + sign in Tailscale on Windows.
2. Enable OpenSSH Server on Windows.
3. SSH from Mac:
   ```bash
   ssh <windows-user>@<windows-host-or-100.x.y.z>
   ```
4. For occasional GUI checks, use RDP (or VNC) over Tailscale.
5. Keep Windows awake for reliable remote access (sleep/hibernate can break sessions).

## 7) Power-loss and auto-start checks

- macOS host: enable auto boot after power loss in firmware/energy settings.
- Windows host: enable auto power-on after AC loss in BIOS/UEFI, and set critical apps/services to auto-start.
