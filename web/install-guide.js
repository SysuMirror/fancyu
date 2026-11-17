'use strict';

/* 安装指引只看这四个状态。standalone 优先于安装事件，避免已安装还显示按钮。 */
function installState(input) {
  var src = input || {};
  if (src.standalone) return 'installed';
  if (src.installEvent) return 'prompt';
  if (src.iosSafari) return 'ios-steps';
  return 'unsupported';
}

function isIosSafari(ua, platform, maxTouchPoints) {
  var text = ua || '';
  var pad = platform === 'MacIntel' && maxTouchPoints > 1;
  var iosDevice = /iPad|iPhone|iPod/.test(text) || pad;
  var otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android|Edg\//.test(text);
  return !!(iosDevice && /Safari/.test(text) && !otherBrowser);
}

/* accepted 收起按钮；取消或未完成则留着，方便再试。 */
function afterInstallChoice(outcome) {
  return outcome === 'accepted' ? 'hide' : 'keep';
}

function applyInstallGuide(state, root) {
  var doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.querySelectorAll !== 'function') return;
  var guides = doc.querySelectorAll('[data-install-guide]');
  if (!guides) return;
  /* 没有原生安装事件时仍展示手动步骤，只有已经装好才收起。 */
  var show = state === 'prompt' || state === 'ios-steps' || state === 'unsupported';
  var panelName = state === 'unsupported' ? 'manual' : state;
  Array.prototype.forEach.call(guides, function (guide) {
    var panels = guide.querySelectorAll ? guide.querySelectorAll('[data-install-panel]') : [];
    Array.prototype.forEach.call(panels || [], function (panel) {
      panel.hidden = !show || panel.getAttribute('data-install-panel') !== panelName;
    });
    guide.hidden = !show;
  });
}

function clientFlags(installEvent) {
  var standalone = false;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      standalone = !!window.matchMedia('(display-mode: standalone)').matches;
    }
  } catch (e) { standalone = false; }
  if (typeof navigator !== 'undefined' && navigator.standalone === true) standalone = true;
  var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  var platform = (typeof navigator !== 'undefined' && navigator.platform) || '';
  var touches = (typeof navigator !== 'undefined' && navigator.maxTouchPoints) || 0;
  var iosSafari = isIosSafari(ua, platform, touches);
  return installState({ installEvent: !!installEvent, standalone: standalone, iosSafari: iosSafari });
}

function bootInstallGuide() {
  var deferred = null;
  var keepPrompt = false;
  function hint(text) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    Array.prototype.forEach.call(document.querySelectorAll('[data-install-panel="prompt"] p'), function (p) {
      if (!p.getAttribute('data-default-hint')) p.setAttribute('data-default-hint', p.textContent);
      p.textContent = text || p.getAttribute('data-default-hint');
    });
  }
  function render() {
    var state = clientFlags(deferred);
    if (state === 'unsupported' && keepPrompt) state = 'prompt';
    else if (state !== 'prompt') keepPrompt = false;
    applyInstallGuide(state, document);
    if (deferred) hint('');
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeinstallprompt', function (e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      deferred = e;
      keepPrompt = false;
      render();
    });
  }
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-install-action="prompt"]'), function (btn) {
      if (!btn.addEventListener) return;
      btn.addEventListener('click', async function () {
        var ev = deferred;
        if (!ev || typeof ev.prompt !== 'function') {
          keepPrompt = true;
          hint('可以稍后再试，或用浏览器菜单里的「安装应用」。');
          render();
          return;
        }
        try { await ev.prompt(); }
        catch (err) { return; }
        var outcome = '';
        try {
          var choice = ev.userChoice ? await ev.userChoice : null;
          outcome = (choice && choice.outcome) || '';
        } catch (err2) {}
        deferred = null;
        if (afterInstallChoice(outcome) === 'keep') {
          keepPrompt = true;
          hint('先不安装也可以，按钮还在，稍后再点。');
        } else {
          keepPrompt = false;
          hint('');
        }
        render();
      });
    });
  }
  render();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { installState: installState, applyInstallGuide: applyInstallGuide, clientFlags: clientFlags, isIosSafari: isIosSafari, afterInstallChoice: afterInstallChoice };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.fancyuInstall = { decide: installState, apply: applyInstallGuide, flags: clientFlags };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootInstallGuide);
  else bootInstallGuide();
}
