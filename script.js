document.getElementById('year').textContent = new Date().getFullYear();

const hero = document.querySelector('.hero');

if (hero && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  hero.addEventListener('pointermove', (event) => {
    const bounds = hero.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    hero.style.setProperty('--move-x', `${x * -18}px`);
    hero.style.setProperty('--move-y', `${y * -14}px`);
    hero.style.setProperty('--light-x', `${(x + 0.5) * 100}%`);
    hero.style.setProperty('--light-y', `${(y + 0.5) * 100}%`);
  });

  hero.addEventListener('pointerleave', () => {
    hero.style.setProperty('--move-x', '0px');
    hero.style.setProperty('--move-y', '0px');
  });
}
