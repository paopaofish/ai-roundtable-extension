// Static checks that work without spawning child processes (sandbox-safe).
//   - classic scripts are parsed with vm.Script
//   - ES modules are imported; a SyntaxError means broken, any other error is
//     expected (they touch chrome.* at load time)
//   - manifest.json is validated and every referenced file must exist
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function ok(msg) {
  console.log(`  ok   ${msg}`);
}

function bad(msg) {
  failures += 1;
  console.log(`  FAIL ${msg}`);
}

console.log('manifest.json');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
ok('valid JSON');

const referenced = new Set([
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  'src/dashboard.html',
  'src/dashboard.css',
  'src/dashboard.js',
].filter(Boolean));

for (const rel of referenced) {
  if (existsSync(join(ROOT, rel))) ok(`exists ${rel}`);
  else bad(`missing ${rel}`);
}

if (manifest.manifest_version !== 3) bad('manifest_version must be 3');
else ok('manifest_version = 3');

console.log('\nclassic scripts (vm parse)');
for (const rel of ['src/sites.js', 'src/agent.js', 'src/sw.js']) {
  try {
    new vm.Script(readFileSync(join(ROOT, rel), 'utf8'), { filename: rel });
    ok(rel);
  } catch (err) {
    bad(`${rel}: ${err.message}`);
  }
}

console.log('\nES modules (import)');
for (const rel of ['src/core.js', 'src/dashboard.js', 'src/sites.js']) {
  if (rel.endsWith('sites.js')) continue;
  try {
    await import(`file://${join(ROOT, rel)}`);
    ok(rel);
  } catch (err) {
    if (err instanceof SyntaxError) bad(`${rel}: ${err.message}`);
    else ok(`${rel} (runtime depends on browser APIs: ${err.constructor.name})`);
  }
}

console.log('\nHTML sanity');
const html = readFileSync(join(ROOT, 'src/dashboard.html'), 'utf8');
for (const id of [
  'topic',
  'rounds',
  'startBtn',
  'stopBtn',
  'pauseBtn',
  'timeline',
  'summaryBody',
  'logs',
  'exportBtn',
  'siteStatus',
]) {
  if (html.includes(`id="${id}"`)) ok(`#${id}`);
  else bad(`#${id} missing from dashboard.html`);
}
if (html.includes('type="module"')) ok('dashboard.js loaded as module');
else bad('dashboard.js must be loaded as a module');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
