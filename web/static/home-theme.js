// Home page / installed app shell look: its own setting (auto = follow the phone's light/dark mode),
// independent of the theme chosen inside a game. Loaded in <head> so there is no flash.
(function () {
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    var pref = 'auto';
    try { pref = localStorage.getItem('wt_home_look') || 'auto'; } catch (e) {}
    var dark = pref === 'dark' || (pref === 'auto' && mq.matches);
    document.documentElement.dataset.theme = dark ? 'woogles-dark' : 'woogles';
    var m = document.querySelector('meta[name=theme-color]');
    if (m) m.content = dark ? '#282828' : '#eeeeee';
  }
  apply();
  mq.addEventListener('change', apply);
  window.wtHomeLook = apply;
})();
