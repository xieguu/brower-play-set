export function cleanError(message) {
  return String(message || '').replace(/\u001b\[[0-9;]*m/g, '');
}

export function explainError(message) {
  const text = cleanError(message);
  if (/ERR_CONNECTION_RESET/.test(text)) return '连接被重置，请检查网络与该实例的代理设置';
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/.test(text)) return '代理连接失败，请检查代理地址、端口与运行状态';
  if (/ERR_NAME_NOT_RESOLVED/.test(text)) return '域名解析失败，请检查网址与 DNS 设置';
  if (/ERR_CONNECTION_REFUSED/.test(text)) return '目标拒绝连接，请检查服务是否启动';
  if (/ERR_CERT_/.test(text)) return '网站证书验证失败，请检查证书与系统时间';
  if (/Timeout \d+ms exceeded|timed out/i.test(text)) return '网页加载超时，请检查网站连通性与代理';
  return text.split('\n')[0];
}
