if (new URLSearchParams(location.search).get('frame') === '1') {
  document.documentElement.classList.add('exam-frame-mode');
}

try { document.documentElement.dataset.theme = localStorage.getItem('learning-theme') === 'dark' ? 'dark' : 'light'; } catch {}
window.addEventListener('storage', event => { if (event.key === 'learning-theme') document.documentElement.dataset.theme = event.newValue === 'dark' ? 'dark' : 'light'; });
