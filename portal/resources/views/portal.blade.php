<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
    <meta name="theme-color" content="#ffffff">
    <style>html[data-theme="dark"]{background:#181818;color-scheme:dark}html[data-theme="light"]{background:#fff;color-scheme:light}</style>
    <script nonce="{{ request()->attributes->get('csp_nonce') }}">try{document.documentElement.dataset.theme=localStorage.getItem('learning-theme')==='dark'?'dark':'light';document.querySelector('meta[name="theme-color"]').content=document.documentElement.dataset.theme==='dark'?'#181818':'#ffffff'}catch{}</script>
    <title>识阈</title>
    <link rel="preload" href="{{ asset('assets/fonts/quan-pixel-8px-square.woff2') }}" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="{{ asset('assets/portal.css') }}?v=20261108-26">
    @if ($connected)
        @livewireStyles
    @endif
</head>
<body class="{{ $connected ? 'dashboard-page' : 'login-page' }}">
    <header class="site-header">
        <div class="wrap header-inner">
            <a class="brand" href="{{ route('home') }}"><span class="brand-mark">识</span><span>识阈</span></a>
            <span class="header-tag">课件托管</span>
        </div>
    </header>


    <main class="wrap">
        @if (!$connected)
            <section class="hero">
                <div class="hero-copy">
                    <p class="eyebrow">识阈</p>
                    <h1>课件自动学习</h1>
                    <p class="hero-lede">自动学习，随时查看进度。</p>
                </div>
                <section class="entry-panel" aria-label="登录并授权">
                    <p class="login-site-name"><span>识</span><span>阈</span></p>
                    <h2>登录并授权</h2>
                    <p class="muted">使用学习平台账号。</p>
                    <form method="post" action="{{ route('login') }}" autocomplete="off">
                        @csrf
                        <label class="field" for="org-code"><span class="field-label">机构编号</span><input id="org-code" placeholder="机构编号" name="org_code" value="{{ old('org_code', '') }}" maxlength="128" required autocapitalize="characters" spellcheck="false"></label>
                        <label class="field" for="username"><span class="field-label">账号</span><input id="username" placeholder="账号" name="username" value="{{ old('username') }}" maxlength="256" required autocapitalize="none" spellcheck="false"></label>
                        <label class="field" for="password"><span class="field-label">官方平台密码</span><span class="password-row"><input id="password" placeholder="官方平台密码" name="password" type="password" maxlength="512" required autocomplete="off"><button class="show-password" type="button" data-toggle-password="password" aria-label="显示密码">显示</button></span></label>
                        <label class="consent"><input type="checkbox" name="consent" value="1" required><span>我同意加密保存平台账号和学习记录，并授权托管新增文件和视频课件。关闭网页后仍会继续处理。</span></label>
                        <button class="primary-button" type="submit">登录</button>
                        @if ($errors->any())<p class="notice error" role="alert">{{ $errors->first() }}</p>@endif
                    </form>
                </section>
            </section>
        @else
            @if (session('status'))<p class="notice success" role="status">{{ session('status') }}</p>@endif
            @if ($errors->any())<p class="notice error" role="alert">{{ $errors->first() }}</p>@endif
            <livewire:learning-dashboard />
            <iframe id="exam-preloader" src="{{ route('exam.launch', ['training' => '__exam_preload__']) }}" hidden tabindex="-1" aria-hidden="true" title="考试准备"></iframe>
        @endif
    </main>

    @if (!$connected)
        <div class="login-theme-position"><button class="dashboard-icon-button login-theme-toggle" type="button" data-theme-toggle title="切换深色模式" aria-label="切换深色模式" aria-pressed="false">
                <span class="theme-moon" aria-hidden="true">夜间</span>
                <span class="theme-sun" aria-hidden="true">日间</span>
            </button></div>
    @endif

    <footer class="site-footer"><div class="wrap">具体学习情况请到企业后台咨询查询</div></footer>
    <script src="{{ asset('assets/portal.js') }}?v=20261108-8" defer></script>
    @if ($connected)
        @livewireScripts(['nonce' => request()->attributes->get('csp_nonce')])
    @endif
</body>
</html>
