document.addEventListener('pointerup', event => {
    const button = event.target.closest('.dashboard-icon-button');
    if (button && event.pointerType !== '') requestAnimationFrame(() => button.blur());
});
function applyTheme(theme) {
    const dark = theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = dark ? '#181818' : '#ffffff';
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
        button.setAttribute('aria-pressed', String(dark));
        button.setAttribute('aria-label', dark ? '切换浅色模式' : '切换深色模式');
        button.title = dark ? '切换浅色模式' : '切换深色模式';
    });
    document.querySelectorAll('iframe').forEach(frame => {
        try { if (frame.contentDocument) frame.contentDocument.documentElement.dataset.theme = dark ? 'dark' : 'light'; } catch {}
    });
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem('learning-theme') || 'light'; } catch {}
applyTheme(savedTheme);
document.addEventListener('click', event => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('learning-theme', next); } catch {}
    applyTheme(next);
});
document.addEventListener('livewire:navigated', () => applyTheme(document.documentElement.dataset.theme));

document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-toggle-password]');
    if (!button) return;
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? '隐藏' : '显示';
    button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
});

document.addEventListener('click', (event) => {
    const dialog = document.querySelector('.exit-dialog');
    if (!dialog) return;
    if (event.target.closest('[data-exit-open]')) dialog.showModal();
    if (event.target.closest('[data-exit-close]')) dialog.close();
});

window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'exam-frame-close') return;
    document.querySelector('[data-exam-frame-close]')?.click();
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.querySelector('.exam-frame-backdrop')) {
        document.querySelector('[data-exam-frame-close]')?.click();
    }
});

function cachedExamPreview(group) {
    try {
        const course = JSON.parse(sessionStorage.getItem('exam-prefetch:course:' + group) || 'null');
        if (!course || Date.now() - course.at >= 45000 || !Array.isArray(course.value) || course.value.length !== 1) return null;
        const detail = JSON.parse(sessionStorage.getItem('exam-prefetch:detail:' + course.value[0].id) || 'null');
        return detail && Date.now() - detail.at < 45000 && detail.value?.detail ? detail.value.detail : null;
    } catch { return null; }
}

window.addEventListener('message', (event) => {
    const frame = document.querySelector('iframe[data-exam-launch]');
    if (event.origin !== location.origin || event.source !== frame?.contentWindow || event.data?.type !== 'exam-detail-ready') return;
    frame.hidden = false;
    const loading = frame.parentElement.querySelector('[data-exam-loading]');
    if (loading) loading.hidden = true;
});

