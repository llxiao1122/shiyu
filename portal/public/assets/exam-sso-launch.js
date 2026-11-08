const form = document.getElementById('exam-sso');
if (form) form.submit();

document.querySelector('[data-exam-frame-close]')?.addEventListener('click', () => {
    if (window.parent !== window) window.parent.postMessage({ type: 'exam-frame-close' }, location.origin);
});
