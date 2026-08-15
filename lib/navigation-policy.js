export function isAllowedNavigation(rawUrl, allowedOrigin) {
  if (!allowedOrigin || typeof rawUrl !== 'string') return false;
  try {
    const target = new URL(rawUrl);
    return target.protocol === 'http:' && target.origin === allowedOrigin;
  } catch {
    return false;
  }
}

export function installNavigationGuards(browserWindow, getAllowedOrigin) {
  const isAllowed = (url) => isAllowedNavigation(url, getAllowedOrigin());
  browserWindow.webContents.on('will-navigate', (event, legacyUrl) => {
    if (!isAllowed(event.url ?? legacyUrl)) event.preventDefault();
  });
  browserWindow.webContents.on('will-frame-navigate', (event) => {
    if (!isAllowed(event.url)) event.preventDefault();
  });
  browserWindow.webContents.on('will-redirect', (event, legacyUrl) => {
    if (!isAllowed(event.url ?? legacyUrl)) event.preventDefault();
  });
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}
