# 学习托管前台

Laravel 13 + Blade + Livewire 4。页面和交互在服务端生成，托管工作仍由现有的 Node 服务执行。前台只通过 VPS 回环地址调用 `/zg/api/*`；对公网关闭该接口后，浏览器只访问 Laravel 页面和 Livewire 更新接口。

登录表单由 Laravel 控制器接收。服务端把官方登录请求送到本机 Node 服务，Node 返回的随机会话令牌仅保存在 Laravel 的加密文件会话中；不写入 Livewire 的公开属性、HTML 或浏览器存储。旧站 `/zg` 路径 Cookie 可经 `/zg/bridge` 一次性换入新前台会话。密码更改使用普通 POST 表单，避免进入 Livewire 快照。

部署时只开放 `public/` 给 Caddy，应用源码、`vendor/`、`.env` 和 `storage/` 均保留在 Web 根目录外。生产环境使用 `.env.production.example` 为模板，在 VPS 生成独立 `APP_KEY`，启用 `SESSION_ENCRYPT=true`、`APP_DEBUG=false` 和安全 Cookie。Node 服务及数据库不迁入 PHP 前台。

切换前须核对登录、旧会话转换、看板读取、现有课程按钮、修改密码、退出、Livewire 更新、CSP 以及公网对 `/zg/api/*` 的拒绝；原 Node 服务继续按原计划扫描，不需要重启或迁移数据。

`deploy/` 保存 Caddy 与独立 PHP-FPM 池的候选配置。PHP 工作进程使用 `zg-portal` 系统用户，不能读取 Node 的加密数据库；Caddy 只开放 Laravel 的 `public/`。Laravel 页面使用每次响应独立的 CSP nonce，Livewire 使用无 `unsafe-eval` 模式。
