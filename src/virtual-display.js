import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

export const remoteDesktopEnabled = () => process.env.BPS_REMOTE_DESKTOP === '1' ||
  (process.platform === 'linux' && process.env.BPS_REMOTE_DESKTOP !== '0');

export function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

/** Xorg allocates a free display atomically; each Profile owns one display. */
export async function createVirtualDisplay(viewport) {
  if (process.platform !== 'linux') throw new AppError('网页远程操作需要 Ubuntu，请在服务器运行 bash setup.sh', 503);
  const width = viewport.width, height = viewport.height + 96;
  const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${width}x${height}x24`,
    '-nolisten', 'tcp', '-ac', '-noreset'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
  try {
    const number = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Xvfb 启动超时')), 10000);
      let output = '';
      const onError = error => finish(error);
      const onExit = () => finish(new Error(diagnostic || 'Xvfb 提前退出'));
      const onData = chunk => {
        output += chunk;
        if (/^\d+\n/.test(output)) finish(null, Number(output.trim()));
      };
      const finish = (error, result) => {
        clearTimeout(timer); child.off('error', onError); child.off('exit', onExit);
        child.stdio[3].off('data', onData);
        error ? reject(error) : resolve(result);
      };
      child.once('error', onError); child.once('exit', onExit); child.stdio[3].on('data', onData);
    });
    return { name: `:${number}`, width, height, child, close: () => stopChild(child) };
  } catch (error) {
    if (child.pid) await stopChild(child);
    throw new AppError(`虚拟屏幕启动失败，请运行 bash setup.sh：${error.message}`, 503);
  }
}
