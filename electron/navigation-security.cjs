const path = require('node:path');
const { fileURLToPath } = require('node:url');

/**
 * Create the navigation allowlist used by the Electron main frame and IPC guard.
 * Packaged builds trust only the exact local renderer entrypoint, never an
 * arbitrary file:// URL. Development builds trust only the configured origin.
 */
function createNavigationGuard({ isDev, devUrl, rendererPath }) {
  let developmentOrigin = '';
  if (isDev) {
    try {
      const parsedDevUrl = new URL(devUrl);
      if (parsedDevUrl.protocol === 'http:' || parsedDevUrl.protocol === 'https:') {
        developmentOrigin = parsedDevUrl.origin;
      }
    } catch {
      // An invalid development URL must fail closed.
    }
  }

  const expectedRendererPath = path.resolve(rendererPath);

  return function isAllowedNavigation(url) {
    try {
      const parsed = new URL(url);
      if (isDev) {
        return Boolean(developmentOrigin)
          && parsed.origin === developmentOrigin
          && !parsed.username
          && !parsed.password;
      }

      if (parsed.protocol !== 'file:' || parsed.host) return false;
      const actualRendererPath = path.resolve(fileURLToPath(parsed));
      return process.platform === 'win32'
        ? actualRendererPath.toLowerCase() === expectedRendererPath.toLowerCase()
        : actualRendererPath === expectedRendererPath;
    } catch {
      return false;
    }
  };
}

module.exports = { createNavigationGuard };
