// "Install the app": lets members add the portal to their home screen.
// Android and desktop Chrome offer a real install prompt; iPhones need Share, then Add to Home Screen, so we show how.
(() => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (installed) return;
  const buttons = document.querySelectorAll('[data-install]');
  const card = document.getElementById('installCard');
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  let dismissed = false;
  try { dismissed = localStorage.getItem('installDismissed') === '1'; } catch (e) { /* private mode */ }

  let promptEvent = null;
  const show = () => {
    buttons.forEach(b => { b.hidden = false; });
    if (card && !dismissed) card.hidden = false;
  };

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptEvent = e; show(); });
  if (isIos) show();

  buttons.forEach(b => b.addEventListener('click', async () => {
    if (promptEvent) {
      promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === 'accepted') { buttons.forEach(x => { x.hidden = true; }); if (card) card.hidden = true; }
      promptEvent = null;
    } else if (isIos && window.bootstrap) {
      bootstrap.Modal.getOrCreateInstance(document.getElementById('iosInstall')).show();
    }
  }));

  window.addEventListener('appinstalled', () => { buttons.forEach(x => { x.hidden = true; }); if (card) card.hidden = true; });

  document.getElementById('installDismiss')?.addEventListener('click', () => {
    card.hidden = true;
    try { localStorage.setItem('installDismissed', '1'); } catch (e) { /* private mode */ }
  });
})();
