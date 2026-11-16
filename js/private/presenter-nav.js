const nav = document.querySelector('.presenter-nav');

export function setPresenterKp(id) {
  if (!nav) return;
  const kp = /^kp\d{2}$/.test(id || '') ? id : 'kp00';
  nav.dataset.kp = kp;
  for (const link of nav.querySelectorAll('a[data-page-link]')) {
    link.href = `${link.dataset.pageLink}#${kp}`;
  }
}

// The report already tracks the current section for the stage and rail.
if (nav && document.documentElement.dataset.at) {
  const root = document.documentElement;
  const update = () => {
    const current = document.querySelector('#article .kp.is-current');
    setPresenterKp(root.dataset.at === 'cover' && !location.hash ? null : current?.id || location.hash.slice(1));
  };
  const observer = new MutationObserver(update);
  observer.observe(root, { attributes: true, attributeFilter: ['data-at'] });
  document.querySelectorAll('#article .kp').forEach((kp) => {
    observer.observe(kp, { attributes: true, attributeFilter: ['class'] });
  });
  window.addEventListener('hashchange', update);
  update();
}
