const menuButton = document.querySelector('.menu-toggle');
const mobileNavigation = document.querySelector('#mobile-nav');

function closeMenu() {
  if (!menuButton || !mobileNavigation) return;
  menuButton.setAttribute('aria-expanded', 'false');
  mobileNavigation.hidden = true;
}

if (menuButton && mobileNavigation) {
  menuButton.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    mobileNavigation.hidden = !open;
  });
  mobileNavigation.addEventListener('click', event => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      menuButton.focus();
    }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.site-header')) closeMenu();
  });
  const desktop = matchMedia('(min-width: 761px)');
  desktop.addEventListener('change', event => { if (event.matches) closeMenu(); });
}

const webHelpButton = document.querySelector('#web-install');
const webHelp = document.querySelector('#web-help');
if (webHelpButton && webHelp) {
  webHelpButton.hidden = false;
  webHelpButton.setAttribute('aria-controls', 'web-help');
  webHelpButton.setAttribute('aria-expanded', 'false');
  webHelpButton.addEventListener('click', () => {
    webHelp.open = !webHelp.open;
    webHelpButton.setAttribute('aria-expanded', String(webHelp.open));
    if (webHelp.open) webHelp.querySelector('summary')?.focus();
  });
  webHelp.addEventListener('toggle', () => {
    webHelpButton.setAttribute('aria-expanded', String(webHelp.open));
  });
}

// Only animate off-screen content after observation is ready. Without JavaScript,
// reduced-motion preference, or IntersectionObserver every section stays visible.
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const revealTargets = [...document.querySelectorAll('[data-reveal]')];
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.06, rootMargin: '0px 0px 35px 0px' });
  for (const target of revealTargets) {
    if (target.getBoundingClientRect().top < innerHeight) target.classList.add('is-visible');
    else observer.observe(target);
  }
  document.documentElement.classList.add('has-reveal');
}
