import { appPath } from './paths';

export async function fetchFrontendVersion(signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${appPath('/version.json')}?t=${Date.now()}`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`版本检测失败（${response.status}）`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('version' in data) ||
      typeof data.version !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(data.version)) {
    throw new Error('版本信息无效');
  }
  return data.version;
}

export function startVersionChecks(currentVersion: string, onVersion: (version: string) => void): () => void {
  let disposed = false;
  let request: AbortController | null = null;
  async function check() {
    if (disposed || request || document.visibilityState === 'hidden' || !navigator.onLine) return;
    const controller = new AbortController();
    request = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const version = await fetchFrontendVersion(controller.signal);
      // 始终和当前执行的构建比较；首次检查时服务器可能已经发布了新版。
      if (!disposed) onVersion(version === currentVersion ? '' : version);
    } catch (error) {
      if (!disposed) console.warn('前端版本检测暂不可用，将在下次检查时重试', error);
    } finally {
      window.clearTimeout(timeout);
      request = null;
    }
  }
  const interval = window.setInterval(() => void check(), 60_000);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  void check();
  return () => {
    disposed = true;
    request?.abort();
    window.clearInterval(interval);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', check);
  };
}

export function frontendRefreshUrl(version: string): string {
  const url = new URL(location.href);
  // 新入口 URL 绕过历史 HTML 缓存；Vite 的内容哈希让变更的资源重新下载。
  url.searchParams.set('_fw_version', `${version}.${Date.now()}`);
  return url.href;
}
