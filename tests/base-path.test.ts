import {afterEach,expect,it,vi} from 'vitest';
import {appPath} from '../apps/field-wars/src/paths';
afterEach(()=>vi.unstubAllGlobals());
it.each(['/','/admin','/fieldwarrior/'])('内网根路径不引入公网前缀：%s',pathname=>{
  vi.stubGlobal('location',{pathname});
  expect(appPath('/api/session')).toBe('/api/session');
  expect(appPath('/city-background.svg')).toBe('/city-background.svg');
  expect(appPath('/admin')).toBe('/admin');
});
it.each(['/fieldwar','/fieldwar/','/fieldwar/admin'])('公网 API、资源、WebSocket 与导航保留游戏前缀：%s',pathname=>{
  vi.stubGlobal('location',{pathname});
  for(const path of ['/','/api/session','/api/events','/city-background.svg','/admin'])expect(appPath(path)).toBe(`/fieldwar${path}`);
});
