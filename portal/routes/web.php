<?php

use App\Http\Controllers\PortalController;
use Illuminate\Support\Facades\Route;

Route::get('/', [PortalController::class, 'index'])->name('home');
Route::get('/zg/bridge', [PortalController::class, 'bridge'])->name('session.bridge');
Route::get('/exam/launch', [PortalController::class, 'launchExam'])->middleware('throttle:30,1,exam-launch:')->name('exam.launch');
Route::get('/exam/context', [PortalController::class, 'examContext'])->middleware('throttle:60,1,exam-context:')->name('exam.context');
Route::post('/exam-sso/redeem', [PortalController::class, 'redeemExamTicket'])->middleware('throttle:120,1,exam-redeem:')->name('exam.sso.redeem');
Route::post('/login', [PortalController::class, 'login'])->middleware('throttle:8,1,portal-login:')->name('login');
Route::post('/password', [PortalController::class, 'updatePassword'])->middleware('throttle:8,1,portal-password:')->name('password.update');
Route::post('/logout', [PortalController::class, 'logout'])->name('logout');
