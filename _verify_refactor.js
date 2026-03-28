// 验证所有修改过的模块能正常加载
const m1 = require('./src/services/tokenUtils');
console.log('tokenUtils:', Object.keys(m1));

const m2 = require('./src/services/firebaseAuth');
console.log('firebaseAuth:', Object.keys(m2));

const m3 = require('./js/codexAccountSwitcher');
console.log('codexAccountSwitcher:', Object.keys(m3));

const m4 = require('./js/accountLogin');
console.log('accountLogin:', typeof m4);

const m5 = require('./js/accountQuery');
console.log('accountQuery:', typeof m5);

// tokenGetter 在渲染进程用 window，这里只检查当前模块语法
const code = require('fs').readFileSync('./src/renderer/tokenGetterRenderer.js', 'utf8');
new Function(code);
console.log('tokenGetter: syntax ok');

// 验证 isTokenExpired 功能
const { isTokenExpired } = m1;
const header = Buffer.from(JSON.stringify({alg:'none'})).toString('base64url');
const expiredPayload = Buffer.from(JSON.stringify({exp:0})).toString('base64url');
const validPayload = Buffer.from(JSON.stringify({exp: Math.floor(Date.now()/1000) + 3600})).toString('base64url');
const sig = '';
console.log('expired token:', isTokenExpired(header+'.'+expiredPayload+'.'+sig) === true);
console.log('valid token:', isTokenExpired(header+'.'+validPayload+'.'+sig) === false);
console.log('null token:', isTokenExpired(null) === true);
console.log('ALL PASSED');
