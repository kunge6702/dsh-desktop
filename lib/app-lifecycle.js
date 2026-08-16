export function activateWindow(window) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

export function registerSingleInstance(app, onSecondInstance) {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', onSecondInstance);
  return true;
}
