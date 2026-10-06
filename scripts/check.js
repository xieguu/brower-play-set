import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function visit(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? visit(name) : /\.[cm]?js$/.test(name) ? [name] : [];
  });
}
const files = ['src', 'public', 'tasks', 'test', 'scripts'].flatMap(visit);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} JavaScript files`);
