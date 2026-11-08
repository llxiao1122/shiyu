<?php

namespace App\Http\Controllers;

use App\Services\LearningGateway;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Crypt;
use Illuminate\View\View;
use Throwable;

final class PortalController extends Controller
{
    public function index(Request $request): View|RedirectResponse
    {
        $connected = is_string($request->session()->get('zg_session'));
        if (!$connected && $request->query('bridge') !== '1') {
            return redirect()->route('session.bridge');
        }

        return view('portal', ['connected' => $connected]);
    }

    public function bridge(Request $request, LearningGateway $gateway): RedirectResponse
    {
        $token = $request->cookie('zg_session');
        if (is_string($token) && preg_match('/^[A-Za-z0-9_-]{40,60}$/', $token)) {
            try {
                if ($gateway->session($request, $token)->successful()) {
                    $request->session()->regenerate();
                    $request->session()->put('zg_session', $token);
                    return redirect()->route('home');
                }
            } catch (Throwable) {
                // Show the login page if the old session cannot be verified.
            }
        }

        return redirect()->route('home', ['bridge' => '1']);
    }

    public function launchExam(Request $request, LearningGateway $gateway): Response
    {
        $token = $request->session()->get('zg_session');
        $training = $request->query('training');
        $group = $request->query('group', '');
        if (!is_string($token) || !preg_match('/^[A-Za-z0-9_-]{40,60}$/', $token)) {
            return response()->view('exam-sso-error', ['message' => '课程登录已失效，请返回课程看板重新登录。'], 401);
        }
        if (!is_string($training) || trim($training) === '' || mb_strlen($training) > 160 || preg_match('/[\x00-\x1F\x7F]/u', $training)) {
            return response()->view('exam-sso-error', ['message' => '课程名称无法确认，请返回课程看板重新进入。'], 400);
        }
        if (!is_string($group) || ($group !== '' && !preg_match('/^[A-Za-z0-9_-]{43}$/', $group))) {
            return response()->view('exam-sso-error', ['message' => '课程身份无法确认，请返回课程看板重新进入。'], 400);
        }

        try {
            $identity = $gateway->examIdentity($request, $token);
            if ($identity->status() === 401) {
                return response()->view('exam-sso-error', ['message' => '课程登录已失效，请返回课程看板重新登录。'], 401);
            }
            $userId = $identity->successful() ? $identity->json('userId') : null;
            $platformToken = $identity->successful() ? $identity->json('platformToken') : null;
            if (!is_string($userId) || !preg_match('/^[A-Za-z0-9._-]{1,128}$/', $userId)) {
                return response()->view('exam-sso-error', ['message' => '暂时无法确认课程账号，请刷新看板后重试。'], 503);
            }

            $ticket = bin2hex(random_bytes(32));
            if (!is_string($platformToken) || strlen($platformToken) < 12 || strlen($platformToken) > 4096 || preg_match('/[\x00-\x1F\x7F]/', $platformToken)) {
                return response()->view('exam-sso-error', ['message' => '暂时无法连接考试平台，请稍后重试。'], 503);
            }
            $this->storeExamSsoTicket(hash('sha256', $ticket), $platformToken, $userId);

            return response()->view('exam-sso-launch', ['ticket' => $ticket, 'training' => trim($training), 'group' => $group]);
        } catch (Throwable) {
            return response()->view('exam-sso-error', ['message' => '暂时无法连接考试服务，请返回课程看板重试。'], 503);
        }
    }

