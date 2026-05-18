# L-PORTAL-DENY — XDG Desktop Portal Permission Denied

Manual operator procedure. No script.

## Validation rows served

| Row ID       | Description |
|--------------|-------------|
| VAL-CAP-003  | Portal denial returns a JSON-RPC error on capture.requestSession; helper stays IDLE |

## Operator procedure

The procedure differs by compositor. The goal is to trigger the XDG Desktop Portal
permission dialog and then **deny** the capture request.

### KDE Plasma (Wayland)

1. Open **System Settings → Privacy → Screen Sharing**.
2. Clear any pre-approved applications for cove-screen-recorder.
3. Launch cove-screen-recorder and attempt to start a capture session.
4. When the portal permission dialog appears, click **Do Not Allow** (or equivalent).
5. Observe the app UI.

### GNOME (Wayland)

1. Launch cove-screen-recorder and attempt to start a capture session.
2. When the "Share your screen" dialog appears, click **Cancel**.
3. Observe the app UI.

### Sway / wlroots

1. Revoke any prior session-bus approvals:
   ```bash
   pkill -f xdg-desktop-portal
   ```
2. Launch cove-screen-recorder.
3. At the portal prompt (if any), deny the request.
4. Observe the app UI.

## Expected outcome

- The app detects the portal denial.
- The `capture.requestSession` JSON-RPC call returns an **error response** (not a
  notification). The error message will contain text from the portal failure (e.g.
  `"portal response: ..."` or `"portal start: ..."`). There is no separate
  `captureError` event and no `portal-denied` reason code.
- The helper returns to **IDLE** — no active capture is installed, and the helper
  does not hang in an intermediate state.
- A user-visible error message is displayed explaining that screen capture permission was denied.
- The app does not crash, hang, or silently fail.
- The user can retry the capture request (re-enter PICKING) without restarting the app.
