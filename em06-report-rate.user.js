// ==UserScript==
// @name         ProtoArc HUB – EM06 Polling Rate Unlock
// @namespace    https://github.com/Nick768/EM06-ProtoArc-Hub-Patches
// @version      1.1.0
// @description  Shows the polling-rate selector (125/250/500/1000 Hz) for the ProtoArc EM06 in the official ProtoArc HUB and offers the (CSS-only) dark theme in the settings. Works by patching the app bundle in memory before it executes; nothing is uploaded, no data is sent anywhere.
// @author       Nick768
// @match        https://hub.protoarc.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * WHY THIS EXISTS
 * ---------------
 * In the shipped HUB bundle the EM06 is gated twice, both times inside the JS
 * (not in cfg.json, not in firmware):
 *
 *  1) isOfficeMouse() treats mid === 2 as an "office mouse"
 *     -> the General-Settings view only renders <div class="rate-dom"> when
 *        !isOfficeMouse, so the whole polling-rate panel is never mounted.
 *
 *  2) inside the rate panel, sensor === 3212 (the EM06 sensor) is sliced down
 *     to the first option (125 Hz) -> `.slice(0, 1)`.
 *
 * This script removes both gates for the EM06 only. Office mice (mid 4/5/6)
 * keep their original behaviour.
 *
 * The patch is anchored on structure (CSS class name "rate-dom", the
 * `ReportRates` i18n key, a `*.sensor == <n>` comparison), never on whole
 * minified expressions, so new bundle builds usually still match. Every
 * replacement is verified and logged; if nothing matches, the untouched
 * bundle is injected instead so the HUB keeps working.
 */

