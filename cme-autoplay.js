(function () {
  'use strict';

  // ================= 可调参数 =================
  var CHECK_INTERVAL = 30 * 1000;        // 每30秒检测一次
  var AUTO_SIGN_IN = true;               // 遇到"过程签到"弹窗是否自动点签到（false=只提示不点）
  var ADV_KEY = 'cme_auto_advanced_v2';  // 自动切换标记，用于新页面自动开播
  // ===========================================

  var resumeCount = 0;
  var advCount = 0;
  var lastPos = 0;
  var lastDur = 0;
  var navigating = false;
  var hookedVideo = null;

  // ================= 基础工具 =================
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  function log(msg) {
    console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg);
  }
  function getVideo() {
    var vs = document.getElementsByTagName('video');
    return vs.length ? vs[0] : null;
  }
  function firstByClass(name) {
    var els = document.getElementsByClassName(name);
    return els.length ? els[0] : null;
  }
  function getApi() {
    var p = window.cc_js_Player;
    return (p && typeof p.play === 'function') ? p : null;
  }
  function fireClick(el) {
    if (!el) return false;
    ['mousedown', 'mouseup', 'click'].forEach(function (type) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  }

  // ================= 右侧课程目录 =================
  function getCourseList() {
    var wrap = document.getElementById('s_r_ml');
    if (!wrap) return [];
    var lis = wrap.getElementsByTagName('li');
    var items = [];
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var links = li.getElementsByTagName('a');
      if (!links.length) continue;
      var m = (links[0].getAttribute('onclick') || '').match(/kjJumpTo\('([^']+)','([^']*)'/);
      if (!m) continue;
      var sec = li.getElementsByTagName('span');
      items.push({
        url: m[1],
        name: m[2],
        sec: sec.length ? sec[0].textContent.trim() : ('第' + (i + 1) + '节'),
        active: li.className.indexOf('active') > -1
      });
    }
    return items;
  }
  function currentIndex(list) {
    for (var i = 0; i < list.length; i++) if (list[i].active) return i;
    return -1;
  }

  // ================= 弹窗处理 =================
  function handleSignIn() {
    var box = firstByClass('xywarp');
    if (!box) return false;
    if (!box.style.display || box.style.display === 'none') return false;

    if (AUTO_SIGN_IN) {
      var as = box.getElementsByTagName('a');
      if (as.length) {
        log('检测到「过程签到」弹窗 → 自动点击签到');
        fireClick(as[0]);
        setTimeout(function () { ensurePlaying('签到后恢复播放', 0); }, 800);
      } else {
        log('检测到「过程签到」弹窗，但没找到签到按钮，请手动处理');
      }
    } else {
      log('检测到「过程签到」弹窗，请手动签到（本次跳过检测）');
    }
    return true;
  }

  function clickHistoryBox() {
    var box = document.getElementById('ccH5historyTimeBox');
    if (!box) return false;
    if (box.style.display === 'none') return false;
    var jump = document.getElementById('ccH5jumpInto');
    if (jump) {
      log('点掉「上次观看到…」提示，从上次进度继续');
      fireClick(jump);
      return true;
    }
    return false;
  }

  function clickPlaySurface() {
    var targets = [
      document.getElementById('replaybtn'),
      firstByClass('ccH5PlayBtn2'),
      firstByClass('ccH5Poster'),
      firstByClass('ccH5playerBox')
    ];
    var clicked = false;
    for (var i = 0; i < targets.length; i++) {
      if (targets[i]) { fireClick(targets[i]); clicked = true; }
    }
    return clicked;
  }

  // ================= 播放保障 =================
  var playingCheckTimer = null;

  function ensurePlaying(reason, tries) {
    tries = tries || 0;
    attachVideoHooks();

    var v = getVideo();
    if (!v) {
      if (tries < 20) {
        setTimeout(function () { ensurePlaying(reason, tries + 1); }, 1000);
      } else {
        log(reason + '：长时间找不到视频元素，放弃本次');
      }
      return;
    }

    if (!v.paused && !v.ended && v.readyState >= 2) {
      if (tries === 0) log(reason + '：确认已在播放 ' + fmt(v.currentTime) + '/' + fmt(v.duration));
      return;
    }

    clickHistoryBox();

    var api = getApi();
    if (api) { try { api.play(); } catch (e) {} }

    var pr = null;
    try { pr = v.play(); } catch (e) {}

    if (pr && typeof pr.then === 'function') {
      pr.catch(function (err) {
        log(reason + '：play() 被拒绝（' + (err && err.name) + '）→ 静音后重试');
        try {
          v.muted = true;
          var p2 = v.play();
          if (p2 && p2.catch) {
            p2.catch(function (e2) {
              log(reason + '：静音后仍失败（' + (e2 && e2.name) + '），尝试点击播放器画面');
            });
          }
          setTimeout(function () { try { v.muted = false; } catch (e) {} }, 1500);
        } catch (e) {}
      });
    }

    if (playingCheckTimer) clearTimeout(playingCheckTimer);
    playingCheckTimer = setTimeout(function () {
      var v2 = getVideo();
      if (!v2) return;
      if (!v2.paused && !v2.ended) return;
      if (tries >= 12) {
        log(reason + '：多次尝试仍未播放，请手动点一下播放器');
        return;
      }
      clickPlaySurface();
      ensurePlaying(reason, tries + 1);
    }, 2500);
  }

  function attachVideoHooks() {
    var v = getVideo();
    if (!v || v === hookedVideo) return;
    hookedVideo = v;
    v.addEventListener('ended', function () {
      log('收到播放结束事件（ended）→ 准备切换下一条');
      setTimeout(check, 500);
    });
  }

  // ================= 切换下一条 =================
  function advance(list, idx) {
    if (navigating) return;
    if (idx >= list.length - 1) {
      log('已是最后一节，没有下一条可切换');
      return;
    }
    var next = list[idx + 1];
    navigating = true;
    advCount++;
    log('切换标识 #' + advCount + ' | 播放完毕 → 打开 ' + next.sec + '《' + next.name + '》');
    try { sessionStorage.setItem(ADV_KEY, '1'); } catch (e) {}
    window.location.href = next.url;
  }

  // ================= 定时检测 =================
  function check() {
    if (navigating) return;
    if (handleSignIn()) return;

    var list = getCourseList();
    var idx = currentIndex(list);
    var tag = idx >= 0
      ? '播放条目：' + list[idx].sec + '《' + list[idx].name + '》'
      : '播放条目未识别（目录共' + list.length + '条）';

    var v = getVideo();
    if (!v) {
      log(tag + ' | 未找到视频元素，3秒后重试');
      setTimeout(check, 3000);
      return;
    }

    attachVideoHooks();

    var dur = v.duration || 0;
    var pos = v.currentTime || 0;

    var ended = v.ended || (dur > 0 && pos >= dur - 1);
    if (!ended && dur > 0 && lastDur > 0 && lastPos >= lastDur - 2 && pos < 3) {
      ended = true;
      log('播放进度被重置回开头 → 判定为播放完毕');
    }

    var base = tag + ' | ' + fmt(pos) + '/' + fmt(dur);

    if (ended) {
      log(base + ' | 状态：已播放完毕 → 切换下一条');
      lastPos = 0;
      lastDur = 0;
      if (idx >= 0) advance(list, idx);
      return;
    }

    if (v.paused) {
      resumeCount++;
      log(base + ' | 状态：暂停（未播完）→ 自动续播  #' + resumeCount);
      ensurePlaying('续播', 0);
    } else {
      log(base + ' | 状态：正在播放');
    }

    lastPos = pos;
    lastDur = dur;
  }

  // ================= 启动 =================
  log('自动连播助手 v2.0（外部JS版）已启动（每30秒检测一次）');

  var cameFromAuto = false;
  try {
    cameFromAuto = sessionStorage.getItem(ADV_KEY) === '1';
    if (cameFromAuto) sessionStorage.removeItem(ADV_KEY);
  } catch (e) {}

  if (cameFromAuto) {
    log('检测到本页由脚本自动进入 → 立即开始自动播放');
    setTimeout(function () { ensurePlaying('自动开播', 0); }, 1500);
    setTimeout(function () { ensurePlaying('自动开播补救', 0); }, 8000);
  }

  setTimeout(check, 5000);
  setInterval(check, CHECK_INTERVAL);
})();