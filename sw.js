/* One worker for all three apps. It exists so notifications can be shown
   from a home-screen install, and so tapping one brings the app forward.
   It caches nothing and fetches nothing. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws =>
      ws.length ? ws[0].focus() : clients.openWindow('.')
    )
  );
});
