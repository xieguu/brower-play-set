import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', 'test/integration/browser.test.js'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
