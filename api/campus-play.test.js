'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const web = path.join(__dirname, '..', 'web');
const home = require('../web/home.js');
const guide = require('../web/install-guide.js');

assert.ok(home.ICEBREAKERS.length >= 3);
assert.equal(new Set(home.ICEBREAKERS).size, home.ICEBREAKERS.length);
home.ICEBREAKERS.forEach(line => assert.match(line, /\p{Script=Han}/u));

const start = home.ICEBREAKERS[0];
const first = home.nextIcebreaker(start);
assert.notEqual(first, start);
assert.ok(home.ICEBREAKERS.includes(first));
let cur = start;
const seen = [];
for (let i = 0; i < home.ICEBREAKERS.length; i++) {
  cur = home.nextIcebreaker(cur);
  seen.push(cur);
}
assert.ok(seen.includes(start), 'cycling returns to an earlier line');
const steppedBack = seen.findIndex((line, idx) => idx > 0 && home.ICEBREAKERS.indexOf(line) < home.ICEBREAKERS.indexOf(seen[idx - 1]));
assert.ok(steppedBack > 0);

assert.equal(guide.installState({ installEvent: true, standalone: false, iosSafari: false }), 'prompt');
assert.equal(guide.installState({ installEvent: true, standalone: true, iosSafari: true }), 'installed');
assert.equal(guide.installState({ installEvent: false, standalone: true, iosSafari: false }), 'installed');
assert.equal(guide.installState({ installEvent: false, standalone: false, iosSafari: true }), 'ios-steps');
assert.equal(guide.installState({ installEvent: false, standalone: false, iosSafari: false }), 'unsupported');
assert.equal(guide.installState({}), 'unsupported');
assert.equal(guide.isIosSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'MacIntel', 5), true);
assert.equal(guide.isIosSafari('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'iPhone', 5), true);
assert.equal(guide.isIosSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'MacIntel', 0), false);
assert.equal(guide.afterInstallChoice('dismissed'), 'keep');
assert.equal(guide.afterInstallChoice('accepted'), 'hide');

function panel(name) {
  return { hidden: true, getAttribute(n) { return n === 'data-install-panel' ? name : null; } };
}
function paint(state) {
  const panels = [panel('prompt'), panel('ios-steps'), panel('manual')];
  const node = { hidden: true, querySelectorAll() { return panels; } };
  const root = { querySelectorAll(sel) { return sel === '[data-install-guide]' ? [node] : []; } };
  guide.applyInstallGuide(state, root);
  return { guide: node, panels };
}
const prompted = paint('prompt');
assert.equal(prompted.guide.hidden, false);
assert.equal(prompted.panels[0].hidden, false);
assert.equal(prompted.panels[1].hidden, true);
assert.equal(prompted.panels[2].hidden, true);
const ios = paint('ios-steps');
assert.equal(ios.guide.hidden, false);
assert.equal(ios.panels[0].hidden, true);
assert.equal(ios.panels[1].hidden, false);
assert.equal(ios.panels[2].hidden, true);
const manual = paint('unsupported');
assert.equal(manual.guide.hidden, false);
assert.equal(manual.panels[0].hidden, true);
assert.equal(manual.panels[1].hidden, true);
assert.equal(manual.panels[2].hidden, false);
{
  const view = paint('installed');
  assert.equal(view.guide.hidden, true);
  assert.ok(view.panels.every(p => p.hidden));
}

function browserRealm(doc, extra) {
  const fetchCalls = [];
  const sandbox = {
    console,
    queueMicrotask: queueMicrotask,
    setTimeout,
    clearTimeout,
    Promise,
    Array,
    Object,
    Error,
    JSON,
    document: doc,
    navigator: Object.assign({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      language: 'zh-CN'
    }, extra && extra.navigator),
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    },
    fetch(...args) {
      fetchCalls.push(args);
      return Promise.resolve({ ok: false, status: 500, statusText: 'err', json: async () => ({}) });
    },
    addEventListener() {},
    removeEventListener() {},
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, fetchCalls };
}

