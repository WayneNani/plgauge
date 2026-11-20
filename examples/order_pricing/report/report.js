(() => {
  const tipEl = document.getElementById('tip');
  let current = null;
  const show = (el) => {
    const src = document.getElementById(el.dataset.tip);
    if (!src) return;
    current = el;
    // copies the nodes; no second HTML parse of their text
    tipEl.replaceChildren(...[...src.childNodes].map((n) => n.cloneNode(true)));
    tipEl.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let y = r.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 8);
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  };
  const hide = () => { tipEl.hidden = true; current = null; };
  document.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); else if (current) hide(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', (e) => { const el = e.target.closest('[data-tip]'); if (el && el !== current) show(el); else if (!el) hide(); });
  window.addEventListener('scroll', hide, { passive: true });
})();
