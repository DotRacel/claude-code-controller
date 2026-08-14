import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

/**
 * Installable on a secure context (https / localhost). Skipped in Vite dev so the worker never
 * caches the unbundled module graph.
 *
 * The update logic is not boilerplate — without it an installed iOS web app can never update.
 * The browser only checks for a new worker on *navigation*, and iOS preserves a standalone app's
 * state: relaunching from the home-screen icon RESUMES the app rather than navigating, so the
 * check never fires and the phone keeps running whatever bundle it first installed. (It also
 * explains the symptom: Safari shows the new version immediately while the home-screen app does
 * not, because standalone mode and Safari do not share Cache Storage.)
 *
 * So: poll for a new worker ourselves, and reload the page when one takes over.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void (async () => {
      // Whether we are already under a worker's control decides what `controllerchange` means
      // below, and must be read before registering.
      const hadController = !!navigator.serviceWorker.controller;

      // updateViaCache: 'none' — otherwise the HTTP cache can hand back a stale sw.js and mask
      // the entire update, however many times we ask.
      const reg = await navigator.serviceWorker
        .register('./sw.js', { updateViaCache: 'none' })
        .catch(() => null);
      if (!reg) return;

      // Standalone never navigates, so this is the only thing that ever asks "is there a new
      // build?". Every time the app comes to the foreground, plus hourly while it stays open.
      const check = () => void reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('focus', check);
      setInterval(check, 60 * 60 * 1000);
      check();

      // sw.js calls skipWaiting(), so a new worker activates without waiting for the app to be
      // closed — but this *page* keeps running the old bundle until it reloads. Reload once, and
      // only for a genuine replacement: on a first install the worker claiming the page fires the
      // same event, and reloading there would just be a pointless flash.
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });
    })();
  });
}
