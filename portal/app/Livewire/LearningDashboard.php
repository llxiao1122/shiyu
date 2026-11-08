<?php

namespace App\Livewire;

use App\Services\LearningGateway;
use Illuminate\Http\Request;
use Livewire\Component;
use Throwable;

final class LearningDashboard extends Component
{
    public string $panel = '';
    public string $notice = '';
    public string $examTraining = '';
    public string $examGroup = '';
    public bool $examFrameOpen = false;

    public function openPanel(string $panel): void
    {
        $this->panel = in_array($panel, ['waiting', 'exams'], true) ? $panel : '';
    }

    public function closePanel(): void
    {
        $this->panel = '';
    }

    public function openExam(string $training, string $group = ''): void
    {
        $training = trim($training);
        if ($this->panel !== 'exams' || $training === '' || mb_strlen($training) > 160 || preg_match('/[\x00-\x1F\x7F]/u', $training) || ($group !== '' && !preg_match('/^[A-Za-z0-9_-]{43}$/', $group))) {
            $this->notice = '课程名称无法确认，请刷新看板后重试。';
            return;
        }

        $this->examTraining = $training;
        $this->examGroup = $group;
        $this->examFrameOpen = true;
    }

    public function closeExam(): void
    {
        $this->examFrameOpen = false;
        $this->examTraining = '';
        $this->examGroup = '';
    }

    public function mount(LearningGateway $gateway, Request $request): void
    {
        $token = $request->session()->get('zg_session');
        if (is_string($token)) {
            try {
                $current = $gateway->session($request, $token);
                if ($current->successful() && in_array(data_get($current->json(), 'progress.scanProgress.stage'), ['discovering', 'checking'], true)) {
                    return;
                }
            } catch (Throwable) {
                // Refresh below provides the user-facing connection status.
            }
            $this->refresh($gateway, $request);
        }
    }

    public function poll(): void
    {
    }

    public function refresh(LearningGateway $gateway, Request $request, bool $silent = false): void
    {
        $this->notice = '';
        $token = $request->session()->get('zg_session');
        if (!is_string($token)) {
            $this->notice = '登录已失效，请重新登录。';
            return;
        }
        try {
            $response = $gateway->refresh($request, $token);
            if ($response->status() === 401) {
                $request->session()->forget('zg_session');
                $this->notice = '登录已失效，请重新登录。';
            } elseif (!$response->successful() && !$silent) {
                \Illuminate\Support\Facades\Log::warning('Dashboard refresh rejected', ['status' => $response->status(), 'error_code' => $response->json('errorCode')]);
                $this->notice = $response->status() === 429
                    ? '刷新过于频繁，请稍后再试。'
                    : '暂时无法开始读取，请稍后重试。';
            }
        } catch (Throwable) {
            if (!$silent) {
                $this->notice = '暂时无法连接学习服务，请稍后重试。';
            }
        }
    }

    public function learnExisting(LearningGateway $gateway, Request $request): void
    {
        $token = $request->session()->get('zg_session');
        if (!is_string($token)) {
            $this->notice = '登录已失效，请重新登录。';
            return;
        }
        try {
            $current = $gateway->session($request, $token);
            if (!$current->successful()) {
                $this->notice = '暂时无法确认课程状态，请刷新后重试。';
                return;
            }
            $progress = $current->json('progress');
            if (!is_array($progress) || data_get($progress, 'baseline.status') !== 'complete' ||
                in_array(data_get($progress, 'existingLearning.state'), ['running', 'completed'], true)) {
                $this->notice = '现有课件尚未准备好，或已在学习中。';
                return;
            }
            $response = $gateway->learnExisting($request, $token);
            $this->notice = $response->successful()
                ? '已安排现有课件，请稍后刷新看板。'
                : '安排结果暂未确认，请刷新看板查看。';
        } catch (Throwable) {
            $this->notice = '安排结果暂未确认，请刷新看板查看。';
        }
    }

    public function render(LearningGateway $gateway, Request $request)
    {
        $snapshot = null;
        $token = $request->session()->get('zg_session');
        $authExpired = !is_string($token);
        if (is_string($token)) {
            try {
                $response = $gateway->session($request, $token);
                if ($response->successful() && is_array($response->json())) {
                    $snapshot = $response->json();
                } elseif ($response->status() === 401) {
                    $request->session()->forget('zg_session');
                    $authExpired = true;
                }
            } catch (Throwable) {
                // A transient upstream outage leaves the local session intact.
            }
        }

        return view('livewire.learning-dashboard', ['snapshot' => $snapshot, 'authExpired' => $authExpired]);
    }
}
