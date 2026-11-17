'use strict';

/* 本地破冰话题。不请求网络，点一次换下一条，走完会回到前面的句子。 */
var ICEBREAKERS = [
  '今天食堂哪一档，值得专门绕路？',
  '如果只能借对方一本书，你会递哪一本？',
  '周末的校园散步，路线你来定还是我来定？',
  '图书馆靠窗的位子，你一般几点去占？'
];

function nextIcebreaker(current, prompts) {
  var list = prompts && prompts.length ? prompts : ICEBREAKERS;
  var i = list.indexOf(current);
  if (i < 0) i = -1;
  return list[(i + 1) % list.length];
}

function mountIcebreaker(doc) {
  var root = doc || document;
  var prompt = root.getElementById('icebreakerPrompt');
  var button = root.getElementById('icebreakerNext');
  if (!prompt || !button || !button.addEventListener) return;
  if (ICEBREAKERS.indexOf(prompt.textContent) < 0) prompt.textContent = ICEBREAKERS[0];
  var reacts = [];
  try {
    if (typeof root.querySelectorAll === 'function') {
      reacts = Array.prototype.slice.call(root.querySelectorAll('[data-react]') || []);
    }
  } catch (e) { reacts = []; }
  var note = root.getElementById('icebreakerNote');
  try {
    var savedLine = localStorage.getItem('fancyu-icebreaker-saved');
    if (savedLine && note && !note.textContent) note.textContent = '上次记下：' + savedLine;
  } catch (e) {}
  function rememberLine(line) {
    try { localStorage.setItem('fancyu-icebreaker-saved', line); return true; }
    catch (e) { return false; }
  }
  function clearReacts() {
    reacts.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    if (note) note.textContent = '';
  }
  button.addEventListener('click', function () {
    prompt.textContent = nextIcebreaker(prompt.textContent, ICEBREAKERS);
    clearReacts();
  });
  reacts.forEach(function (b) {
    if (b.addEventListener) {
      if (!b.getAttribute('aria-pressed')) b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () {
        var on = b.getAttribute('aria-pressed') === 'true';
        reacts.forEach(function (other) { other.setAttribute('aria-pressed', 'false'); });
        if (!on) {
          b.setAttribute('aria-pressed', 'true');
          var label = b.getAttribute('data-react') || '';
          if (label === '先记下') {
            var line = prompt.textContent;
            var remembered = rememberLine(line);
            if (note) note.textContent = remembered ? '已记在这台设备上' : '已记下：先记下';
            try {
              if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(line).then(function () {
                  if (note && b.getAttribute('aria-pressed') === 'true') note.textContent = '已复制这句开场';
                }).catch(function () {});
              }
            } catch (e) {}
          } else if (note) {
            note.textContent = '已记下：' + label;
          }
        } else if (note) {
          note.textContent = '';
        }
      });
    }
  });
}

function mountHome() {
  mountIcebreaker(document);
  var $ = function (id) { return document.getElementById(id); };
  if (!$('statusTitle') || !$('statusLink') || !$('statusText') || !$('statusIcon') || !$('statusAnnouncement') || !$('userMenu') || !$('loginLink') || !$('logout')) return;
  var loading = false;
  function status(title, copy, href, icon) {
    $('statusTitle').textContent = title;
    $('statusText').textContent = copy;
    $('statusLink').href = href;
    $('statusIcon').textContent = icon || '→';
    $('statusAnnouncement').textContent = title + '，' + copy;
  }
  function guest() {
    $('userMenu').hidden = true;
    $('loginLink').hidden = false;
    status('登录，开启校园相遇', '选择一种方式，开始认识新朋友', '/login?redirect=/');
  }
  async function loadAccount() {
    if (loading) return;
    var token = localStorage.getItem('token');
    if (!token) { guest(); return; }
    loading = true;
    status('正在读取账号状态', '请稍候，正在确认学生邮箱验证状态', '#');
    try {
      var headers = { Authorization: 'Bearer ' + token };
      var responses = await Promise.all([fetch('/api/account/me', { headers: headers }), fetch('/api/account/student-verification', { headers: headers })]);
      if (responses.some(function (r) { return r.status === 401; })) { guest(); return; }
      if (responses.some(function (r) { return !r.ok; })) throw Error('unavailable');
      var payloads = await Promise.all(responses.map(function (r) { return r.json(); }));
      var account = payloads[0], verification = payloads[1];
      if (account.code !== 200 || verification.code !== 200 || !account.user) throw Error('unavailable');
      var name = account.user.nickname || account.user.username || '同学';
      $('userName').textContent = name;
      $('userAvatar').textContent = Array.from(name)[0].toUpperCase();
      $('userMenu').hidden = false;
      $('loginLink').hidden = true;
      if (verification.verified === true) status('学生邮箱已验证', '下一步：选择一种方式，开始认识新朋友', '#modes', '✓');
      else status('先验证学生邮箱', '完成验证后，即可参与三种配对', '/verify-student');
    } catch (e) {
      status('暂时无法读取验证状态', '点击这里重试；你仍可查看配对页面', '#retry', '↻');
    } finally { loading = false; }
  }
  $('statusLink').addEventListener('click', function (e) {
    if ($('statusLink').getAttribute('href') === '#retry') { e.preventDefault(); loadAccount(); }
    else if (loading) e.preventDefault();
  });
  $('logout').addEventListener('click', function () {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    $('userMenu').open = false;
    guest();
  });
  document.addEventListener('click', function (e) {
    if (!$('userMenu').contains(e.target)) $('userMenu').open = false;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $('userMenu').open = false;
  });
  document.querySelectorAll('[data-dialog]').forEach(function (button) {
    button.addEventListener('click', function () { $(button.dataset.dialog).showModal(); });
  });
  document.querySelectorAll('dialog').forEach(function (dialog) {
    dialog.querySelector('[data-close]').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (e) {
      var r = dialog.getBoundingClientRect();
      if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
    });
  });
  loadAccount();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextIcebreaker: nextIcebreaker, ICEBREAKERS: ICEBREAKERS, mountIcebreaker: mountIcebreaker };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.fancyuIcebreaker = { next: nextIcebreaker, lines: ICEBREAKERS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountHome);
  else mountHome();
}
