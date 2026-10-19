/*!
 * Slotwise booking embed. Paste on any website:
 *
 *   Inline calendar:  <script src="https://YOUR-SLOTWISE/embed.js" data-business="your-slug" async></script>
 *   Button + pop-up:  <script src="https://YOUR-SLOTWISE/embed.js" data-business="your-slug" data-mode="button" data-label="Book now" async></script>
 *   Floating button:  ... data-mode="floating" ...
 *   Your own button:  add data-slotwise-open to any link or button on a page that has one of the scripts above.
 *
 * Options: data-service="<service id>" (open on one service), data-color="#2f6fed",
 *          data-theme="light|dark", data-header="0" (hide business name/address), data-target="#css-selector".
 */
(function () {
  var script = document.currentScript;
  if (!script || !script.dataset.business) return;
  var origin = new URL(script.src).origin;
  var d = script.dataset;
  var mode = d.mode || "inline";
  var color = /^#?[0-9a-f]{6}$/i.test(d.color || "") ? "#" + d.color.replace("#", "") : "#2f6fed";

  function frameUrl() {
    var q = [];
    if (d.service) q.push("service=" + encodeURIComponent(d.service));
    if (d.theme) q.push("theme=" + encodeURIComponent(d.theme));
    if (d.header === "0") q.push("header=0");
    q.push("color=" + encodeURIComponent(color.slice(1)));
    return origin + "/embed/" + encodeURIComponent(d.business) + "?" + q.join("&");
  }

  function makeFrame(minHeight) {
    var f = document.createElement("iframe");
    f.src = frameUrl();
    f.title = "Book an appointment";
    f.loading = "lazy";
    f.allow = "payment";
    f.style.cssText = "width:100%;border:0;display:block;min-height:" + minHeight + "px;background:transparent;";
    return f;
  }

  // Page-wide listeners are shared by every snippet on the page, so they're installed once.
  var shared = window.__slotwiseEmbed || (window.__slotwiseEmbed = { origins: {}, opener: null, clicks: false });

  // The booking page reports its height so the frame grows with it (no inner scrollbar).
  if (!shared.origins[origin]) shared.origins[origin] = true, window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || typeof e.data !== "object") return;
    var frames = document.querySelectorAll("iframe[data-slotwise]");
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow !== e.source) continue;
      if (e.data.type === "slotwise:height" && frames[i].dataset.slotwise === "inline") frames[i].style.height = e.data.height + "px";
      // Lets the site track conversions: window.addEventListener("slotwise:booked", ...)
      if (e.data.type === "slotwise:booked") window.dispatchEvent(new CustomEvent("slotwise:booked", { detail: e.data }));
    }
  });

  function insertHere(node) {
    var target = d.target && document.querySelector(d.target);
    if (target) target.appendChild(node);
    else script.parentNode.insertBefore(node, script);
  }

  var overlay;
  function openPopup() {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Book an appointment");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;";
      var box = document.createElement("div");
      box.style.cssText = "position:relative;width:100%;max-width:760px;height:min(90vh,900px);background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.3);";
      var close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.textContent = "×";
      close.style.cssText = "position:absolute;top:6px;right:10px;z-index:1;border:0;background:#fff;font:28px/1 sans-serif;cursor:pointer;color:#333;padding:4px 8px;border-radius:8px;";
      var frame = makeFrame(0);
      frame.dataset.slotwise = "popup";
      frame.style.height = "100%";
      box.appendChild(close);
      box.appendChild(frame);
      overlay.appendChild(box);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) hide(); });
      close.addEventListener("click", hide);
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
      document.body.appendChild(overlay);
    }
    overlay.style.display = "flex";
    document.documentElement.style.overflow = "hidden";
  }
  function hide() {
    if (overlay) overlay.style.display = "none";
    document.documentElement.style.overflow = "";
  }

  function makeButton(floating) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = d.label || "Book now";
    b.style.cssText = "font:600 16px/1.2 system-ui,-apple-system,sans-serif;color:#fff;background:" + color +
      ";border:0;border-radius:999px;padding:14px 26px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);" +
      (floating ? "position:fixed;right:20px;bottom:20px;z-index:2147482999;" : "");
    b.addEventListener("click", openPopup);
    return b;
  }

  function start() {
    if (mode === "inline") {
      var f = makeFrame(640);
      f.dataset.slotwise = "inline";
      insertHere(f);
    } else if (mode === "floating") {
      document.body.appendChild(makeButton(true));
    } else {
      insertHere(makeButton(false));
    }
    // Any element the site marks with data-slotwise-open opens the pop-up (the first pop-up snippet's, else the first snippet's).
    if (!shared.opener || (mode !== "inline" && shared.openerMode === "inline")) shared.opener = openPopup, shared.openerMode = mode;
    if (!shared.clicks) {
      shared.clicks = true;
      document.addEventListener("click", function (e) {
        var el = e.target.closest && e.target.closest("[data-slotwise-open]");
        if (el && shared.opener) { e.preventDefault(); shared.opener(); }
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
