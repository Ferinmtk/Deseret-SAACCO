// "Install the app": lets members add the portal to their home screen.
// Offered in two places: the overview card, and once after the member's first M-Pesa payment.
// Android and desktop Chrome get the real install prompt; otherwise we show the steps.
// Once installed it stays hidden on that phone, even in the browser. In the demo it is never hidden, so it can be shown to the SACCO.
(() => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  const demo = document.body.dataset.demo === '1';
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: k => { try { localStorage.setItem(k, '1'); } catch (e) { /* private mode */ } },
  };
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) store.set('appInstalled'); // opened from the home screen, so this phone has it
  if (!demo && (standalone || store.get('appInstalled'))) return;

  const buttons = document.querySelectorAll('[data-install]');
  const cards = document.querySelectorAll('[data-install-card]');
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let promptEvent = null;

  const show = () => {
    buttons.forEach(b => { b.hidden = false; });
    cards.forEach(c => { if (demo || !store.get('installDismissed:' + c.dataset.installCard)) c.hidden = false; });
  };
  const hideAll = () => { buttons.forEach(b => { b.hidden = true; }); cards.forEach(c => { c.hidden = true; }); };

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptEvent = e; show(); });
  if (isIos || demo) show();

  // Chrome on Android can tell us if the app is already on the phone (see related_applications in the manifest).
  if (!demo && navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then(apps => { if (apps.length) { store.set('appInstalled'); hideAll(); } }).catch(() => {});
  }

  buttons.forEach(b => b.addEventListener('click', async () => {
    if (promptEvent) {
      promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      promptEvent = null;
      if (outcome === 'accepted' && !demo) hideAll();
      return;
    }
    const help = document.getElementById('installHelp');
    if (!help || !window.bootstrap) return;
    // Show only the steps for this phone; on a computer (e.g. a demo) show both.
    const android = /android/i.test(navigator.userAgent);
    help.querySelectorAll('[data-steps]').forEach(s => { s.hidden = (isIos && s.dataset.steps !== 'ios') || (android && s.dataset.steps !== 'android'); });
    bootstrap.Modal.getOrCreateInstance(help).show();
  }));

  window.addEventListener('appinstalled', () => { store.set('appInstalled'); if (!demo) hideAll(); });

  document.querySelectorAll('[data-install-dismiss]').forEach(x => x.addEventListener('click', () => {
    const card = x.closest('[data-install-card]');
    card.hidden = true;
    if (!demo) store.set('installDismissed:' + card.dataset.installCard);
  }));
})();
