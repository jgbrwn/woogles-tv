// CSS confetti: returns HTML for n falling pieces (styles in app.css).
const COLORS = ['var(--t-bg)', 'var(--primary)', 'var(--secondary)', 'var(--warn)', 'var(--good)', 'var(--b-tw)', 'var(--b-dl)'];
export function confetti(n = 60) {
  let h = '<div class="confetti">';
  for (let i = 0; i < n; i++) {
    const left = Math.random() * 100, delay = Math.random() * 0.6, dur = 2.2 + Math.random() * 1.4, rot = Math.random() * 720 - 360;
    const size = 0.6 + Math.random() * 0.8, c = COLORS[i % COLORS.length], drift = Math.random() * 30 - 15;
    h += `<i style="left:${left}%;background:${c};width:${size}em;height:${size * 0.45}em;animation-delay:${delay}s;animation-duration:${dur}s;--rot:${rot}deg;--drift:${drift}vw"></i>`;
  }
  return h + '</div>';
}
