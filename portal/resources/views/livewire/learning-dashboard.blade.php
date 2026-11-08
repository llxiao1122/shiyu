@php
    $scanStage = data_get($snapshot, 'progress.scanProgress.stage', '');
    $scanActive = in_array($scanStage, ['discovering', 'checking'], true);
    $scanTotalValue = data_get($snapshot, 'progress.scanProgress.total');
    $scanTotal = is_numeric($scanTotalValue) ? (int) $scanTotalValue : null;
    $scanProcessedValue = data_get($snapshot, 'progress.scanProgress.processed');
    $scanProcessed = is_numeric($scanProcessedValue) ? (int) $scanProcessedValue : 0;
@endphp
<div class="dashboard" data-scan-active="{{ $scanActive ? 'true' : 'false' }}" @if ($scanActive) wire:poll.3s="poll" @else wire:poll.30s="poll" @endif>
    <section class="dashboard-head" aria-label="看板操作" @if ($scanActive) inert @endif>
        <div class="head-actions">
            <button class="dashboard-icon-button" type="button" data-theme-toggle title="切换深色模式" aria-label="切换深色模式" aria-pressed="false">
                <span class="theme-moon" aria-hidden="true">夜间</span>
                <span class="theme-sun" aria-hidden="true">日间</span>
            </button>
            <button class="dashboard-icon-button" type="button" wire:click="refresh" wire:loading.attr="disabled" wire:target="refresh" title="刷新看板" aria-label="刷新看板">
                <span aria-hidden="true">刷新</span>
            </button>
            <button class="dashboard-icon-button" type="button" data-exit-open title="退出登录" aria-label="退出登录">
                <span aria-hidden="true">退出</span>
            </button>
            <button class="dashboard-icon-button" type="button" data-support-open title="打赏" aria-label="打赏"><span aria-hidden="true">打赏</span></button>
            <dialog class="support-dialog" aria-labelledby="support-title" wire:ignore>
                <div class="support-head"><h2 id="support-title">支持识阈</h2><button class="close-button" type="button" data-support-close aria-label="关闭">×</button></div>
                <p class="support-intro">感谢你的支持</p>
                <div class="support-methods">
                    <section class="support-method"><h3>微信</h3><div class="support-placeholder">收款码尚未配置</div></section>
                    <section class="support-method"><h3>支付宝</h3><div class="support-placeholder">收款码尚未配置</div></section>
                </div>
            </dialog>
            <dialog class="exit-dialog" aria-labelledby="exit-title" wire:ignore>
                <div class="exit-content">
                    <h2 id="exit-title">退出登录</h2>
                    <form method="post" action="{{ route('logout') }}">@csrf<button class="quiet-button" type="submit">登出账号</button></form>
                    <button class="quiet-button" type="button" disabled>停止托管（暂不可用）</button>
                    <p class="muted">登出后，学习托管仍会继续。</p>
                    <button class="quiet-button" type="button" data-exit-close>取消</button>
                </div>
            </dialog>
        </div>
    </section>
    <div class="dashboard-content" @if ($scanActive) inert @endif>
    @if (!is_array($snapshot))
        <section class="notice info" role="status">
            @if ($authExpired)
                登录已失效。<a class="text-button" href="{{ route('home') }}">重新登录</a>
            @else
                暂时无法读取学习情况。<button class="text-button" type="button" wire:click="refresh">重新读取</button>
            @endif
        </section>
    @else
        @php
            $progress = is_array($snapshot['progress'] ?? null) ? $snapshot['progress'] : [];
            $completed = data_get($progress, 'courseSummaries.completed.totalCourses');
            $waiting = data_get($progress, 'dashboardSummary.waiting');
            $exams = data_get($progress, 'courseSummaries.exams.totalCourses');
            $scan = data_get($progress, 'scanProgress');
            $baseline = data_get($progress, 'baseline');
            $existing = data_get($progress, 'existingLearning');
            $existingState = data_get($existing, 'state');
            $canLearnExisting = data_get($baseline, 'status') === 'complete' && !in_array($existingState, ['running', 'completed'], true) && data_get($existing, 'hideBaselineList') !== true;
            $items = data_get($progress, 'courseSummaries.'.$panel.'.items', []);
            $courseCount = data_get($progress, 'courseSummaries.'.$panel.'.totalCourses', 0);
            $coursewareCount = data_get($progress, 'courseSummaries.'.$panel.'.totalCourseware', 0);
        @endphp

        @php
            $examPrefetchItems = data_get($progress, 'courseSummaries.exams.items', []);
            $examPrefetchCourses = array_values(array_filter(array_map(
                fn ($item) => is_array($item) && is_string($item['trainingTitle'] ?? null) && is_string($item['trainingGroupId'] ?? null)
                    ? ['title' => $item['trainingTitle'], 'group' => $item['trainingGroupId']] : null,
                is_array($examPrefetchItems) ? $examPrefetchItems : []
            )));
        @endphp
        <div hidden data-exam-prefetch-courses="{{ json_encode($examPrefetchCourses, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) }}"></div>

        @if (data_get($progress, 'lastScan.errorCode') === 'LOGIN_FAILED')
            <p class="notice error" role="alert">自动托管暂时无法登录，请核对官方密码并更新托管密码。</p>
        @endif
        @if (data_get($scan, 'errorCode') === 'PLATFORM_AUTH_EXPIRED')
            <p class="notice error" role="alert">官方平台登录已失效，请退出后重新登录，再读取课程。</p>
        @endif
        @if ($notice !== '')<p class="notice info" role="status">{{ $notice }}</p>@endif

        <section class="metrics-grid" aria-label="学习情况">
            <div class="metric-card"><span>已完成课程</span><strong>{{ is_numeric($completed) ? (int) $completed : '待核实' }}</strong></div>
            <div class="metric-card"><span>待学习课件</span><strong>{{ is_numeric($waiting) ? (int) $waiting : '待核实' }}</strong></div>
            <button class="metric-card metric-button" type="button" wire:click="openPanel('exams')"><span>含考试内容</span><strong>{{ is_numeric($exams) ? (int) $exams : '待核实' }}</strong></button>
        </section>

        @if ($canLearnExisting)
            <section class="existing-action">
                <button class="quiet-button" type="button" wire:click="learnExisting" wire:confirm="将开始学习已有课程中的未完成课件。确认继续？" wire:loading.attr="disabled">学习已有课程</button>
                <span class="muted">仅处理未完成课件，考试需自行完成。</span>
            </section>
        @endif

        @if ($panel !== '' && !$examFrameOpen)
            <div class="modal-backdrop" wire:click.self="closePanel">
                <section class="modal {{ $panel === 'exams' ? 'exam-list-modal' : '' }}" role="dialog" aria-modal="true" aria-label="{{ $panel === 'exams' ? '含考试内容' : '待学习课件' }}">
                    <div class="modal-head"><button class="close-button" type="button" wire:click="closePanel" aria-label="关闭">×</button></div>
                    @if (!empty($items))<p class="muted">共 {{ is_numeric($courseCount) ? (int) $courseCount : 0 }} 项课程@if ($panel === 'waiting') · {{ is_numeric($coursewareCount) ? (int) $coursewareCount : 0 }} 份课件@endif</p>@endif
                    <div class="course-list">
                        @forelse (is_array($items) ? $items : [] as $item)
                            @php $trainingTitle = is_string($item['trainingTitle'] ?? null) ? $item['trainingTitle'] : ''; @endphp
                            @php $trainingGroup = is_string($item['trainingGroupId'] ?? null) ? $item['trainingGroupId'] : ''; @endphp
                            @if ($panel === 'exams' && $trainingTitle !== '')
                                <button class="course-row exam-course-row" type="button" wire:key="{{ $panel }}-{{ $loop->index }}" wire:click="openExam(@js($trainingTitle), @js($trainingGroup))" wire:loading.attr="disabled" data-exam-training="{{ $trainingTitle }}" data-exam-group="{{ $trainingGroup }}" data-exam-launch="{{ route('exam.launch', ['training' => $trainingTitle, 'group' => $trainingGroup]) }}" aria-label="打开{{ $trainingTitle }}考试">
                                    <strong>{{ $trainingTitle }}</strong>
                                    <span>需考试</span>
                                </button>
                            @else
                                <div class="course-row" wire:key="{{ $panel }}-{{ $loop->index }}">
                                    <strong>{{ $trainingTitle !== '' ? $trainingTitle : '学习课程' }}</strong>
                                    <span>{{ $panel === 'exams' ? '考试名称待确认' : ((int) ($item['coursewareCount'] ?? 0)).' 份课件' }}</span>
                                </div>
                            @endif
                        @empty
                            <p class="empty-state">{{ $panel === 'exams' ? '你已经都考完了' : '暂无内容。' }}</p>
                        @endforelse
                    </div>
                </section>
            </div>
        @endif

        @if ($examFrameOpen)
            <div class="modal-backdrop exam-frame-backdrop" wire:click.self="closeExam">
                <section class="modal exam-frame-modal" role="dialog" aria-modal="true" aria-label="考试详情">
                    <button class="close-button exam-frame-close" type="button" wire:click="closeExam" data-exam-frame-close aria-label="关闭考试">×</button>
                    <div class="exam-frame-viewport" wire:ignore>
                        <iframe data-exam-launch="{{ route('exam.launch', ['training' => $examTraining, 'group' => $examGroup]) }}" data-exam-training="{{ $examTraining }}" data-exam-group="{{ $examGroup }}" title="{{ $examTraining }}考试详情" loading="eager" referrerpolicy="no-referrer"></iframe>
                    </div>
                </section>
            </div>
        @endif
    @endif
    </div>
    @if ($scanActive)
        <div class="scan-reading-overlay" role="dialog" aria-modal="true" aria-labelledby="scan-reading-title">
            <section class="scan-reading-panel">
                <h2 id="scan-reading-title">读取中</h2>
                @if ($scanStage === 'discovering' || $scanTotal === null || $scanTotal === 0)
                    <progress aria-label="读取进度" class="scan-reading-progress" max="100"></progress>
                @else
                    <progress aria-label="读取进度" class="scan-reading-progress" max="{{ $scanTotal }}" value="{{ min(max($scanProcessed, 0), $scanTotal) }}"></progress>
                @endif
            </section>
        </div>
    @endif
</div>
