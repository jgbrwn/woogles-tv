// The "starting up" screen (web/starting.html), served in place of any page while the server gets ready
// (startup.go). It shows the step the server reports and reloads the page the person asked for once it is ready.
(() => {
  try { const t = localStorage.getItem('wt_theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  const $ = (id) => document.getElementById(id);
  const order = ['lists', 'rooms', 'extras'];
  let last = '';
  function paint(j) {
    if (!j.step) { // the server isn't answering at all (it is restarting)
      $('label').innerHTML = 'Waiting for the server<span class="dots"></span>';
      $('detail').textContent = 'Woogles-TV is restarting. This page opens the game by itself.';
      return;
    }
    if (j.label + j.detail !== last) {
      last = j.label + j.detail;
      $('label').innerHTML = '';
      $('label').append(j.label, Object.assign(document.createElement('span'), { className: 'dots' }));
      $('detail').textContent = j.detail || ' ';
    }
    $('slow').textContent = j.slow || '';
    $('slow').classList.toggle('hidden', !j.slow);
    const at = order.indexOf(j.step);
    for (const li of $('steps').children) {
      const i = order.indexOf(li.dataset.k);
      li.classList.toggle('done', i < at);
      li.classList.toggle('now', i === at);
    }
  }
  async function poll() {
    let j = {};
    try {
      const r = await fetch('/api/ready', { cache: 'no-store' });
      j = await r.json();
      if (j.ready) { location.reload(); return; }
    } catch {}
    paint(j);
    setTimeout(poll, 700);
  }
  poll();
})();
