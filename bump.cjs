// 배포 전에 실행: node bump.cjs  → sw.js VERSION 과 index.html 의 ?v= 를 함께 올림
const fs = require('fs'), path = require('path');
const dir = __dirname;
const swPath = path.join(dir, 'sw.js'), htmlPath = path.join(dir, 'index.html');
let sw = fs.readFileSync(swPath, 'utf8');
const n = +sw.match(/const VERSION = 'mm-v(\d+)'/)[1] + 1;
sw = sw.replace(/const VERSION = 'mm-v\d+'/, `const VERSION = 'mm-v${n}'`);
let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replace(/(href="styles\.css|src="config\.js|src="app\.js)(\?v=\d+)?"/g, `$1?v=${n}"`);
fs.writeFileSync(swPath, sw);
fs.writeFileSync(htmlPath, html);
console.log('version ->', n);
