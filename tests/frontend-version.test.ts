import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchFrontendVersion, frontendRefreshUrl, startVersionChecks } from '../apps/field-wars/src/version';

let browser: EventTarget;
let page: EventTarget & { visibilityState: string };
let network: { onLine: boolean };
let stop: (() => void) | undefined;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  browser = Object.assign(new EventTarget(), { setInterval, clearInterval, setTimeout, clearTimeout });
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  network = { onLine: true };
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', page);
  vi.stubGlobal('navigator', network);
  vi.stubGlobal('location', { pathname: '/fieldwar/admin', href: 'https://example.test/fieldwar/admin?tab=logs#record' });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json({ version: 'build-a' }));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('版本请求绕过缓存，并使用当前部署前缀', async () => {
  expect(await fetchFrontendVersion()).toBe('build-a');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/fieldwar\/version.json\?t=\d+$/), expect.objectContaining({ cache: 'no-store' }));
  vi.stubGlobal('location', { pathname: '/' });
  await fetchFrontendVersion();
  expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/version.json\?t=/), expect.anything());
});

it.each([null, {}, { version: '' }, { version: 4 }, { version: '../index.html' }])('拒绝无效版本内容：%j', async body => {
  fetchMock.mockResolvedValue(Response.json(body));
  await expect(fetchFrontendVersion()).rejects.toThrow('版本信息无效');
});

it('首次即比较运行版本，定时发现更新，回滚到当前版本后清除提示', async () => {
  const notify = vi.fn();
  stop = startVersionChecks('old-build', notify);
  await vi.advanceTimersByTimeAsync(0);
  expect(notify).toHaveBeenLastCalledWith('build-a');
  fetchMock.mockImplementation(async () => Response.json({ version: 'build-b' }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(notify).toHaveBeenLastCalledWith('build-b');
  fetchMock.mockImplementation(async () => Response.json({ version: 'old-build' }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(notify).toHaveBeenLastCalledWith('');
});

it('页面隐藏和断网时暂停检查，返回和恢复网络时立即检测', async () => {
  page.visibilityState = 'hidden';
  stop = startVersionChecks('build-a', vi.fn());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).not.toHaveBeenCalled();
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  network.onLine = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  network.onLine = true;
  browser.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  browser.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('检测失败不会误报更新，后续检查可以恢复', async () => {
  const notify = vi.fn();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
  stop = startVersionChecks('build-a', notify);
  await vi.advanceTimersByTimeAsync(0);
  expect(notify).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(notify).toHaveBeenCalledWith('');
});

it('合并并发检查，卸载后中止请求并移除计时器和监听', async () => {
  let finish!: (response: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const notify = vi.fn();
  stop = startVersionChecks('build-a', notify);
  browser.dispatchEvent(new Event('focus'));
  browser.dispatchEvent(new Event('online'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  stop();
  expect(signal.aborted).toBe(true);
  finish(Response.json({ version: 'build-b' }));
  await vi.advanceTimersByTimeAsync(60_000);
  browser.dispatchEvent(new Event('focus'));
  expect(notify).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('超时会中止请求，下一轮仍能检测', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fetchMock.mockImplementationOnce((_url, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')));
  }));
  stop = startVersionChecks('build-a', vi.fn());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(50_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('更新入口 URL 绕过旧缓存，同时保留管理路径、查询参数和锚点', () => {
  const url = new URL(frontendRefreshUrl('build-b'));
  expect(url.pathname).toBe('/fieldwar/admin');
  expect(url.searchParams.get('tab')).toBe('logs');
  expect(url.hash).toBe('#record');
  expect(url.searchParams.get('_fw_version')).toMatch(/^build-b\.\d+$/);
});
