// 同一构建同时支持内网根路径与公网 /fieldwar，避免 API、资源和导航跳出代理前缀。
export function appPath(path:string):string {
  const pathname=location.pathname;
  const prefix=pathname==='/fieldwar' || pathname.startsWith('/fieldwar/') ? '/fieldwar' : '';
  return `${prefix}${path}`;
}
