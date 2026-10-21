const CACHE_NAME = 'ironlog-cache-v7';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg'
];

let swTimerTimeoutId = null;
let swTimerResolve = null;

function clearSwTimer() {
  if (swTimerTimeoutId) {
    clearTimeout(swTimerTimeoutId);
    swTimerTimeoutId = null;
  }
  if (swTimerResolve) {
    swTimerResolve();
    swTimerResolve = null;
  }
}

// Install: Pre-cache core application shell and activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate: Clean up all outdated caches and take control immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

// Message: Background Rest Timer Notification Scheduling
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'CANCEL_REST_NOTIFICATION') {
    clearSwTimer();
    return;
  }

  if (data.type === 'SHOW_IMMEDIATE_NOTIFICATION') {
    clearSwTimer();
    event.waitUntil(
      self.registration.showNotification(data.title || '🔔 IronLog — 組間休息結束！', {
        body: data.body || '休息時間到，準備開始下一組訓練 💪',
        icon: './icon.svg',
        badge: './icon.svg',
        tag: 'ironlog-rest-timer',
        renotify: true,
        vibrate: [250, 120, 250, 120, 350]
      })
    );
    return;
  }

  if (data.type === 'SCHEDULE_REST_NOTIFICATION') {
    clearSwTimer();
    const delayMs = Math.max(0, Number(data.endTimeMs) - Date.now());
    const exerciseLabel = data.exercise ? `（${data.exercise}）` : '';

    const waitPromise = new Promise((resolve) => {
      swTimerResolve = resolve;
      swTimerTimeoutId = setTimeout(async () => {
        swTimerTimeoutId = null;
        swTimerResolve = null;
        try {
          // Only show OS notification if app is backgrounded or user requested forced test
          const clientList = await self.clients.matchAll({
            type: 'window',
            includeUncontrolled: true
          });
          const anyVisible = clientList.some((c) => c.visibilityState === 'visible');

          if (!anyVisible || data.alwaysNotify) {
            await self.registration.showNotification('🔔 IronLog — 組間休息結束！', {
              body: `休息時間到${exerciseLabel}，準備開始下一組訓練 💪`,
              icon: './icon.svg',
              badge: './icon.svg',
              tag: 'ironlog-rest-timer',
              renotify: true,
              vibrate: [250, 120, 250, 120, 350]
            });
          }
        } catch (err) {
          // Ignore notification error
        }
        resolve();
      }, delayMs);
    });

    event.waitUntil(waitPromise);
  }
});

// Notification Click: Focus existing IronLog window or open a new one
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow('./index.html');
        }
      })
  );
});

// Fetch: Network-first for same-origin assets (always fresh online, fallback to cache when offline)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
