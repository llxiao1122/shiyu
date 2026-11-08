<?php

namespace App\Services;

use Illuminate\Http\Client\Response;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

final class LearningGateway
{
    private function client(Request $request, ?string $token = null)
    {
        $ip = (string) $request->server('REMOTE_ADDR', '');
        $headers = [
            'Origin' => (string) config('services.zg_portal.origin'),
            'X-Forwarded-For' => filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '127.0.0.1',
        ];
        if ($token !== null) {
            $headers['Cookie'] = 'zg_session='.$token;
        }

        return Http::acceptJson()->asJson()->withHeaders($headers)->timeout(75);
    }

    private function url(string $path): string
    {
        return rtrim((string) config('services.zg_portal.internal_url'), '/').'/zg/api/'.$path;
    }

    public function login(Request $request, array $input): Response
    {
        return $this->client($request)->post($this->url('login'), $input);
    }

    public function session(Request $request, string $token): Response
    {
        return $this->client($request, $token)->get($this->url('session'));
    }

    public function refresh(Request $request, string $token): Response
    {
        return $this->client($request, $token)->withBody('{}', 'application/json')->post($this->url('refresh'));
    }

    public function examIdentity(Request $request, string $token): Response
    {
        return $this->client($request, $token)->get($this->url('exam-identity'));
    }

    public function examContext(Request $request, string $token, string $group): Response
    {
        return $this->client($request, $token)->get($this->url('exam-context'), ['group' => $group]);
    }

    public function learnExisting(Request $request, string $token): Response
    {
        return $this->client($request, $token)->post($this->url('learn-existing'), []);
    }

    public function updatePassword(Request $request, string $token, string $password): Response
    {
        return $this->client($request, $token)->patch($this->url('credentials'), ['password' => $password]);
    }

    public function logout(Request $request, string $token): void
    {
        $this->client($request, $token)->post($this->url('logout'), []);
    }

    public function tokenFromLogin(Response $response): ?string
    {
        $cookie = $response->header('Set-Cookie');
        if (!is_string($cookie) || !preg_match('/^zg_session=([A-Za-z0-9_-]{40,60})(?:;|$)/', $cookie, $match)) {
            return null;
        }

        return $match[1];
    }
}