document.addEventListener('click', (event) => {
    const trigger = event.target.closest('.exam-course-row[data-exam-launch]');
    if (!trigger || trigger.disabled || document.querySelector('.exam-frame-backdrop')) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const componentId = trigger.closest('[wire\\:id]')?.getAttribute('wire:id');
    let verifiedSinglePass = false;
    let verifiedPass = false;
    const onVerifiedPass = event => {
        if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'exam-verified-pass' || event.data.group !== trigger.dataset.examGroup) return;
        verifiedPass = true;
        try {
            const cached = JSON.parse(sessionStorage.getItem('exam-prefetch:course:' + event.data.group) || 'null');
            verifiedSinglePass = Array.isArray(cached?.value) && cached.value.length === 1;
        } catch {}
    };
    window.addEventListener('message', onVerifiedPass);

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop exam-frame-backdrop';
    const modal = document.createElement('section');
    modal.className = 'modal exam-frame-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '考试详情');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close-button exam-frame-close';
    close.dataset.examFrameClose = '';
    close.setAttribute('aria-label', '关闭考试');
    close.textContent = '×';
    const viewport = document.createElement('div');
    viewport.className = 'exam-frame-viewport';
    let loading = document.createElement('p');
    loading.className = 'exam-frame-loading';
    loading.dataset.examLoading = '';
    loading.textContent = '正在打开考试…';
    const cached = cachedExamPreview(trigger.dataset.examGroup);
    if (cached) {
        const preview = document.createElement('div');
        preview.className = 'exam-frame-preview';
        preview.dataset.examLoading = '';
        const previewTitle = document.createElement('h2');
        previewTitle.textContent = '考试详情';
        preview.append(previewTitle);
        for (const [label, value] of [['名称', cached.title], ['允许次数', cached.attempt === 0 ? '不限' : cached.attempt], ['剩余次数', cached.attempt === 0 ? '不限' : cached.myAttempt], ['题目数量', cached.questionNum], ['总分', cached.score], ['及格分', cached.passScore], ['考试时长（分钟）', cached.time]]) {
            if (value === undefined || value === null || value === '') continue;
            const row = document.createElement('p');
            row.textContent = label + '：' + String(value);
            preview.append(row);
        }
        const message = document.createElement('p');
        message.className = 'muted';
        message.textContent = '正在核对考试状态…';
        preview.append(message);
        loading = preview;
    }
    const frame = document.createElement('iframe');
    frame.dataset.examLaunch = trigger.dataset.examLaunch;
    frame.dataset.examTraining = trigger.dataset.examTraining;
    frame.dataset.examGroup = trigger.dataset.examGroup;
    frame.title = trigger.dataset.examTraining + '考试详情';
    frame.referrerPolicy = 'no-referrer';
    frame.hidden = true;
    frame.addEventListener('load', () => {
        try { if (frame.contentWindow.location.href === 'about:blank') return; } catch {}
        const reveal = () => { if (frame.isConnected) { frame.hidden = false; const current = viewport.querySelector('[data-exam-loading]'); if (current) current.hidden = true; } };
        if (cached) setTimeout(reveal, 3000); else reveal();
    });
    viewport.append(loading, frame);
    modal.append(close, viewport);
    backdrop.append(modal);
    const dismiss = () => {
        backdrop.remove();
        window.removeEventListener('message', onVerifiedPass);
        document.documentElement.classList.remove('exam-frame-open');
        const group = trigger.dataset.examGroup;
        const applyOptimisticPass = () => {
            if (!verifiedSinglePass) return;
            const row = [...document.querySelectorAll('.exam-course-row')].find(item => item.dataset.examGroup === group);
            if (row && row.style.display !== 'none') row.style.display = 'none';
            const list = row?.closest('.course-list');
            if (list && ![...list.querySelectorAll('.course-row')].some(item => item.style.display !== 'none') && !list.querySelector('[data-optimistic-empty]')) {
                const empty = document.createElement('p'); empty.className = 'empty-state'; empty.dataset.optimisticEmpty = ''; empty.textContent = '你已经都考完了'; list.append(empty);
            }
            const counter = document.querySelector('.metric-button[wire\\:click="openPanel(\'exams\')"] strong');
            if (counter && !counter.dataset.optimisticPass && /^\d+$/.test(counter.textContent.trim())) {
                counter.dataset.optimisticPass = counter.textContent.trim();
                counter.textContent = String(Math.max(0, Number(counter.textContent) - 1));
            }
        };
        const clearOptimisticPass = () => {
            document.querySelectorAll('.exam-course-row').forEach(row => { if (row.dataset.examGroup === group) row.style.removeProperty('display'); });
            const counter = document.querySelector('.metric-button[wire\\:click="openPanel(\'exams\')"] strong');
            if (counter?.dataset.optimisticPass) { const list = document.querySelector('.exam-list-modal .course-list'); counter.textContent = list ? String(list.querySelectorAll('.course-row').length) : counter.dataset.optimisticPass; delete counter.dataset.optimisticPass; }
            document.querySelectorAll('[data-optimistic-empty]').forEach(item => item.remove());
        };
        applyOptimisticPass();
        try {
            sessionStorage.removeItem('exam-prefetch:course:' + trigger.dataset.examGroup);
            if (componentId && verifiedPass) {
                document.documentElement.classList.add('exam-background-refresh');
                let sawScan = false;
                const observer = new MutationObserver(() => {
                    const dashboard = document.querySelector('.dashboard');
                    if (!dashboard) return;
                    applyOptimisticPass();
                    if (dashboard.dataset.scanActive === 'true') {
                        sawScan = true;
                        dashboard.querySelectorAll('[inert]').forEach(element => element.removeAttribute('inert'));
                    } else if (sawScan) { observer.disconnect(); clearOptimisticPass(); document.documentElement.classList.remove('exam-background-refresh'); }
                });
                observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['data-scan-active','inert']});
                setTimeout(() => { if (!sawScan) { observer.disconnect(); clearOptimisticPass(); document.documentElement.classList.remove('exam-background-refresh'); } }, 10000);
                setTimeout(() => { observer.disconnect(); clearOptimisticPass(); document.documentElement.classList.remove('exam-background-refresh'); }, 120000);
                Promise.resolve(window.Livewire?.find(componentId)?.$call('refresh', true)).catch(() => { observer.disconnect(); clearOptimisticPass(); document.documentElement.classList.remove('exam-background-refresh'); });
            }
        } catch { document.documentElement.classList.remove('exam-background-refresh'); }
        if (trigger.isConnected) trigger.focus();
    };
    close.addEventListener('click', dismiss);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) dismiss(); });
    document.documentElement.classList.add('exam-frame-open');
    document.body.append(backdrop);
    close.focus();
}, true);

