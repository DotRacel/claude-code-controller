import { pushNotificationFrom, type PushNote } from '../../src/push-event.ts';

export { pushNotificationFrom, type PushNote };

export function notifySupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof Notification !== 'undefined';
}

export function notifyPermission(): NotificationPermission | 'unsupported' {
  if (!notifySupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotifyPermission(): Promise<boolean> {
  if (!notifySupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Show a local/PWA notification. No-op without permission (never throws). */
export async function showPushNotification(message: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!notifySupported()) return;
  if (Notification.permission !== 'granted') return;
  if (!opts.force && typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  const icon = new URL('./icons/icon-192.png', location.href).href;
  // `renotify` (re-alert when a tagged notification is replaced) is valid for
  // ServiceWorkerRegistration.showNotification but missing from this TS lib's NotificationOptions.
  const params: NotificationOptions & { renotify?: boolean } = { body: message, icon, tag: 'ccc-push', renotify: true };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) { await reg.showNotification('Claude Remote', params); return; }
  } catch { /* fall through */ }
  try { new Notification('Claude Remote', params); } catch { /* ignore */ }
}