    public function redeemExamTicket(Request $request): JsonResponse
    {
        $timestamp = $request->header('X-Exam-Sso-Timestamp', '');
        $signature = $request->header('X-Exam-Sso-Signature', '');
        $ticket = $request->json('ticket');
        $secret = @file_get_contents(storage_path('app/exam-sso.key'));
        $secret = is_string($secret) ? trim($secret) : '';

        if (!preg_match('/^[a-f0-9]{64}$/', $secret)) {
            return response()->json(['error' => 'unavailable'], 503)->header('Cache-Control', 'no-store');
        }
        if (!is_string($timestamp) || !ctype_digit($timestamp) || abs(time() - (int) $timestamp) > 60 ||
            !is_string($ticket) || !preg_match('/^[a-f0-9]{64}$/', $ticket) ||
            !is_string($signature) || !preg_match('/^[a-f0-9]{64}$/', $signature)) {
            return response()->json(['error' => 'invalid'], 401)->header('Cache-Control', 'no-store');
        }

        $expected = hash_hmac('sha256', "POST\n/exam-sso/redeem\n{$timestamp}\n{$ticket}", $secret);
        if (!hash_equals($expected, $signature)) {
            return response()->json(['error' => 'invalid'], 401)->header('Cache-Control', 'no-store');
        }

        $bundle = $this->claimExamSsoTicket(hash('sha256', $ticket));
        if (!is_array($bundle)) {
            return response()->json(['error' => 'expired'], 410)->header('Cache-Control', 'no-store');
        }

        try {
            $token = Crypt::decryptString($bundle['token'] ?? '');
            $userId = Crypt::decryptString($bundle['userId'] ?? '');
        } catch (Throwable) {
            return response()->json(['error' => 'expired'], 410)->header('Cache-Control', 'no-store');
        }
        if (!is_string($token) || strlen($token) < 12 || strlen($token) > 4096 || preg_match('/[\x00-\x1F\x7F]/', $token) ||
            !is_string($userId) || !preg_match('/^[A-Za-z0-9._-]{1,128}$/', $userId)) {
            return response()->json(['error' => 'expired'], 410)->header('Cache-Control', 'no-store');
        }

        return response()->json(['token' => $token, 'userId' => $userId])->header('Cache-Control', 'no-store');
    }

    public function examContext(Request $request, LearningGateway $gateway): JsonResponse
    {
        $token = $request->session()->get('zg_session');
        $group = $request->query('group');
        if (!is_string($token) || !preg_match('/^[A-Za-z0-9_-]{40,60}$/', $token)) {
            return response()->json(['error' => '登录已失效'], 401)->header('Cache-Control', 'no-store');
        }
        if (!is_string($group) || !preg_match('/^[A-Za-z0-9_-]{43}$/', $group)) {
            return response()->json(['error' => '课程身份无法确认'], 400)->header('Cache-Control', 'no-store');
        }

        try {
            $response = $gateway->examContext($request, $token, $group);
            if ($response->status() === 401) {
                return response()->json(['error' => '登录已失效'], 401)->header('Cache-Control', 'no-store');
            }
            $userId = $response->json('userId');
            $records = $response->json('records');
            $secret = @file_get_contents(storage_path('app/exam-sso.key'));
            $secret = is_string($secret) ? trim($secret) : '';
            if (!$response->successful() || $response->json('group') !== $group ||
                !is_string($userId) || !preg_match('/^[A-Za-z0-9._-]{1,128}$/', $userId) ||
                !is_array($records) || count($records) > 20 || !preg_match('/^[a-f0-9]{64}$/', $secret)) {
                return response()->json(['error' => '暂时无法核对课程考试'], 503)->header('Cache-Control', 'no-store');
            }
            foreach ($records as $record) {
                if (!is_array($record) || !is_string($record['activityId'] ?? null) || !preg_match('/^[A-Za-z0-9._-]{1,128}$/', $record['activityId']) ||
                    !is_string($record['resourceId'] ?? null) || !preg_match('/^[A-Za-z0-9._-]{1,128}$/', $record['resourceId']) ||
                    !is_string($record['title'] ?? null) || mb_strlen($record['title']) > 160 || preg_match('/[\x00-\x1F\x7F]/u', $record['title'])) {
                    return response()->json(['error' => '课程考试信息无法确认'], 503)->header('Cache-Control', 'no-store');
                }
            }
            $payload = json_encode(['sub' => hash('sha256', $userId), 'group' => $group, 'exp' => time() + 60, 'records' => $records], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
            $encoded = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');
            $signature = hash_hmac('sha256', "exam-context\n".$encoded, $secret);
            return response()->json(['ticket' => $encoded.'.'.$signature])->header('Cache-Control', 'no-store');
        } catch (Throwable) {
            return response()->json(['error' => '暂时无法核对课程考试'], 503)->header('Cache-Control', 'no-store');
        }
    }

    private function storeExamSsoTicket(string $digest, string $token, string $userId): void
    {
        $directory = storage_path('app/exam-sso-tickets');
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new \RuntimeException('Unable to create SSO ticket storage.');
        }
        @chmod($directory, 0700);

        $path = $directory.'/ticket-'.$digest.'.json';
        $handle = @fopen($path, 'x+b');
        if ($handle === false) {
            throw new \RuntimeException('Unable to create SSO ticket.');
        }

        try {
            $contents = json_encode([
                'expiresAt' => time() + 90,
                'token' => Crypt::encryptString($token),
                'userId' => Crypt::encryptString($userId),
            ], JSON_THROW_ON_ERROR);
            if (!flock($handle, LOCK_EX) || fwrite($handle, $contents) !== strlen($contents) || !fflush($handle)) {
                throw new \RuntimeException('Unable to write SSO ticket.');
            }
            @chmod($path, 0600);
        } catch (Throwable $error) {
            fclose($handle);
            @unlink($path);
            throw $error;
        }

        fclose($handle);
    }

