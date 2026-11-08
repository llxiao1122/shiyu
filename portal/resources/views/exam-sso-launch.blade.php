<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>正在进入考试</title>
    <style>
        *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#fff;color:#292929;font:14px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif}.launch{padding:28px;text-align:center}.launch p{margin:0 0 14px;color:#777}button{border:0;background:transparent;color:#222;font:inherit;cursor:pointer}
    </style>
</head>
<body>
    <main class="launch">
        <p>正在打开「{{ $training }}」考试…</p>
        <form id="exam-sso" method="post" action="/zgxy/sso" autocomplete="off">
            <input type="hidden" name="ticket" value="{{ $ticket }}">
            <input type="hidden" name="training" value="{{ $training }}">
            @if ($group !== '')<input type="hidden" name="group" value="{{ $group }}">@endif
            <noscript><button type="submit">继续进入考试</button></noscript>
        </form>
    </main>
    <script src="{{ asset('assets/exam-sso-launch.js') }}?v=1" defer></script>
</body>
</html>