(function () {
  'use strict';

  const LOG = '[EM06-rate]';

  /* ===================== PATCH CORE (unit-tested) ===================== */
  // ==PATCH-CORE-BEGIN==
  const EM06_SENSOR = '3212'; // PAW3212, reported as cfg.deviceCfg.sensor
  const EM06_MID = 2;         // reported by the identify response (byte 10)

  // Optional extra: also restore the "Advanced Controls" tab (values 1/2/3/4 in
  // tabsList). For the EM06 this shows Click-Debounce and "Maximum Sensor
  // Performance", both of which are already present in the EM06's cfg entry;
  // every other advanced widget stays hidden because sensor.json does not list
  // sensor 3212 for ModeSelect/LOD/MotionSync/Angle/Ripple.
  const OPTIONS = { unlockAdvancedControls: false, darkTheme: true };
  // darkTheme: the hub ships only "light" in cfg.theme, although root.css does
  // contain a full `html[data-theme="dark"]` palette. This option adds a
  // "DarkTheme" entry to the theme picker (and keeps the choice across
  // reloads). Note: ProtoArc never shipped dark artwork – the 23 files under
  // img/Demo/mouse/dark/ are byte-identical to the light ones – so some
  // labels become hard to read (white --fonts-color on light button images).

  function patchBundle(src) {
    const report = { applied: [], warnings: [], ok: false };
    let out = src;

    /* ---- 1) rate option list: `xxx.sensor == 3212 ? slice(0,1) : ...` ---- */
    const gates = [];
    let m;
    // forward form:  x.sensor == 3212
    const gateRe = /\.sensor\s*===?\s*(["']?)(\d{1,5})\1/g;
    while ((m = gateRe.exec(out))) {
      if (m[2] === EM06_SENSOR) gates.push({ index: m.index, text: m[0] });
    }
    // reversed form: 3212 == x.sensor
    const gateRe2 = /(["']?)(\d{1,5})\1\s*===?\s*[A-Za-z_$][\w$.]*\.sensor\b/g;
    while ((m = gateRe2.exec(out))) {
      if (m[2] === EM06_SENSOR) gates.push({ index: m.index, text: m[0] });
    }
    if (gates.length) {
      // Prefer the gate that sits next to the ReportRates option list.
      const anchors = [];
      const aRe = /ReportRates/g;
      while ((m = aRe.exec(out))) anchors.push(m.index);
      const dist = (i) => (anchors.length ? Math.min.apply(null, anchors.map((a) => Math.abs(a - i))) : Infinity);
      const sorted = gates.slice().sort((a, b) => dist(a.index) - dist(b.index));
      const near = dist(sorted[0].index) < 4000;
      const chosen = near ? [sorted[0]] : gates;
      if (!near) report.warnings.push('rate-list gate found far from ReportRates – patching all matches');

      const edits = chosen
        .map((g) => ({
          start: g.index,
          end: g.index + g.text.length,
          // `.sensor==3212` -> `.sensor==-1`  (keeps operator, quoting and operand order)
          text: g.text.replace(/(["']?)\b\d{1,5}\b\1/, (all, q) => q + '-1' + q),
        }))
        .sort((a, b) => b.start - a.start);
      for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
      report.applied.push('rate-list-gate');
    } else {
      report.warnings.push('no `.sensor == ' + EM06_SENSOR + '` gate found (bundle changed or gate removed)');
    }

    /* ---- 2) panel visibility: `!store.isOfficeMouse` in the basic view ---- */
    // Idempotency: nothing to do if the guard is already permissive.
    if (out.indexOf('.isOfficeMouse||') !== -1) {
      report.applied.push('rate-panel-visibility(pre-existing)');
    } else {
      // The basic view renders dpi-dom / rate-dom / wheel-dom next to each other;
      // any of them is a valid structural anchor for the neighbouring computed.
      let anchor = -1;
      for (const a of ['rate-dom', 'dpi-dom', 'wheel-dom']) {
        const i = out.indexOf(a);
        if (i > -1 && (anchor < 0 || i < anchor)) anchor = i;
      }
      if (anchor < 0) {
        report.warnings.push('anchor (rate-dom/dpi-dom/wheel-dom) not found – panel visibility NOT patched');
      } else {
        // The basic view renders dpi-dom / rate-dom / wheel-dom next to each other;
        // any of them is a valid structural anchor for the neighbouring computed.
        const WINDOW = 8000; // how far the guard may sit before the anchor
        let anchor = -1;
        for (const a of ['rate-dom', 'dpi-dom', 'wheel-dom']) {
          const i = out.indexOf(a);
          if (i > -1 && (anchor < 0 || i < anchor)) anchor = i;
        }
        if (anchor < 0) {
          report.warnings.push('anchor (rate-dom/dpi-dom/wheel-dom) not found – panel visibility NOT patched');
        } else {
          const from = Math.max(0, anchor - WINDOW);
          const win = out.slice(from, anchor);
          const makeRepl = (v) =>
            '(!' + v + '.isOfficeMouse||(' + v + '.info!=null&&+' + v + '.info.mid===' + EM06_MID + '))';

          // last match before the anchor wins (that is the guard of this component)
          const forms = [
            ['A2', /!\s*\(\s*([A-Za-z_$][\w$]*)\.isOfficeMouse\s*\)/g],
            ['A1', /!\s*([A-Za-z_$][\w$]*)\.isOfficeMouse\b/g],
            ['B', /([A-Za-z_$][\w$]*)\.isOfficeMouse\s*===?\s*!1/g],
          ];
          let hit = null;
          for (const [id, re] of forms) {
            let mm;
            let last = null;
            while ((mm = re.exec(win))) last = { index: mm.index, len: mm[0].length, v: mm[1], form: id };
            if (last) {
              hit = last;
              break;
            }
          }

          if (hit) {
            const at = from + hit.index;
            out = out.slice(0, at) + makeRepl(hit.v) + out.slice(at + hit.len);
            report.applied.push('rate-panel-visibility(' + hit.form + ')');
          } else {
            report.warnings.push('no `isOfficeMouse` negation near "rate-dom" – panel visibility NOT patched');
          }
        }
      }
    }

    /* ---- 3) optional: restore the "Advanced Controls" tab for the EM06 ---- */
    if (OPTIONS.unlockAdvancedControls) {
      const tabRe =
        /\b([A-Za-z_$][\w$]*)\.isOfficeMouse\s*\?\s*([A-Za-z_$][\w$]*)\.filter\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\3\.value\s*!==?\s*3\s*\)/;
      const mt = tabRe.exec(out);
      if (mt) {
        const repl =
          mt[1] +
          '.isOfficeMouse?' +
          mt[2] +
          '.filter(' +
          mt[3] +
          '=>' +
          mt[3] +
          '.value!==3||(' +
          mt[1] +
          '.info!=null&&+' +
          mt[1] +
          '.info.mid===' +
          EM06_MID +
          '))';
        out = out.slice(0, mt.index) + repl + out.slice(mt.index + mt[0].length);
        report.applied.push('advanced-tab');
      } else {
        report.warnings.push('tabList office-mouse filter not found – advanced tab NOT unlocked');
      }
    }

    /* ---- 4) optional: offer the (CSS-only) dark theme in the theme picker ---- */
    if (OPTIONS.darkTheme) {
      // 4a) list: `cfg.theme.map(v=>({name:...,value:v}))` – add "dark" when the
      //     bundle/config only ships "light".
      const listRe =
        /((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\.theme\.map\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\(\{name:\2==="light"\?"LightTheme":"DarkTheme",value:\2\}\)\)/;
      const lm = listRe.exec(out);
      if (lm) {
        const arr =
          'Array.isArray(' + lm[1] + '.theme)?' + lm[1] + '.theme:["light"]';
        const repl =
          '((t)=>t.indexOf("dark")>-1?t:t.concat("dark"))(' +
          arr +
          ').map(' +
          lm[2] +
          '=>({name:' +
          lm[2] +
          '==="light"?"LightTheme":"DarkTheme",value:' +
          lm[2] +
          '}))';
        out = out.slice(0, lm.index) + repl + out.slice(lm.index + lm[0].length);
        report.applied.push('dark-theme-list');
      } else if (out.indexOf('indexOf("dark")>-1') !== -1) {
        report.applied.push('dark-theme-list(pre-existing)');
      } else {
        report.warnings.push('theme list (LightTheme/DarkTheme map) not found – dark theme NOT offered');
      }

      // 4b) boot: `n.theme=Xh(cfg.theme)` ignores the stored choice when
      //     cfg.theme is an array, so a picked theme would reset on reload.
      const bootRe =
        /([A-Za-z_$][\w$]*)\.theme\s*=\s*Xh\(\s*([A-Za-z_$][\w$]*)\.value\.theme\s*\)/;
      const bm = bootRe.exec(out);
      if (bm) {
        const repl =
          bm[1] +
          '.theme=Xh((function(){try{var s=window.localStorage.getItem("theme");' +
          'if(s!==null){var v=JSON.parse(s);if(v==="dark"||v==="light")return v}' +
          '}catch(e){}return ' +
          bm[2] +
          '.value.theme})())';
        out = out.slice(0, bm.index) + repl + out.slice(bm.index + bm[0].length);
        report.applied.push('dark-theme-boot');
      } else if (out.indexOf('localStorage.getItem("theme")') !== -1) {
        report.applied.push('dark-theme-boot(pre-existing)');
      } else {
        report.warnings.push('theme boot call `x.theme=Xh(y.value.theme)` not found – theme choice NOT persisted');
      }
    }

    report.ok = report.applied.some((x) => x.indexOf('rate-panel-visibility') === 0);
    if (!report.ok) report.warnings.push('patch incomplete – injecting bundle unpatched');
    return { code: out, report };
  }
  // ==PATCH-CORE-END==

  /* ========================== BOOT / INJECTION ========================== */
  const SENTINEL = '__em06HubBoot';

  function pickBundle() {
    const all = Array.prototype.slice.call(document.querySelectorAll('script[type="module"][src]'));
    if (!all.length) return null;
    const looksLikeApp = (s) => /\/assets\/[^/]*\.js(\?|#|$)/.test(s.getAttribute('src') || '');
    return all.filter(looksLikeApp)[0] || all[0];
  }

  function waitFor(fn, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function tick() {
        let v = false;
        try {
          v = !!fn();
        } catch (e) {
          v = false;
        }
        if (v) return resolve(true);
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        setTimeout(tick, 40);
      })();
    });
  }

  function addScript(codeOrUrl, kind, withSentinel) {
    const s = document.createElement('script');
    s.type = 'module';
    s.setAttribute('data-em06-patch', kind);
    if (kind === 'inline') s.textContent = withSentinel ? codeOrUrl + '\n;try{window.' + SENTINEL + '=1}catch(e){}\n' : codeOrUrl;
    else s.src = codeOrUrl;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }

  function restoreOriginal(url) {
    const s = document.createElement('script');
    s.type = 'module';
    s.src = url;
    (document.head || document.documentElement).appendChild(s);
  }

  async function injectPatched(code, url) {
    const withSentinel = code + '\n;try{window.' + SENTINEL + '=1}catch(e){}\n';

    // 1) inline module – keeps relative-URL semantics of the original script
    try {
      delete window[SENTINEL];
      let el = addScript(withSentinel, 'inline', false);
      if (await waitFor(() => window[SENTINEL] === 1, 2500)) return true;
      el.remove();
      console.info(LOG, 'inline injection did not run (CSP?) – trying blob');
    } catch (e) {
      console.warn(LOG, 'inline injection failed', e);
    }

    // 2) blob module
    try {
      const blob = URL.createObjectURL(new Blob([withSentinel], { type: 'text/javascript' }));
      delete window[SENTINEL];
      const el = addScript(blob, 'blob', false);
      if (await waitFor(() => window[SENTINEL] === 1, 2500)) {
        setTimeout(() => URL.revokeObjectURL(blob), 10000);
        return true;
      }
      el.remove();
      URL.revokeObjectURL(blob);
      console.warn(LOG, 'blob injection did not run – falling back to original bundle');
    } catch (e) {
      console.warn(LOG, 'blob injection failed', e);
    }

    // 3) last resort: original bundle, unpatched
    try {
      restoreOriginal(url);
    } catch (e) {
      console.error(LOG, 'could not restore original bundle', e);
    }
    return false;
  }

  async function hijack(el) {
    const url = el.getAttribute('src');
    el.remove(); // cancel execution of the unpatched bundle

    let original;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      original = await res.text();
    } catch (err) {
      console.error(LOG, 'cannot read bundle, restoring original', err);
      try {
        restoreOriginal(url);
      } catch (e) {
        /* ignore */
      }
      return;
    }

    let result;
    try {
      result = patchBundle(original);
    } catch (err) {
      console.error(LOG, 'patch routine crashed, restoring original', err);
      restoreOriginal(url);
      return;
    }

    const r = result.report;
    console.info(
      LOG,
      'patch ' + (r.ok ? 'OK' : 'INCOMPLETE'),
      '| applied:', r.applied.join(', ') || '(none)',
      r.warnings.length ? '| warnings: ' + r.warnings.join(' ; ') : ''
    );

    const ok = await injectPatched(result.code, url);
    if (!ok) console.warn(LOG, 'patch not active – HUB runs unpatched');
  }

  let started = false;
  function scan() {
    if (started) return;
    const el = pickBundle();
    if (!el) return;
    started = true;
    try {
      observer.disconnect();
    } catch (e) {
      /* ignore */
    }
    hijack(el).catch((e) => console.error(LOG, 'unexpected failure', e));
  }

  const observer = new MutationObserver(scan);
  try {
    observer.observe(document, { childList: true, subtree: true });
  } catch (e) {
    /* ignore */
  }
  // document-start: the <script> may already be there in exotic cases
  scan();

  // If we were too late (bundle already executed), say so instead of silently doing nothing.
  window.addEventListener('DOMContentLoaded', function () {
    const app = document.getElementById('app');
    if (!started && app && app.children.length) {
      console.warn(LOG, 'bundle had already executed – reload the page (Ctrl+Shift+R) to apply the patch');
    }
  });
})();
