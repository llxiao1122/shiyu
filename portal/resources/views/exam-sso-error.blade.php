<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>考试暂不可用</title>
    <style>
        *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#fff;color:#292929;font:14px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif}.message{width:min(560px,calc(100% - 40px));padding:28px}.message p{margin:0 0 18px;color:#666}button{border:0;padding:0;background:transparent;color:#222;font:inherit;cursor:pointer}
    </style>
</head>
<body>
    <main class="message">
        <p role="status">{{ $message }}</p>
        <button type="button" data-exam-frame-close>关闭</button>
    </main>
    <script src="{{ asset('assets/exam-sso-launch.js') }}?v=1" defer></script>
</body>
</html>
