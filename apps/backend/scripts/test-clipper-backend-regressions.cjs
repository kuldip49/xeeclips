const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const label = process.argv.includes('--baseline') ? 'baseline' : 'final';
const directory = path.join(root, '.cache/clipper-hardening', label);
fs.mkdirSync(directory, {recursive:true});
const suites = ['test-campaigns','test-quick-reframe','test-quick-reframe-modes','test-quick-reframe-transcript','test-quick-reframe-styleone','test-quick-reframe-styletwo','test-quick-reframe-post-copy','test-xeepro-hook-grammar','test-clip-candidates','test-clip-ui','test-clip-export','test-clip-selection-flow','test-style-readiness','test-rematerialize-styled-clip','test-editor-headline-export','test-xeefree-policy','test-xeepro-busy'];
const results = suites.map(suite => {
  const result = spawnSync(process.execPath, [path.join(__dirname, suite+'.cjs')], {cwd:root, encoding:'utf8'});
  fs.writeFileSync(path.join(directory, suite+'.log'), (result.stdout||'')+(result.stderr||''));
  console.log(`${suite}: ${result.status===0?'PASS':'FAIL'}`);
  return {suite, status:result.status, summary:(result.stdout||'').trim().split('\n').slice(-1)};
});
fs.writeFileSync(path.join(directory,'regressions.json'),JSON.stringify(results,null,2));
process.exitCode=results.some(result=>result.status!==0)?1:0;
