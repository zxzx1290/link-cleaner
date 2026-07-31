/**
 * 在命令列跑一次短網址還原，用的是 Worker 的同一份程式碼
 *
 * 執行：node tools/expand.mjs <網址> [更多網址...]
 */

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { handleExpand } = await import(pathToFileURL(join(ROOT, 'worker/expand.js')));

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法：node tools/expand.mjs <網址> [更多網址...]');
  process.exit(1);
}

for (const target of targets) {
  const request = new Request(`https://link-cleaner.local/api/expand?url=${encodeURIComponent(target)}`);
  const response = await handleExpand(request);
  const data = await response.json();

  console.log(`\n### ${target}`);
  if (!data.ok) {
    console.log(`  ✗ ${data.error}`);
    continue;
  }
  for (const hop of data.hops || []) {
    console.log(`  [${hop.status}] → ${hop.to}`);
  }
  if (data.stopped) console.log(`  ⚠ 中途停下：${data.stopped}`);
  console.log(`  結果：${data.url}`);
}
