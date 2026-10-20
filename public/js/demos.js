// Small "show, don't tell" animations used across the public pages:
//   .pay-scene   (Home)      a member pays by M-Pesa and her balance and loan limit rise
//   .stmt-scene  (Join)      a deposit lands on a statement, then a guarantor accepts
//   #calc        (Services)  savings calculator
// Each scene loops while it is on screen. People who turn off motion see the end state.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const kes = n => 'KES ' + n.toLocaleString('en-KE');

  // Count a number up, easing out, over about a second.
  const countUp = (el, from, to) => {
    const start = performance.now();
    const step = t => {
      const p = Math.min((t - start) / 1100, 1);
      el.textContent = kes(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // The CSS plays the sequence; this starts it and runs the number count-ups.
  // data-lands-at is when (ms) the deposit lands, so the counts start just after it.
  const play = scene => {
    const landsAt = +scene.dataset.landsAt || 0;
    const counters = scene.querySelectorAll('[data-count-from]');
    (scene._timers || []).forEach(clearTimeout);
    scene._timers = [];
    scene.classList.remove('play', 'done');
    counters.forEach(el => { el.textContent = kes(+el.dataset.countFrom); });
    if (reduced) {
      scene.classList.add('done');
      counters.forEach(el => { el.textContent = kes(+el.dataset.countTo); });
      return;
    }
    void scene.offsetWidth; // restart the CSS animations
    scene.classList.add('play');
    counters.forEach(el => scene._timers.push(setTimeout(
      () => countUp(el, +el.dataset.countFrom, +el.dataset.countTo),
      landsAt + 150 + (+el.dataset.countDelay || 0))));
  };

  // Loop while the scene is on screen; data-loop-ms is the full cycle, including a pause on the end state.
  document.querySelectorAll('.pay-scene, .stmt-scene').forEach(scene => {
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !scene._loop) {
        play(scene);
        if (!reduced) scene._loop = setInterval(() => play(scene), +scene.dataset.loopMs);
      } else if (!entry.isIntersecting && scene._loop) {
        clearInterval(scene._loop);
        scene._loop = null;
      }
    }, { threshold: 0.6 }).observe(scene.querySelector('[data-scene-card]') || scene);
  });

  // Savings calculator: deposits after 12 months and the 3× loan limit.
  const range = document.getElementById('calcRange');
  if (range) {
    const bars = document.querySelectorAll('.calc-bars i');
    const update = () => {
      const m = +range.value, min = +range.min, max = +range.max;
      range.style.setProperty('--p', ((m - min) / (max - min) * 100) + '%');
      document.getElementById('calcAmt').textContent = kes(m);
      document.getElementById('calcDep').textContent = kes(m * 12);
      document.getElementById('calcLim').textContent = kes(m * 36);
      // Bars keep their shape (month 1 to 12) and grow taller with the amount saved.
      const scale = 0.35 + 0.65 * (m - min) / (max - min);
      bars.forEach((b, i) => { b.style.height = ((i + 1) / 12 * 100 * scale) + '%'; });
    };
    range.addEventListener('input', update);
    update();
  }
})();