function el(id) {
  const listeners = {};
  const attrs = {};
  return {
    id,
    textContent: '',
    hidden: false,
    dataset: {},
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach(fn => fn(Object.assign({ preventDefault() {} }, ev))); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    setAttribute(name, value) { attrs[name] = String(value); }
  };
}

const prompt = el('icebreakerPrompt');
const button = el('icebreakerNext');
const ids = { icebreakerPrompt: prompt, icebreakerNext: button };
const homeDoc = {
  readyState: 'complete',
  getElementById(id) { return ids[id] || null; },
  querySelectorAll() { return []; },
  addEventListener() {}
};
const homeRealm = browserRealm(homeDoc);
vm.runInContext(fs.readFileSync(path.join(web, 'home.js'), 'utf8'), homeRealm.sandbox, { filename: 'home.js' });
assert.ok(home.ICEBREAKERS.includes(prompt.textContent));
assert.ok(prompt.textContent.length > 0);
const before = prompt.textContent;
button.dispatchEvent({ type: 'click' });
assert.notEqual(prompt.textContent, before);
assert.ok(home.ICEBREAKERS.includes(prompt.textContent));
assert.equal(homeRealm.fetchCalls.length, 0);
button.dispatchEvent({ type: 'click' });
assert.equal(homeRealm.fetchCalls.length, 0);

const savedStore = {};
const copied = [];
const savedPrompt = el('icebreakerPrompt');
const savedButton = el('icebreakerNext');
const note = el('icebreakerNote');
const keep = el('keep');
keep.setAttribute('data-react', '先记下');
const savedIds = { icebreakerPrompt: savedPrompt, icebreakerNext: savedButton, icebreakerNote: note };
const savedDoc = {
  readyState: 'complete',
  getElementById(id) { return savedIds[id] || null; },
  querySelectorAll(sel) { return sel === '[data-react]' ? [keep] : []; },
  addEventListener() {}
};
const saveRealm = browserRealm(savedDoc, {
  navigator: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    clipboard: { writeText(text) { copied.push(text); return Promise.resolve(); } }
  }
});
saveRealm.sandbox.localStorage = {
  getItem(key) { return Object.prototype.hasOwnProperty.call(savedStore, key) ? savedStore[key] : null; },
  setItem(key, value) { savedStore[key] = String(value); },
  removeItem(key) { delete savedStore[key]; }
};
vm.runInContext(fs.readFileSync(path.join(web, 'home.js'), 'utf8'), saveRealm.sandbox, { filename: 'home.js' });
assert.equal(savedPrompt.textContent, home.ICEBREAKERS[0]);
keep.dispatchEvent({ type: 'click' });
assert.equal(savedStore['fancyu-icebreaker-saved'], savedPrompt.textContent);
assert.equal(copied[0], savedPrompt.textContent);
assert.equal(note.textContent, '已记在这台设备上');
assert.equal(saveRealm.fetchCalls.length, 0);

const guideDoc = {
  readyState: 'complete',
  getElementById() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {}
};
const guideRealm = browserRealm(guideDoc);
vm.runInContext(fs.readFileSync(path.join(web, 'install-guide.js'), 'utf8'), guideRealm.sandbox, { filename: 'install-guide.js' });
const decide = guideRealm.sandbox.fancyuInstall.decide;
assert.equal(typeof decide, 'function');
assert.equal(decide({ installEvent: true, standalone: false, iosSafari: false }), 'prompt');
assert.equal(decide({ installEvent: true, standalone: true, iosSafari: false }), 'installed');
assert.equal(decide({ installEvent: false, standalone: false, iosSafari: true }), 'ios-steps');
assert.equal(decide({ installEvent: false, standalone: false, iosSafari: false }), 'unsupported');
assert.equal(guideRealm.sandbox.module, undefined);
assert.equal(guideRealm.sandbox.require, undefined);
assert.equal(guideRealm.sandbox.exports, undefined);
assert.equal(homeRealm.sandbox.module, undefined);
assert.equal(homeRealm.sandbox.require, undefined);
assert.equal(homeRealm.sandbox.exports, undefined);