    private function claimExamSsoTicket(string $digest): ?array
    {
        $directory = storage_path('app/exam-sso-tickets');
        $source = $directory.'/ticket-'.$digest.'.json';
        $claimed = $directory.'/.claimed-'.bin2hex(random_bytes(16)).'.json';

        // Moving the ticket is atomic on this filesystem, so parallel redeems have one winner.
        if (!@rename($source, $claimed)) {
            return null;
        }

        try {
            $contents = file_get_contents($claimed);
            $bundle = is_string($contents) ? json_decode($contents, true) : null;
            if (!is_array($bundle) || !isset($bundle['expiresAt']) ||
                !is_int($bundle['expiresAt']) || $bundle['expiresAt'] < time()) {
                return null;
            }

            return $bundle;
        } catch (Throwable) {
            return null;
        } finally {
            @unlink($claimed);
        }
    }

    public function login(Request $request, LearningGateway $gateway): RedirectResponse
    {
        $input = $request->validate([
            'org_code' => ['required', 'string', 'max:128'],
            'username' => ['required', 'string', 'max:256'],
            'password' => ['required', 'string', 'max:512'],
            'consent' => ['accepted'],
        ]);

        try {
            $response = $gateway->login($request, [
                'orgCode' => strtoupper(trim($input['org_code'])),
                'username' => trim($input['username']),
                'password' => $input['password'],
                'consent' => true,
                'videoConsent' => true,
            ]);
            $token = $response->successful() ? $gateway->tokenFromLogin($response) : null;
            if ($token !== null) {
                $request->session()->regenerate();
                $request->session()->put('zg_session', $token);
                return redirect()->route('home');
            }
            $message = match ($response->status()) {
                401 => '账号或密码不正确，请核对后重试。',
                429 => '操作较频繁，请稍后再试。',
                403 => '安全校验未通过，请刷新页面后重试。',
                default => '暂时无法登录，请稍后再试。',
            };
        } catch (Throwable) {
            $message = '暂时无法连接学习服务，请稍后再试。';
        }

        return back()->withErrors(['login' => $message])->withInput($request->only('org_code', 'username'));
    }

    public function updatePassword(Request $request, LearningGateway $gateway): RedirectResponse
    {
        $input = $request->validate(['password' => ['required', 'string', 'max:512']]);
        $token = $request->session()->get('zg_session');
        if (!is_string($token)) {
            return redirect()->route('home');
        }

        try {
            $response = $gateway->updatePassword($request, $token, $input['password']);
            if ($response->successful()) {
                return back()->with('status', '托管密码已更新。');
            }
            $message = match ($response->status()) {
                401 => '登录已失效，请重新登录。',
                409 => '账号不匹配或当前任务正忙，请稍后核对。',
                429 => '操作较频繁，请稍后再试。',
                default => '密码暂未更新，请稍后重试。',
            };
        } catch (Throwable) {
            $message = '暂时无法连接学习服务，请稍后再试。';
        }

        return back()->withErrors(['password_update' => $message]);
    }

    public function logout(Request $request, LearningGateway $gateway): RedirectResponse
    {
        $token = $request->session()->get('zg_session');
        if (is_string($token)) {
            try {
                $gateway->logout($request, $token);
            } catch (Throwable) {
                // The local session is invalidated even when the worker is unavailable.
            }
        }
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect()->route('home');
    }
}