// The hidden frame establishes the same account before a course is opened.
let examPreloadReadyAt = 0;
let examPreloadActive = true;
const examPreloadWaiters = new Set();
function clearExamPrefetch() {
    try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
            const key = sessionStorage.key(i);
            if (key?.startsWith('exam-prefetch:')) sessionStorage.removeItem(key);
        }
    } catch {}
}
window.addEventListener('message', (event) => {
    const frame = document.querySelector('iframe[data-exam-launch]');
    if (event.origin !== location.origin || event.source !== frame?.contentWindow || event.data?.type !== 'exam-session-expired' || frame.dataset.examRetried) return;
    frame.dataset.examRetried = '1';
    examPreloadActive = false;
    const preloader = document.getElementById('exam-preloader');
    if (preloader) preloader.src = 'about:blank';
    clearExamPrefetch();
    frame.src = frame.dataset.examLaunch;
});
window.addEventListener('message', (event) => {
    const preloader = document.getElementById('exam-preloader');
    if (!examPreloadActive || event.origin !== location.origin || event.source !== preloader?.contentWindow || !['exam-preload-ready', 'exam-preload-failed'].includes(event.data?.type)) return;
    const ready = event.data.type === 'exam-preload-ready';
    if (ready) {
        examPreloadReadyAt = Date.now();
        let courses = [];
        try { courses = JSON.parse(document.querySelector('[data-exam-prefetch-courses]')?.dataset.examPrefetchCourses || '[]'); } catch {}
        preloader.contentWindow.postMessage({type: 'exam-preload-ack', courses: Array.isArray(courses) ? courses.slice(0, 100) : []}, location.origin);
    }
    else examPreloadActive = false;
    for (const resolve of examPreloadWaiters) resolve(ready);
    examPreloadWaiters.clear();
});

async function prepareExamFrames() {
    for (const frame of document.querySelectorAll('iframe[data-exam-launch]:not([data-exam-started])')) {
        frame.dataset.examStarted = '1';
        let ready = examPreloadReadyAt > 0 && Date.now() - examPreloadReadyAt < 45 * 60 * 1000;
        const preloader = document.getElementById('exam-preloader');
        if (!ready && preloader && examPreloadActive) {
            ready = await new Promise((resolve) => {
                const finish = value => { clearTimeout(timer); examPreloadWaiters.delete(finish); resolve(value); };
                const timer = setTimeout(() => finish(false), 8000);
                examPreloadWaiters.add(finish);
            });
        }
        if (!frame.isConnected) continue;
        if (ready) {
            const query = new URLSearchParams({training: frame.dataset.examTraining, frame: '1'});
            if (frame.dataset.examGroup) query.set('group', frame.dataset.examGroup);
            frame.src = '/zgxy/?' + query.toString();
        } else {
            examPreloadActive = false;
            if (preloader) preloader.src = 'about:blank';
            clearExamPrefetch();
            frame.dataset.examRetried = '1';
            frame.src = frame.dataset.examLaunch;
        }
    }
}
new MutationObserver(() => { void prepareExamFrames(); }).observe(document.documentElement, {childList: true, subtree: true});
void prepareExamFrames();

document.addEventListener('click', event => {
    const dialog = document.querySelector('.support-dialog');
    if (!dialog) return;
    if (event.target.closest('[data-support-open]')) dialog.showModal();
    if (event.target.closest('[data-support-close]')) dialog.close();
    if (event.target === dialog) dialog.close();
});