const pages = ['index.html', 'weekly-match.html', 'chat.html', 'profile.html', 'deep.html', 'friends.html', 'notifications.html'];
const enterCss = fs.readFileSync(path.join(web, 'page-enter.css'), 'utf8');
assert.match(enterCss, /main\s*\{[^}]*animation:\s*fancyu-page-enter\s+220ms/);
assert.match(enterCss, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[^}]*animation:\s*none/);
assert.match(enterCss, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[^}]*transition:\s*none/);
assert.match(enterCss, /data-page="chat"[^}]*animation:\s*none/);
for (const page of pages) {
  const html = fs.readFileSync(path.join(web, page), 'utf8');
  if (page !== 'index.html') assert.match(html, /page-enter\.css/, page);
  assert.match(html, /<main[\s>]/, page);
}
function scriptSwallowsMarkup(html) {
  const lower = html.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const openAt = lower.indexOf('<script', i);
    const closeAt = lower.indexOf('</script', i);
    if (openAt === -1) return false;
    if (closeAt !== -1 && closeAt < openAt) { i = closeAt + 9; continue; }
    const gt = lower.indexOf('>', openAt);
    if (gt === -1) return true;
    const end = lower.indexOf('</script', gt);
    if (end === -1) return true;
    const chunk = lower.slice(gt + 1, end);
    if (chunk.includes('<body') || chunk.includes('<main') || chunk.includes('</head>')) return true;
    i = end + 9;
  }
  return false;
}
for (const page of pages) {
  assert.equal(scriptSwallowsMarkup(fs.readFileSync(path.join(web, page), 'utf8')), false, page);
}
const notesHtml = fs.readFileSync(path.join(web, 'notifications.html'), 'utf8');
assert.ok(notesHtml.indexOf('src="/pwa.js') < notesHtml.indexOf('src="notifications.js'), 'pwa.js before notifications.js');
const notesJs = fs.readFileSync(path.join(web, 'notifications.js'), 'utf8');
assert.equal(notesJs.includes('本页脚本尚未加载完成'), false);
assert.match(notesJs, /DOMContentLoaded/);
assert.match(notesJs, /pointAtInstallGuide/);
assert.match(notesHtml, /id="pushToggle"/);
assert.match(notesHtml, /role="switch"/);
assert.match(notesHtml, /id="pushNeedInstall"/);
assert.match(notesHtml, /查看安装指引/);
const pwaJs = fs.readFileSync(path.join(web, 'pwa.js'), 'utf8');
assert.match(pwaJs, /通知已经打开啦。有人找你的时候，我会轻轻敲一下。/);
assert.match(pwaJs, /app-version\.json/);
assert.match(pwaJs, /controllerchange/);
assert.match(pwaJs, /updateViaCache:\s*'none'/);
assert.match(pwaJs, /\.update\(/);
const appVersion = JSON.parse(fs.readFileSync(path.join(web, 'app-version.json'), 'utf8'));
assert.equal(appVersion.version, '20261117g');
const profileHtml = fs.readFileSync(path.join(web, 'profile.html'), 'utf8');
assert.match(profileHtml, /新手任务/);
assert.equal(profileHtml.includes('资料完善度'), false);
const centerJs = fs.readFileSync(path.join(web, 'profile-center.js'), 'utf8');
assert.match(centerJs, /安装应用并开启通知/);
assert.equal(centerJs.includes('PWA'), false);
assert.match(centerJs, /key==='verified'/);
assert.match(centerJs, /compressAvatar/);
assert.match(centerJs, /image\/jpeg/);
assert.match(centerJs, /key==='avatar'/);
assert.match(profileHtml, /id="avatarModal"/);
assert.match(profileHtml, /openAvatarSheet\(\)/);
assert.match(fs.readFileSync(path.join(web, 'sw.js'), 'utf8'), /pathname === '\/sw\.js'/);
assert.match(fs.readFileSync(path.join(web, 'sw.js'), 'utf8'), /app-version\.json/);
const homeCss = fs.readFileSync(path.join(web, 'home.css'), 'utf8');
assert.match(homeCss, /:focus-visible/);
assert.match(fs.readFileSync(path.join(web, 'dark.css'), 'utf8'), /html\[data-theme="dark"\]/);
const indexHtml = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
assert.match(indexHtml, /href="\/weekly-match"/);
assert.match(indexHtml, /href="\/deep"/);
assert.match(indexHtml, /href="\/friends#quick"/);
assert.match(indexHtml, /id="statusLink"/);
assert.match(indexHtml, /id="heroTitle"/);
assert.match(indexHtml, /id="noticeCards"/);
assert.match(indexHtml, /id="modes"/);
assert.equal(indexHtml.includes('icebreaker'), false);
assert.equal(indexHtml.includes('install-guide'), false);

const installHtml = ['notifications.html', 'profile.html'].map(name => fs.readFileSync(path.join(web, name), 'utf8'));
for (const html of installHtml) {
  assert.match(html, /data-install-guide/);
  assert.match(html, /data-install-panel="manual"/);
  assert.match(html, /install-guide\.js/);
  assert.match(html, /安装应用/);
  assert.match(html, /分享 → 添加到主屏幕/);
  assert.equal(html.includes('安装成功'), false);
}
assert.match(installHtml[0], /Web Push 只有从主屏幕图标打开之后才能使用/);
assert.match(installHtml[1], /Web Push 只有从主屏幕图标打开之后才能使用/);
assert.equal(fs.readFileSync(path.join(web, 'install-guide.js'), 'utf8').includes('安装成功'), false);

const sw = fs.readFileSync(path.join(web, 'sw.js'), 'utf8');
for (const prefix of ['/api/', '/account/', '/admin/', '/oauth/', '/llm/', '/socket.io/', '/health']) {
  assert.ok(sw.includes(prefix), prefix);
}
assert.match(sw, /OFFLINE\s*=\s*'\/offline'/);
assert.match(sw, /searchParams\.has\('kill'\)/);
assert.match(sw, /unregister\(/);
assert.match(sw, /VERSION\s*=\s*'fancyu-v6'/);
assert.equal(fs.readFileSync(path.join(web, 'auth-session.js'), 'utf8').includes('prefers-color-scheme'), false);
assert.match(fs.readFileSync(path.join(web, 'auth-session.js'), 'utf8'), /themeSaved==='dark'/);
for (const page of ['login.html','register.html','forgot-password.html','friend_survey.html']) {
  assert.equal(fs.readFileSync(path.join(web, page), 'utf8').includes('prefers-color-scheme: dark'), false, page);
}
assert.equal(fs.readFileSync(path.join(web, 'ui-dialog.js'), 'utf8').includes('prefers-color-scheme'), false);
assert.equal(sw.includes('fancyu-v1'), false);

const manifest = JSON.parse(fs.readFileSync(path.join(web, 'manifest.webmanifest'), 'utf8'));
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.start_url);
assert.equal(manifest.scope, '/');
assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4);

console.log('icebreaker set', home.ICEBREAKERS.length, 'start', start, 'next', first, 'later', seen.join(' | '));
console.log('installState prompt', guide.installState({ installEvent: true, standalone: false, iosSafari: false }));
console.log('installState installed', guide.installState({ installEvent: true, standalone: true, iosSafari: true }));
console.log('installState ios-steps', guide.installState({ installEvent: false, standalone: false, iosSafari: true }));
console.log('installState unsupported', guide.installState({ installEvent: false, standalone: false, iosSafari: false }));
console.log('vm prompt', before, '->', prompt.textContent, 'fetch', homeRealm.fetchCalls.length);
console.log('vm decide', decide({ installEvent: true, standalone: false, iosSafari: false }), decide({ installEvent: true, standalone: true, iosSafari: false }), decide({ installEvent: false, standalone: false, iosSafari: true }), decide({ installEvent: false, standalone: false, iosSafari: false }));
console.log('sw version fancyu-v6 bypass /api/ /account/ /admin/ /oauth/ /llm/ /socket.io/ /health offline kill');
console.log('PASS: icebreaker cycle, install states, vm browser scripts, page-enter reduced motion, sw kill/bypass, manifest standalone');
