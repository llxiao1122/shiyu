'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const COURSEWARE_PATH = path.join(__dirname, 'learning-courseware.js');
const COURSEWARE = require(COURSEWARE_PATH);
const API_ORIGIN = 'https://learning01.zzmetro.cn:30426';
const API_ROUTE = '/zhenggui/api/learning-jobs';
const ORIGIN = 'https://work.ciphera.cn';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_SUM_TIME_SECONDS = 24 * 60 * 60;
const MAX_ACTIVE_JOBS = 20;
const SECRET_RETENTION_MS = 24 * 60 * 60 * 1000;
const FILE_TYPES = new Set(['PDF', 'OFFICE', 'H5', 'SCORM']);
const UNFINISHED = new Set(['NOTATTEMPT', 'PROGRESS']);
const COMPLETED = new Set(['COMPLETE', 'COMPLETED']);
const ACTIVE_STATUSES = ['pending', 'running', 'unknown'];
const RETRYABLE_PREPARE_FAILURES = new Set(['RESOURCE_STATUS_UNVERIFIED', 'CATALOG_READ_FAILED']);
const ALLOWED_UPSTREAM_ROUTES = new Set([
  COURSEWARE.ROUTES.trainingDetail,
  COURSEWARE.ROUTES.trainingContentList,
  COURSEWARE.ROUTES.trainingSectionDetail,
  COURSEWARE.ROUTES.courseDetail,
  COURSEWARE.ROUTES.onlineContentList,
  COURSEWARE.ROUTES.sectionDetail,
  COURSEWARE.ROUTES.fileOpen,
  COURSEWARE.ROUTES.fileSubmit,
  COURSEWARE.ROUTES.videoOpen,
  COURSEWARE.ROUTES.videoSubmit
]);

class SafeError extends Error {
  constructor(code, status = 500) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function normalizeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  const result = String(value);
  if (!result || result.length > 128 || result.trim() !== result || /[\u0000-\u001f\u007f]/.test(result)) return '';
  return result;
}

function safeStatus(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function openStore(dataDir, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const keyPath = path.join(dataDir, 'key');
  let key;
  try {
    const fd = fs.openSync(keyPath, 'wx', 0o600);
    key = crypto.randomBytes(32);
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    const dirFd = fs.openSync(dataDir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    key = fs.readFileSync(keyPath);
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid key material');
  fs.chmodSync(keyPath, 0o600);

  const dbPath = path.join(dataDir, 'jobs.sqlite');
  const db = new DatabaseSync(dbPath);
  try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    activity_enrollment_id TEXT NOT NULL,
    activity_id_cipher TEXT NOT NULL DEFAULT '',
    activity_enrollment_id_cipher TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    current_index INTEGER NOT NULL DEFAULT 0,
    plan_json TEXT NOT NULL DEFAULT '[]',
    current_resource_json TEXT,
    auth_cipher TEXT,
    learning_cipher TEXT,
    open_received_at INTEGER,
    deadline_at INTEGER,
    skipped_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT,
    verified_complete INTEGER NOT NULL DEFAULT 0,
    resource_filter_json TEXT NOT NULL DEFAULT '[]',
    video_enabled INTEGER NOT NULL DEFAULT 0,
    request_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_scope_created ON jobs(activity_id, activity_enrollment_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS jobs_status_updated ON jobs(status, updated_at);`);

  const existingColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(column => column.name));
  if (!existingColumns.has('resource_filter_json')) db.exec("ALTER TABLE jobs ADD COLUMN resource_filter_json TEXT NOT NULL DEFAULT '[]'");
  if (!existingColumns.has('video_enabled')) db.exec('ALTER TABLE jobs ADD COLUMN video_enabled INTEGER NOT NULL DEFAULT 0');
  if (!existingColumns.has('request_id')) db.exec('ALTER TABLE jobs ADD COLUMN request_id TEXT');
  if (!existingColumns.has('activity_id_cipher')) db.exec("ALTER TABLE jobs ADD COLUMN activity_id_cipher TEXT NOT NULL DEFAULT ''");
  if (!existingColumns.has('activity_enrollment_id_cipher')) db.exec("ALTER TABLE jobs ADD COLUMN activity_enrollment_id_cipher TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS jobs_request_id_unique ON jobs(request_id) WHERE request_id IS NOT NULL');

  let fatal = false;
  function encrypt(value) {
    if (typeof value !== 'string' || !value) throw new Error('missing secret');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }
  function decrypt(value) {
    if (typeof value !== 'string' || !value) throw new Error('missing secret');
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error('invalid secret');
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const data = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
  function encryptStored(value) { return 'enc:' + encrypt(value); }
  function decryptStored(value) {
    if (typeof value !== 'string') throw new Error('missing stored value');
    if (value.startsWith('enc:')) return decrypt(value.slice(4));
    if (value === '[]' || value === '{}' || value === '') return value;
    throw new Error('unprotected stored value');
  }
  function hashId(value) { return crypto.createHmac('sha256', key).update(value, 'utf8').digest('base64url'); }
  const selectById = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const selectActiveScope = db.prepare("SELECT * FROM jobs WHERE activity_id = ? AND activity_enrollment_id = ? AND status IN ('pending','running','unknown') ORDER BY created_at DESC LIMIT 1");
  const selectLatestScope = db.prepare('SELECT * FROM jobs WHERE activity_id = ? AND activity_enrollment_id = ? ORDER BY created_at DESC LIMIT 1');
  const selectActiveCount = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','running','unknown')");
  const selectAll = db.prepare('SELECT * FROM jobs ORDER BY created_at');
  const selectByRequestId = db.prepare('SELECT * FROM jobs WHERE request_id = ?');
  const update = db.prepare(`UPDATE jobs SET activity_id=?,activity_enrollment_id=?,activity_id_cipher=?,activity_enrollment_id_cipher=?,status=?,phase=?,total=?,completed=?,current_index=?,plan_json=?,current_resource_json=?,auth_cipher=?,learning_cipher=?,open_received_at=?,deadline_at=?,skipped_json=?,error_code=?,verified_complete=?,resource_filter_json=?,video_enabled=?,request_id=?,created_at=?,updated_at=? WHERE id=?`);
  const insert = db.prepare(`INSERT INTO jobs(id,activity_id,activity_enrollment_id,activity_id_cipher,activity_enrollment_id_cipher,status,phase,total,completed,current_index,plan_json,current_resource_json,auth_cipher,learning_cipher,open_received_at,deadline_at,skipped_json,error_code,verified_complete,resource_filter_json,video_enabled,request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  function decodeRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      activity_id: row.activity_id_cipher ? decryptStored(row.activity_id_cipher) : '',
      activity_enrollment_id: row.activity_enrollment_id_cipher ? decryptStored(row.activity_enrollment_id_cipher) : '',
      status: row.status,
      phase: row.phase,
      total: Number(row.total),
      completed: Number(row.completed),
      current_index: Number(row.current_index),
      plan_json: decryptStored(row.plan_json),
      current_resource_json: row.current_resource_json ? decryptStored(row.current_resource_json) : null,
      auth_cipher: row.auth_cipher,
      learning_cipher: row.learning_cipher,
      open_received_at: row.open_received_at === null ? null : Number(row.open_received_at),
      deadline_at: row.deadline_at === null ? null : Number(row.deadline_at),
      skipped_json: row.skipped_json,
      error_code: row.error_code,
      verified_complete: Number(row.verified_complete) === 1,
      resource_filter_json: decryptStored(row.resource_filter_json),
      video_enabled: Number(row.video_enabled) === 1,
      request_id: row.request_id,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at)
    };
  }
  function assertWritable() {
    if (fatal) throw new SafeError('STORAGE_UNAVAILABLE', 503);
  }
  function tx(work) {
    assertWritable();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      if (error instanceof SafeError) throw error;
      fatal = true;
      throw new SafeError('STORAGE_UNAVAILABLE', 503);
    }
  }
  function write(patch, id, clock) {
    return tx(() => {
      const current = decodeRow(selectById.get(id));
      if (!current) throw new Error('job missing');
      const next = { ...current, ...patch, updated_at: clock() };
      update.run(
        hashId(next.activity_id), hashId(next.activity_enrollment_id), encryptStored(next.activity_id), encryptStored(next.activity_enrollment_id),
        next.status, next.phase, next.total, next.completed,
        next.current_index, encryptStored(next.plan_json), next.current_resource_json ? encryptStored(next.current_resource_json) : null, next.auth_cipher, next.learning_cipher,
        next.open_received_at, next.deadline_at, next.skipped_json, next.error_code,
        next.verified_complete ? 1 : 0, encryptStored(next.resource_filter_json), next.video_enabled ? 1 : 0,
        next.request_id, next.created_at, next.updated_at, id
      );
      return next;
    });
  }
  function createOrGet(activityId, enrollmentId, token, resourceKeys, requestId, videoEnabled, clock) {
    if (!Array.isArray(resourceKeys) || resourceKeys.length === 0 || resourceKeys.length > 2000 ||
        resourceKeys.some(key => typeof key !== 'string' || !key || key.length > 400 || /[\u0000-\u001f\u007f]/.test(key)) ||
        typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) throw new SafeError('RESOURCE_FILTER_REQUIRED', 400);
    const filterJson = JSON.stringify([...new Set(resourceKeys)].sort());
    return tx(() => {
      const prior = decodeRow(selectByRequestId.get(requestId));
      if (prior) {
        if (prior.activity_id !== activityId || prior.activity_enrollment_id !== enrollmentId ||
            prior.resource_filter_json !== filterJson || prior.video_enabled !== (videoEnabled === true)) {
          throw new SafeError('REQUEST_ID_CONFLICT', 409);
        }
        return { job: prior, created: false };
      }
      const active = decodeRow(selectActiveScope.get(hashId(activityId), hashId(enrollmentId)));
      if (active) throw new SafeError('JOB_ACTIVE', 409);
      const activeCount = Number(selectActiveCount.get().count);
      if (activeCount >= MAX_ACTIVE_JOBS) throw new SafeError('QUEUE_FULL', 429);
      const now = clock();
      const job = {
        id: crypto.randomUUID(), activity_id: activityId, activity_enrollment_id: enrollmentId,
        status: 'pending', phase: 'queued', total: 0, completed: 0, current_index: 0,
        plan_json: '[]', current_resource_json: null, auth_cipher: encrypt(token), learning_cipher: null,
        open_received_at: null, deadline_at: null, skipped_json: JSON.stringify({}),
        error_code: null, verified_complete: false, resource_filter_json: filterJson,
        video_enabled: videoEnabled === true,
        request_id: requestId, created_at: now, updated_at: now
      };
      insert.run(
        job.id, hashId(job.activity_id), hashId(job.activity_enrollment_id), encryptStored(job.activity_id), encryptStored(job.activity_enrollment_id),
        job.status, job.phase, job.total, job.completed,
        job.current_index, encryptStored(job.plan_json), job.current_resource_json, job.auth_cipher, job.learning_cipher,
        job.open_received_at, job.deadline_at, job.skipped_json, job.error_code, 0,
        encryptStored(job.resource_filter_json), job.video_enabled ? 1 : 0, job.request_id, job.created_at, job.updated_at
      );
      return { job, created: true };
    });
  }
  return {
    db, get fatal() { return fatal; },
    getById(id) { return decodeRow(selectById.get(id)); },
    getByRequestId(id) { return decodeRow(selectByRequestId.get(id)); },
    getActiveByScope(activityId, enrollmentId) { return decodeRow(selectActiveScope.get(hashId(activityId), hashId(enrollmentId))); },
    getLatestByScope(activityId, enrollmentId) { return decodeRow(selectLatestScope.get(hashId(activityId), hashId(enrollmentId))); },
    list() { return selectAll.all().map(decodeRow); },
    activeCount() { return Number(selectActiveCount.get().count); },
    encrypt, decrypt,
    write: (patch, id, clock) => write(patch, id, clock),
    createOrGet: (activityId, enrollmentId, token, resourceKeys, requestId, videoEnabled, clock) => createOrGet(activityId, enrollmentId, token, resourceKeys, requestId, videoEnabled, clock),
    close() { db.close(); }
  };
}

function defaultUpstream(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  return async ({ route, body, token, signal }) => {
    if (!ALLOWED_UPSTREAM_ROUTES.has(route)) throw new SafeError('UPSTREAM_ROUTE_REJECTED', 500);
    let response;
    try {
      response = await fetchImpl(API_ORIGIN + route, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), signal].filter(Boolean)),
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Auth-Token': 'Bearer ' + token
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      if ([COURSEWARE.ROUTES.fileSubmit, COURSEWARE.ROUTES.videoSubmit].includes(route)) {
        console.warn(JSON.stringify({ event: 'learning-submit-response', route, error: error?.name || 'Error' }));
      }
      throw error;
    }
    if (!response.body) throw new SafeError('UPSTREAM_RESPONSE_INVALID', 502);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength ?? chunk.length;
      if (size > MAX_UPSTREAM_BYTES) throw new SafeError('UPSTREAM_RESPONSE_INVALID', 502);
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks, size).toString('utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {
      if ([COURSEWARE.ROUTES.fileSubmit, COURSEWARE.ROUTES.videoSubmit].includes(route)) {
        console.warn(JSON.stringify({ event: 'learning-submit-response', route, httpStatus: response.status, error: 'INVALID_JSON' }));
      }
      throw new SafeError('UPSTREAM_RESPONSE_INVALID', 502);
    }
    if (!response.ok || !parsed || typeof parsed !== 'object' || Number(parsed.code) !== 200) {
      if ([COURSEWARE.ROUTES.fileSubmit, COURSEWARE.ROUTES.videoSubmit].includes(route)) {
        console.warn(JSON.stringify({ event: 'learning-submit-response', route, httpStatus: response.status,
          platformCode: typeof parsed?.code === 'number' || typeof parsed?.code === 'string' ? parsed.code : null }));
      }
      if (response.status === 401 || Number(parsed?.code) === 401) throw new SafeError('AUTH_EXPIRED', 401);
      throw new SafeError('UPSTREAM_REQUEST_FAILED', 502);
    }
    return parsed;
  };
}

function statusMessage(job) {
  const noun = job.video_enabled ? '课件' : '文件课件';
  if (job.status === 'pending') return '任务排队中。';
  if (job.status === 'unknown') return '任务结果待核查，后台已停止操作。';
  if (job.status === 'failed' && job.total === 0 && job.completed === 0 && job.error_code === 'RESOURCE_STATUS_UNVERIFIED') {
    return '课件状态无法核验，未打开或提交任何课件（0/0）。请重新读取培训目录后再试。';
  }
  if (job.status === 'failed' && job.total === 0 && job.completed === 0 && job.error_code === 'CATALOG_READ_FAILED') {
    return '课件目录无法完整读取，未打开或提交任何课件（0/0）。请重新读取培训目录后再试。';
  }
  if (job.status === 'failed') return '任务未能完成，请重新读取培训目录后再试。';
  if (job.status === 'completed') return job.total === 0 ? `当前没有可处理的${noun}。` : `${noun}任务已完成。`;
  switch (job.phase) {
    case 'discovering': return '正在读取培训目录。';
    case 'opening': return job.video_enabled ? '正在打开课件。' : '正在申请文件阅读时长。';
    case 'waiting': return '正在等待课件计时结束。';
    case 'playing': return '正在播放视频课件。';
    case 'submitting': return '正在提交课件学习记录。';
    case 'video-submitting': return '正在提交视频学习记录。';
    case 'verifying': return '正在核验平台完成状态。';
    default: return `${noun}任务正在处理。`;
  }
}

function skippedValue(job) {
  try {
    const parsed = JSON.parse(job.skipped_json || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_) { return {}; }
}

function publicJob(job, now) {
  let current = null;
  try { current = job.current_resource_json ? JSON.parse(job.current_resource_json) : null; } catch (_) {}
  const remaining = job.phase === 'waiting' && Number.isFinite(job.deadline_at)
    ? Math.max(0, Math.ceil((job.deadline_at - now()) / 1000)) : 0;
  const skippedDetails = skippedValue(job);
  const skipped = ['video', 'image', 'unsupported', 'unknownStatus', 'invalid']
    .reduce((sum, key) => sum + Math.max(0, Number(skippedDetails[key]) || 0), 0);
  const publicStatus = job.status === 'pending' || job.status === 'running' ? job.phase : job.status;
  const retryable = job.status === 'failed' && job.total === 0 && job.completed === 0 &&
    !job.current_resource_json && RETRYABLE_PREPARE_FAILURES.has(job.error_code);
  return {
    id: job.id,
    status: publicStatus,
    phase: job.phase,
    activityId: job.activity_id,
    activityEnrollmentId: job.activity_enrollment_id,
    total: job.total,
    completed: job.completed,
    currentIndex: current ? job.current_index + 1 : 0,
    currentTitle: typeof current?.title === 'string' ? current.title : '',
    remainingSeconds: remaining,
    errorCode: job.error_code || '',
    message: statusMessage(job),
    verifiedComplete: job.verified_complete === true,
    skipped,
    skippedDetails,
    retryable,
    updatedAt: new Date(job.updated_at).toISOString()
  };
}

function createWorker(options = {}) {
  const now = options.now || (() => Date.now());
  const wait = options.wait || sleepAbortable;
  const upstream = options.upstream || defaultUpstream(options.fetch);
  const dataDir = options.dataDir || process.env.ZGXY_WORKER_DATA || '/var/lib/zgxy-learning-worker';
  const store = options.store || openStore(dataDir);
  const abortController = new AbortController();
  const inflight = new Set();
  const runningPromises = new Set();
  const scheduled = new Set();
  let videoPlayer = options.videoPlayer || null;
  let videoPlayerLoaded = Boolean(options.videoPlayer);
  let videoDriverQueue = Promise.resolve();
  let stopping = false;
  let booted = false;
  let bootError = null;
  let cleanupTimer = null;

  function write(patch, id) {
    if (store.fatal) throw new SafeError('STORAGE_UNAVAILABLE', 503);
    return store.write(patch, id, now);
  }
  function row(id) {
    if (store.fatal) throw new SafeError('STORAGE_UNAVAILABLE', 503);
    const result = store.getById(id);
    if (!result) throw new SafeError('JOB_NOT_FOUND', 404);
    return result;
  }
  function decryptAuth(job) {
    try { return store.decrypt(job.auth_cipher); } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
  }
  function decryptLearning(job) {
    try { return store.decrypt(job.learning_cipher); } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
  }
  function getVideoPlayer() {
    if (!videoPlayerLoaded) {
      videoPlayerLoaded = true;
      try {
        const module = require('./video-player.cjs');
        if (typeof module.createVideoPlayer !== 'function') throw new Error('factory unavailable');
        videoPlayer = module.createVideoPlayer();
      } catch (_) {
        throw new SafeError('VIDEO_PLAYER_UNAVAILABLE', 503);
      }
    }
    if (!videoPlayer || typeof videoPlayer.play !== 'function') throw new SafeError('VIDEO_PLAYER_UNAVAILABLE', 503);
    return videoPlayer;
  }
  async function withVideoDriver(work) {
    const previous = videoDriverQueue;
    let release;
    videoDriverQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (stopping || abortController.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return await work();
    } finally {
      release();
    }
  }
  async function call(route, body, token) {
    if (!ALLOWED_UPSTREAM_ROUTES.has(route)) throw new SafeError('UPSTREAM_ROUTE_REJECTED', 500);
    const response = await upstream({ route, body, token, signal: abortController.signal });
    if (!response || Number(response.code) !== 200) throw new SafeError('UPSTREAM_REQUEST_FAILED', 502);
    return response;
  }
  function detailFrom(response) {
    if (!response || Number(response.code) !== 200) throw new SafeError('SCOPE_UNVERIFIED', 401);
    const data = response.data;
    const detail = data?.detail || data;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new SafeError('SCOPE_UNVERIFIED', 401);
    return detail;
  }
  async function verifyOuterScope(activityId, enrollmentId, token) {
    const response = await call(COURSEWARE.ROUTES.trainingDetail, { id: activityId }, token);
    const detail = detailFrom(response);
    const returnedId = normalizeId(detail.id ?? detail.activityId);
    const returnedEnrollment = normalizeId(detail.activityEnrollmentId);
    if (!returnedId || returnedId !== activityId || !returnedEnrollment || returnedEnrollment !== enrollmentId) {
      throw new SafeError('SCOPE_MISMATCH', 404);
    }
    return detail;
  }
  function requireToken(request) {
    const value = request.headers.authorization;
    if (typeof value !== 'string' || value.length > 8200) throw new SafeError('AUTH_REQUIRED', 401);
    const match = /^Bearer ([^\s][\s\S]*)$/i.exec(value);
    if (!match || !match[1] || match[1].length > 8192 || /[\r\n]/.test(match[1])) throw new SafeError('AUTH_REQUIRED', 401);
    return match[1];
  }
  function originAllowed(request) {
    const origin = request.headers.origin;
    if (origin !== undefined) return origin === ORIGIN;
    return request.method === 'GET' && request.headers['sec-fetch-site'] === 'same-origin';
  }
  function send(response, status, value) {
    if (response.headersSent) return;
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
  }
  function errorReply(response, error) {
    const err = error instanceof SafeError ? error : new SafeError('REQUEST_FAILED', 500);
    const messages = {
      AUTH_REQUIRED: '请重新登录后再试。',
      SCOPE_MISMATCH: '培训身份与当前账号不匹配。',
      SCOPE_UNVERIFIED: '无法验证当前培训身份。',
      JOB_NOT_FOUND: '未找到当前账号的任务。',
      QUEUE_FULL: '后台任务较多，请稍后再试。',
      STORAGE_UNAVAILABLE: '后台暂时无法安全保存任务。',
      INVALID_REQUEST: '请求格式无效。',
      ORIGIN_REJECTED: '请求来源无效。',
      METHOD_NOT_ALLOWED: '请求方法不支持。',
      BODY_TOO_LARGE: '请求内容过大。',
      UPSTREAM_REQUEST_FAILED: '平台暂时无法处理请求。',
      UPSTREAM_RESPONSE_INVALID: '平台返回内容无法核验。',
      REQUEST_FAILED: '请求暂时无法完成。'
    };
    send(response, err.status || 500, { errorCode: err.code, message: messages[err.code] || '请求暂时无法完成。' });
  }
  async function readJsonBody(request) {
    const contentLength = Number(request.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new SafeError('BODY_TOO_LARGE', 413);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new SafeError('BODY_TOO_LARGE', 413);
      chunks.push(chunk);
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw new SafeError('INVALID_REQUEST', 400); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SafeError('INVALID_REQUEST', 400);
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !keys.includes('activityId') || !keys.includes('activityEnrollmentId')) throw new SafeError('INVALID_REQUEST', 400);
    const activityId = normalizeId(parsed.activityId);
    const enrollmentId = normalizeId(parsed.activityEnrollmentId);
    if (!activityId || !enrollmentId) throw new SafeError('INVALID_REQUEST', 400);
    return { activityId, enrollmentId };
  }
  function queryScope(url) {
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 2 || !url.searchParams.has('activityId') || !url.searchParams.has('activityEnrollmentId')) throw new SafeError('INVALID_REQUEST', 400);
    const activityId = normalizeId(url.searchParams.get('activityId'));
    const enrollmentId = normalizeId(url.searchParams.get('activityEnrollmentId'));
    if (!activityId || !enrollmentId) throw new SafeError('INVALID_REQUEST', 400);
    return { activityId, enrollmentId };
  }
  function writeAuthToken(job, token) {
    if (job.status === 'completed' || job.status === 'failed') return job;
    return write({ auth_cipher: store.encrypt(token) }, job.id);
  }

  async function requestScopeJob(activityId, enrollmentId, token, create) {
    await verifyOuterScope(activityId, enrollmentId, token);
    if (create) throw new SafeError('RESOURCE_FILTER_REQUIRED', 400);
    const job = store.getLatestByScope(activityId, enrollmentId);
    if (!job) return null;
    writeAuthToken(job, token);
    if (job.status === 'pending' || job.status === 'running') scheduleJob(job.id);
    return row(job.id);
  }

  async function handleRequest(request, response) {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === API_ROUTE + '/health' && request.method === 'GET') {
        send(response, 200, { ok: true });
        return;
      }
      if (!originAllowed(request)) throw new SafeError('ORIGIN_REJECTED', 403);
      if (request.method !== 'GET' && request.method !== 'POST') throw new SafeError('METHOD_NOT_ALLOWED', 405);
      if (!booted) {
        await ready;
        if (bootError) throw new SafeError('STORAGE_UNAVAILABLE', 503);
      }
      if (url.pathname === API_ROUTE && request.method === 'POST') {
        const token = requireToken(request);
        const scope = await readJsonBody(request);
        const job = await requestScopeJob(scope.activityId, scope.enrollmentId, token, true);
        send(response, 200, { job: publicJob(job, now) });
        return;
      }
      if (url.pathname === API_ROUTE && request.method === 'GET') {
        const token = requireToken(request);
        const scope = queryScope(url);
        const job = await requestScopeJob(scope.activityId, scope.enrollmentId, token, false);
        send(response, 200, { job: job ? publicJob(job, now) : null });
        return;
      }
      const match = new RegExp('^' + API_ROUTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([0-9a-f-]{36})$').exec(url.pathname);
      if (match && request.method === 'GET') {
        const token = requireToken(request);
        const job = row(match[1]);
        await verifyOuterScope(job.activity_id, job.activity_enrollment_id, token);
        writeAuthToken(job, token);
        if (job.status === 'pending' || job.status === 'running') scheduleJob(job.id);
        send(response, 200, { job: publicJob(row(job.id), now) });
        return;
      }
      throw new SafeError('JOB_NOT_FOUND', 404);
    } catch (error) {
      errorReply(response, error);
    }
  }

  function responseDetail(response) {
    if (!response || Number(response.code) !== 200) return null;
    return response.data?.detail || response.data;
  }
  function collectLeaves(value, defaults, innerEnrollments, found, seenObjects = new Set(), budget = { count: 0 }) {
    if (value === null || value === undefined || budget.count > 30_000) return;
    if (typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    budget.count += 1;
    if (Array.isArray(value)) {
      for (const item of value) collectLeaves(item, defaults, innerEnrollments, found, seenObjects, budget);
      return;
    }
    const type = String(value.type || value.resourceType || '').trim().toUpperCase();
    const id = normalizeId(value.id);
    if (id && (FILE_TYPES.has(type) || type === 'VIDEO')) {
      const activityId = normalizeId(value.activityId) || defaults.activityId || '';
      const activityEnrollmentId = normalizeId(value.activityEnrollmentId) || innerEnrollments.get(activityId) || defaults.activityEnrollmentId || '';
      const key = [activityId, activityEnrollmentId, id].join(':');
      const present = Object.prototype.hasOwnProperty.call(value, 'completionStatus');
      const raw = present ? value.completionStatus : undefined;
      const prior = found.get(key);
      if (prior && (prior.present !== present || JSON.stringify(prior.raw) !== JSON.stringify(raw))) prior.ambiguous = true;
      else if (!prior) found.set(key, { raw, present, ambiguous: false });
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') collectLeaves(child, defaults, innerEnrollments, found, seenObjects, budget);
    }
  }
  async function discoverPlan(job, token) {
    const innerEnrollments = new Map([[job.activity_id, job.activity_enrollment_id]]);
    const courseDetails = new Map();
    const rawLeaves = new Map();
    const postJson = async (route, body) => {
      const response = await call(route, body, token);
      const data = response?.data;
      let defaults = { activityId: job.activity_id, activityEnrollmentId: job.activity_enrollment_id };
      if (route === COURSEWARE.ROUTES.courseDetail) {
        const detail = responseDetail(response);
        const id = normalizeId(detail?.id ?? detail?.activityId);
        const enrollment = normalizeId(detail?.activityEnrollmentId);
        if (id && enrollment) {
          innerEnrollments.set(id, enrollment);
          courseDetails.set(id, { id, enrollment, studyStatus: detail?.studyStatus ?? null });
          defaults = { activityId: id, activityEnrollmentId: enrollment };
        }
      } else if (route === COURSEWARE.ROUTES.trainingSectionDetail || route === COURSEWARE.ROUTES.sectionDetail) {
        const id = normalizeId(body?.activityId) || job.activity_id;
        defaults = { activityId: id, activityEnrollmentId: innerEnrollments.get(id) || job.activity_enrollment_id };
      } else if (route === COURSEWARE.ROUTES.onlineContentList) {
        const id = normalizeId(body?.params?.activityId) || job.activity_id;
        defaults = { activityId: id, activityEnrollmentId: innerEnrollments.get(id) || job.activity_enrollment_id };
      }
      collectLeaves(data, defaults, innerEnrollments, rawLeaves);
      return response;
    };
    const result = await COURSEWARE.discoverCourseware({
      postJson,
      isCurrent: () => true,
      scope: { activityId: job.activity_id, activityEnrollmentId: job.activity_enrollment_id },
      sourceUrl: COURSEWARE.SOURCE_URL
    });
    if (!result?.ok) throw new SafeError('CATALOG_READ_FAILED', 502);
    return { result, innerEnrollments, courseDetails, rawLeaves };
  }
  function classifyCompletion(raw, ambiguous, isVideo = false) {
    if (ambiguous) return 'unknown';
    const status = safeStatus(raw);
    if (isVideo ? status === 'COMPLETED' : COMPLETED.has(status)) return 'completed';
    if (UNFINISHED.has(status)) return 'unfinished';
    return 'unknown';
  }
  function explicitNullLeafStatus(raw) {
    return raw && !raw.ambiguous && raw.present === true && raw.raw === null;
  }
  function canInferUnstartedFile(resource, raw, inner, activityResources, rawLeaves, catalogClean) {
    const allPdfsExplicitlyNull = activityResources.length > 0 && activityResources.every(candidate => {
      if (!['PDF', 'VIDEO'].includes(String(candidate.type).toUpperCase()) ||
        String(candidate.activityId) !== String(resource.activityId) ||
        String(candidate.activityEnrollmentId) !== String(resource.activityEnrollmentId)) return false;
      return explicitNullLeafStatus(rawLeaves.get(resourceKey(candidate)));
    });
    return explicitNullLeafStatus(raw) && resource.type === 'PDF' && catalogClean && allPdfsExplicitlyNull && inner &&
      inner.id === String(resource.activityId) && inner.enrollment === String(resource.activityEnrollmentId) &&
      safeStatus(inner.studyStatus) === 'NOTATTEMPT';
  }
  function canInferUnstartedVideo(resource, raw, inner, activityResources, rawLeaves, catalogClean) {
    const allVideosExplicitlyNull = activityResources.length > 0 && activityResources.every(candidate => {
      if (!['PDF', 'VIDEO'].includes(String(candidate.type).toUpperCase()) ||
        String(candidate.activityId) !== String(resource.activityId) ||
        String(candidate.activityEnrollmentId) !== String(resource.activityEnrollmentId)) return false;
      return explicitNullLeafStatus(rawLeaves.get(resourceKey(candidate)));
    });
    return explicitNullLeafStatus(raw) && resource.type === 'VIDEO' && catalogClean && allVideosExplicitlyNull && inner &&
      inner.id === String(resource.activityId) && inner.enrollment === String(resource.activityEnrollmentId) &&
      safeStatus(inner.studyStatus) === 'NOTATTEMPT';
  }
  function skippedCounts() {
    return { completed: 0, video: 0, image: 0, unsupported: 0, unknownStatus: 0, invalid: 0 };
  }
  function resourceKey(resource) {
    return [String(resource.activityId), String(resource.activityEnrollmentId), String(resource.id)].join(':');
  }
  function assertAuthoritativeInner(resource, job, innerEnrollments) {
    const activityId = String(resource.activityId);
    const enrollment = String(resource.activityEnrollmentId);
    const expected = innerEnrollments.get(activityId);
    if (activityId === job.activity_id) {
      if (enrollment !== job.activity_enrollment_id || (expected && expected !== enrollment)) throw new SafeError('CATALOG_IDENTITY_MISMATCH', 409);
      return;
    }
    if (!expected || enrollment !== expected) throw new SafeError('CATALOG_IDENTITY_MISMATCH', 409);
  }
  function compactResource(resource) {
    const compact = {
      id: String(resource.id), activityId: String(resource.activityId),
      activityEnrollmentId: String(resource.activityEnrollmentId),
      type: String(resource.type), title: String(resource.title || '学习课件').slice(0, 300)
    };
    if (String(resource.type).toUpperCase() === 'VIDEO') {
      compact.mediaUrl = resource.mediaUrl;
      compact.fastForwardAllowed = false;
      if (Number.isFinite(resource.officialDurationSeconds) && resource.officialDurationSeconds > 0 && resource.officialDurationSeconds <= 7200) {
        compact.officialDurationSeconds = resource.officialDurationSeconds;
      }
    }
    return compact;
  }
  function refreshedVideoResource(resource, opened) {
    if (!resource || resource.type !== 'VIDEO' || !resource.mediaUrl) return null;
    if (opened !== undefined && opened !== null) {
      if (!opened || typeof opened !== 'object' || Array.isArray(opened)) return null;
      for (const [key, expected] of [['id', resource.id], ['activityId', resource.activityId], ['activityEnrollmentId', resource.activityEnrollmentId]]) {
        const actual = opened[key];
        if (actual !== undefined && actual !== null && actual !== '' && normalizeId(actual) !== expected) return null;
      }
    }
    const freshMediaUrl = typeof opened?.mediaUrl === 'string' && opened.mediaUrl.trim() ? opened.mediaUrl :
      typeof opened?.videoSrc === 'string' && opened.videoSrc.trim() ? opened.videoSrc :
      typeof opened?.files?.url === 'string' && opened.files.url.trim() ? opened.files.url : '';
    const mediaUrl = freshMediaUrl || resource.mediaUrl;
    let parsed;
    let trusted;
    try {
      parsed = new URL(mediaUrl, COURSEWARE.SOURCE_URL);
      trusted = new URL(COURSEWARE.SOURCE_URL);
    } catch (_) { return null; }
    if (parsed.protocol !== 'https:' || parsed.origin !== trusted.origin || parsed.username || parsed.password || parsed.hash) return null;
    const normalized = COURSEWARE.normalizeResource({
      id: resource.id, activityId: resource.activityId, activityEnrollmentId: resource.activityEnrollmentId,
      type: 'VIDEO', title: opened?.resourceTitle || opened?.title || resource.title, mediaUrl: parsed.href
    }, { activityId: resource.activityId, activityEnrollmentId: resource.activityEnrollmentId }, COURSEWARE.SOURCE_URL);
    if (!normalized.ok) return null;
    return { ...resource, mediaUrl: normalized.resource.mediaUrl };
  }
  async function prepare(job) {
    write({ status: 'running', phase: 'discovering', error_code: null }, job.id);
    const current = row(job.id);
    let allowedResourceKeys;
    try {
      const parsed = JSON.parse(current.resource_filter_json || '[]');
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 2000 ||
          parsed.some(key => typeof key !== 'string' || !key || key.length > 400)) throw new Error('invalid-filter');
      allowedResourceKeys = new Set(parsed);
    } catch (_) {
      write({ status: 'failed', phase: 'failed', error_code: 'RESOURCE_FILTER_MISSING',
        auth_cipher: null, learning_cipher: null, current_resource_json: null }, current.id);
      return;
    }
    let token;
    try { token = decryptAuth(current); } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
    const { result, innerEnrollments, courseDetails, rawLeaves } = await discoverPlan(current, token);
    const skipped = skippedCounts();
    skipped.unsupported = Array.isArray(result.unsupported) ? result.unsupported.length : 0;
    const catalogClean = result.unsupported.length === 0 && result.unavailableRows.length === 0;
    const plan = [];
    const matchedFilterKeys = new Set();
    let invalidFilteredType = false;
    const resourcesByActivity = new Map();
    for (const resource of result.resources) {
      const activityId = String(resource.activityId);
      const group = resourcesByActivity.get(activityId) || [];
      group.push(resource);
      resourcesByActivity.set(activityId, group);
    }
    for (const resource of result.resources) {
      const key = resourceKey(resource);
      if (!allowedResourceKeys.has(key)) continue;
      matchedFilterKeys.add(key);
      if (resource.kind === 'video' && String(resource.type).toUpperCase() === 'VIDEO') {
        if (!current.video_enabled) {
          skipped.video += 1;
          invalidFilteredType = true;
          continue;
        }
      } else if (resource.kind !== 'file' || !FILE_TYPES.has(String(resource.type).toUpperCase())) {
        if (resource.kind === 'video') skipped.video += 1;
        else if (resource.kind === 'image') skipped.image += 1;
        else skipped.unsupported += 1;
        invalidFilteredType = true;
        continue;
      }
      try { assertAuthoritativeInner(resource, current, innerEnrollments); }
      catch (_) { throw new SafeError('CATALOG_IDENTITY_MISMATCH', 409); }
      const raw = rawLeaves.get(resourceKey(resource));
      let classification = classifyCompletion(raw?.raw, !raw || raw.ambiguous, resource.type === 'VIDEO');
      if (classification === 'unknown') {
        const inner = courseDetails.get(String(resource.activityId));
        const activityResources = resourcesByActivity.get(String(resource.activityId)) || [];
        if (canInferUnstartedFile(resource, raw, inner, activityResources, rawLeaves, catalogClean) ||
            canInferUnstartedVideo(resource, raw, inner, activityResources, rawLeaves, catalogClean)) classification = 'unfinished';
      }
      if (classification === 'completed') { skipped.completed += 1; continue; }
      if (classification === 'unknown') { skipped.unknownStatus += 1; continue; }
      plan.push(compactResource(resource));
    }
    if (invalidFilteredType || [...allowedResourceKeys].some(key => !matchedFilterKeys.has(key))) {
      write({ status: 'failed', phase: 'failed', total: 0, completed: 0, current_index: 0,
        plan_json: '[]', current_resource_json: null, auth_cipher: null, learning_cipher: null,
        skipped_json: JSON.stringify(skipped), error_code: 'RESOURCE_FILTER_MISMATCH', verified_complete: false }, current.id);
      return;
    }
    if (skipped.unknownStatus > 0) {
      write({ status: 'failed', phase: 'failed', total: 0, completed: 0, current_index: 0,
        plan_json: '[]', current_resource_json: null, auth_cipher: null, learning_cipher: null,
        skipped_json: JSON.stringify(skipped), error_code: 'RESOURCE_STATUS_UNVERIFIED', verified_complete: false }, current.id);
      return;
    }
    const planJson = JSON.stringify(plan);
    if (Buffer.byteLength(planJson, 'utf8') > 2 * 1024 * 1024) throw new SafeError('CATALOG_TOO_LARGE', 502);
    if (plan.length === 0) {
      write({ status: 'completed', phase: 'completed', total: 0, completed: 0, current_index: 0,
        plan_json: '[]', current_resource_json: null, auth_cipher: null, learning_cipher: null,
        skipped_json: JSON.stringify(skipped), error_code: null,
        verified_complete: skipped.completed === allowedResourceKeys.size }, current.id);
      return;
    }
    write({ status: 'running', phase: 'opening', total: plan.length, completed: 0, current_index: 0,
      plan_json: planJson, current_resource_json: JSON.stringify(plan[0]), auth_cipher: store.encrypt(token),
      learning_cipher: null, open_received_at: null, deadline_at: null, skipped_json: JSON.stringify(skipped),
      error_code: null, verified_complete: false }, current.id);
  }
  async function openCurrent(job) {
    let token;
    try { token = decryptAuth(job); } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
    let resource;
    try { resource = JSON.parse(job.current_resource_json || 'null'); } catch (_) { throw new SafeError('STATE_INVALID', 500); }
    if (!resource || !FILE_TYPES.has(resource.type)) throw new SafeError('STATE_INVALID', 500);
    let response;
    try {
      response = await call(COURSEWARE.ROUTES.fileOpen, {
        mode: 'LEARN', id: resource.id, activityId: resource.activityId,
        activityEnrollmentId: resource.activityEnrollmentId
      }, token);
    } catch (_) {
      write({ status: 'unknown', phase: 'unknown', error_code: 'OPEN_OUTCOME_UNKNOWN', learning_cipher: null }, job.id);
      return;
    }
    const data = response?.data;
    const learningToken = typeof data?.learningToken === 'string' ? data.learningToken : '';
    const rawSeconds = data?.sumTime;
    const seconds = rawSeconds === 0 || rawSeconds === '0' ? 0
      : rawSeconds === null || rawSeconds === undefined || String(rawSeconds).trim() === '' ? NaN : Number(rawSeconds);
    if (!learningToken || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SUM_TIME_SECONDS) {
      write({ status: 'unknown', phase: 'unknown', error_code: 'OPEN_RESPONSE_INVALID', learning_cipher: null }, job.id);
      return;
    }
    const receivedAt = now();
    write({ status: 'running', phase: 'waiting', learning_cipher: store.encrypt(learningToken),
      open_received_at: receivedAt, deadline_at: receivedAt + seconds * 1000, error_code: null }, job.id);
  }
  async function openVideoCurrent(job) {
    let token;
    try { token = decryptAuth(job); } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
    let resource;
    try { resource = JSON.parse(job.current_resource_json || 'null'); } catch (_) { throw new SafeError('STATE_INVALID', 500); }
    if (!resource || resource.type !== 'VIDEO' || !refreshedVideoResource(resource, null)) throw new SafeError('STATE_INVALID', 500);
    let response;
    try {
      response = await call(COURSEWARE.ROUTES.videoOpen, {
        mode: 'LEARN', id: resource.id, activityId: resource.activityId,
        activityEnrollmentId: resource.activityEnrollmentId
      }, token);
    } catch (_) {
      write({ status: 'unknown', phase: 'unknown', error_code: 'OPEN_OUTCOME_UNKNOWN', learning_cipher: null }, job.id);
      return;
    }
    const data = response?.data;
    const learningToken = typeof data?.learningToken === 'string' ? data.learningToken : '';
    const refreshed = refreshedVideoResource(resource, data?.resource);
    if (!learningToken || !refreshed) {
      write({ status: 'unknown', phase: 'unknown', error_code: 'OPEN_RESPONSE_INVALID', learning_cipher: null }, job.id);
      return;
    }
    const fastForwardAllowed = COURSEWARE.fastForwardAllowed(data?.resource?.fastForwardInd);
    const officialDuration = resource.officialDurationSeconds;
    if (Number.isFinite(officialDuration) && officialDuration > 0 && officialDuration <= 7200) {
      // The official catalog duration is sufficient for this submit path; persist the write phase before POST.
      write({ status: 'running', phase: 'video-submitting', current_resource_json: JSON.stringify({
        ...refreshed, duration: officialDuration
      }), learning_cipher: store.encrypt(learningToken), open_received_at: null, deadline_at: null,
      error_code: null }, job.id);
      return;
    }
    write({ status: 'running', phase: 'playing', current_resource_json: JSON.stringify({
      ...refreshed, fastForwardAllowed
    }), learning_cipher: store.encrypt(learningToken), open_received_at: null, deadline_at: null,
    error_code: null }, job.id);
  }
  async function playVideoCurrent(job) {
    let authToken, resource;
    try {
      authToken = decryptAuth(job);
      resource = JSON.parse(job.current_resource_json || 'null');
    } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
    if (!resource || resource.type !== 'VIDEO' || !refreshedVideoResource(resource, null)) throw new SafeError('STATE_INVALID', 500);
    const player = getVideoPlayer();
    let result;
    try {
      result = await withVideoDriver(() => player.play({
        mediaUrl: resource.mediaUrl,
        token: authToken,
        fastForwardAllowed: resource.fastForwardAllowed === true,
        signal: abortController.signal
      }));
    } catch (error) {
      if (error?.name === 'AbortError' || stopping) throw error;
      throw new SafeError('VIDEO_PLAYBACK_FAILED', 502);
    }
    const duration = result?.duration;
    const currentTime = result?.currentTime;
    if (result?.ended !== true || !Number.isFinite(duration) || duration <= 0 ||
        !Number.isFinite(currentTime) || currentTime < duration - 1.5 || currentTime > duration + 0.25) {
      throw new SafeError('VIDEO_PLAYBACK_UNCONFIRMED', 502);
    }
    // Persist this phase before submitting. A restart verifies read-only and never retries the write.
    write({ status: 'running', phase: 'video-submitting', current_resource_json: JSON.stringify({
      ...resource, duration
    }), error_code: null }, job.id);
  }
  async function submitVideoCurrent(job) {
    let token, learningToken, resource;
    try {
      token = decryptAuth(job);
      learningToken = decryptLearning(job);
      resource = JSON.parse(job.current_resource_json || 'null');
    } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
    if (!resource || resource.type !== 'VIDEO') throw new SafeError('STATE_INVALID', 500);
    const duration = resource.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new SafeError('STATE_INVALID', 500);
    try {
      await call(COURSEWARE.ROUTES.videoSubmit, {
        mode: 'LEARN', id: resource.id, activityId: resource.activityId,
        activityEnrollmentId: resource.activityEnrollmentId, learningToken, data: duration
      }, token);
    } catch (_) {
      write({ status: 'running', phase: 'verifying', error_code: 'SUBMIT_OUTCOME_UNKNOWN', learning_cipher: null }, job.id);
      return;
    }
    write({ status: 'running', phase: 'verifying', learning_cipher: null, error_code: null }, job.id);
  }
  async function waitCurrent(job) {
    if (!Number.isFinite(job.deadline_at)) {
      write({ status: 'unknown', phase: 'unknown', error_code: 'DEADLINE_UNAVAILABLE', learning_cipher: null }, job.id);
      return;
    }
    try {
      while (!stopping && !abortController.signal.aborted) {
        const remaining = job.deadline_at - now();
        if (remaining <= 0) break;
        await wait(Math.min(remaining, 60_000), abortController.signal);
      }
    } catch (error) {
      if (error?.name === 'AbortError' || stopping) return;
      throw error;
    }
    if (stopping || abortController.signal.aborted) return;
    write({ status: 'running', phase: 'submitting' }, job.id);
  }
  async function submitCurrent(job) {
    let token, learningToken, resource;
    try {
      token = decryptAuth(job);
      learningToken = decryptLearning(job);
      resource = JSON.parse(job.current_resource_json || 'null');
    } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
    if (!resource || !FILE_TYPES.has(resource.type)) throw new SafeError('STATE_INVALID', 500);
    try {
      await call(COURSEWARE.ROUTES.fileSubmit, {
        mode: 'LEARN', id: resource.id, activityId: resource.activityId,
        activityEnrollmentId: resource.activityEnrollmentId, learningToken
      }, token);
    } catch (_) {
      write({ status: 'running', phase: 'verifying', error_code: 'SUBMIT_OUTCOME_UNKNOWN', learning_cipher: null }, job.id);
      return;
    }
    write({ status: 'running', phase: 'verifying', learning_cipher: null, error_code: null }, job.id);
  }
  function completedLeafStatus(raw, ambiguous) {
    return !ambiguous && COMPLETED.has(safeStatus(raw));
  }
  function catalogConfirmsResource(job, resource, discovered) {
    assertAuthoritativeInner(resource, job, discovered.innerEnrollments);
    const raw = discovered.rawLeaves.get(resourceKey(resource));
    const inner = discovered.courseDetails.get(resource.activityId);
    const confirmedLeaf = raw && (resource.type === 'VIDEO'
      ? !raw.ambiguous && safeStatus(raw.raw) === 'COMPLETED'
      : completedLeafStatus(raw.raw, raw.ambiguous));
    return Boolean(confirmedLeaf || (resource.type !== 'VIDEO' && inner &&
      inner.enrollment === resource.activityEnrollmentId && COMPLETED.has(safeStatus(inner.studyStatus))));
  }
  async function verifyCurrent(job) {
    let token;
    try { token = decryptAuth(job); } catch (_) { throw new SafeError('TOKEN_UNAVAILABLE', 503); }
    let resource;
    try { resource = JSON.parse(job.current_resource_json || 'null'); } catch (_) { throw new SafeError('STATE_INVALID', 500); }
    if (!resource || (!FILE_TYPES.has(resource.type) && resource.type !== 'VIDEO')) throw new SafeError('STATE_INVALID', 500);
    let foundComplete = false;
    const delays = [0, 1000, 2000, 4000];
    for (const delay of delays) {
      if (delay > 0) {
        try { await wait(delay, abortController.signal); }
        catch (error) { if (error?.name === 'AbortError' || stopping) return; throw error; }
      }
      if (stopping || abortController.signal.aborted) return;
      let discovered;
      try { discovered = await discoverPlan(row(job.id), token); }
      catch (_) { continue; }
      try { if (catalogConfirmsResource(row(job.id), resource, discovered)) { foundComplete = true; break; } }
      catch (_) { continue; }
    }
    if (!foundComplete) {
      write({ status: 'unknown', phase: 'unknown', error_code: 'COMPLETION_UNVERIFIED', learning_cipher: null }, job.id);
      return;
    }
    const plan = JSON.parse(job.plan_json || '[]');
    const nextIndex = job.current_index + 1;
    if (nextIndex >= plan.length) {
      write({ status: 'completed', phase: 'completed', completed: job.completed + 1, current_index: nextIndex,
        current_resource_json: null, auth_cipher: null, learning_cipher: null, deadline_at: null,
        open_received_at: null, error_code: null, verified_complete: true }, job.id);
      return;
    }
    const next = plan[nextIndex];
    write({ status: 'running', phase: 'opening', completed: job.completed + 1, current_index: nextIndex,
      current_resource_json: JSON.stringify(next), learning_cipher: null, deadline_at: null,
      open_received_at: null, error_code: null, verified_complete: false }, job.id);
  }
  async function runJob(id) {
    while (!stopping && !store.fatal) {
      let job;
      try { job = row(id); } catch (_) { return; }
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'unknown') return;
      try {
        if (job.phase === 'queued' || job.phase === 'discovering') await prepare(job);
        else if (job.phase === 'opening') {
          let resource;
          try { resource = JSON.parse(job.current_resource_json || 'null'); } catch (_) { throw new SafeError('STATE_INVALID', 500); }
          if (resource?.type === 'VIDEO') await openVideoCurrent(job);
          else await openCurrent(job);
        }
        else if (job.phase === 'waiting') await waitCurrent(job);
        else if (job.phase === 'playing') await playVideoCurrent(job);
        else if (job.phase === 'video-submitting') await submitVideoCurrent(job);
        else if (job.phase === 'submitting') await submitCurrent(job);
        else if (job.phase === 'verifying') await verifyCurrent(job);
        else {
          write({ status: 'failed', phase: 'failed', error_code: 'STATE_INVALID', auth_cipher: null, learning_cipher: null }, id);
          return;
        }
      } catch (error) {
        if (stopping || error?.name === 'AbortError') return;
        if (store.fatal) return;
        let current;
        try { current = row(id); } catch (_) { return; }
        if (current.phase === 'video-submitting') {
          try { write({ status: 'running', phase: 'verifying', error_code: 'SUBMIT_OUTCOME_UNKNOWN', learning_cipher: null }, id); } catch (_) {}
        } else if (current.phase === 'playing' && error instanceof SafeError &&
            ['VIDEO_PLAYBACK_FAILED', 'VIDEO_PLAYBACK_UNCONFIRMED', 'VIDEO_PLAYER_UNAVAILABLE'].includes(error.code)) {
          try { write({ status: 'failed', phase: 'failed', error_code: error.code, auth_cipher: null, learning_cipher: null }, id); } catch (_) {}
        } else if (current.phase === 'opening' || current.phase === 'playing' || current.phase === 'submitting' || current.phase === 'verifying') {
          try { write({ status: 'unknown', phase: 'unknown', error_code: error instanceof SafeError ? error.code : 'OUTCOME_UNKNOWN', learning_cipher: null }, id); } catch (_) {}
        } else {
          try { write({ status: 'failed', phase: 'failed', error_code: error instanceof SafeError ? error.code : 'TASK_FAILED', auth_cipher: null, learning_cipher: null }, id); } catch (_) {}
        }
        return;
      }
      try { job = row(id); } catch (_) { return; }
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'unknown') return;
      if (job.phase === 'waiting') {
        // The loop waits without retaining either platform secret in this stack frame.
        continue;
      }
      if (job.phase === 'submitting' || job.phase === 'video-submitting' || job.phase === 'verifying' || job.phase === 'opening' || job.phase === 'playing') continue;
      if (job.phase === 'queued' || job.phase === 'discovering') continue;
    }
  }
  function scheduleJob(id) {
    if (stopping || store.fatal || inflight.has(id) || scheduled.has(id)) return;
    scheduled.add(id);
    queueMicrotask(() => {
      scheduled.delete(id);
      if (stopping || store.fatal || inflight.has(id)) return;
      inflight.add(id);
      const task = runJob(id).catch(() => {}).finally(() => {
        inflight.delete(id);
        runningPromises.delete(task);
      });
      runningPromises.add(task);
    });
  }
  function recover() {
    const all = store.list();
    for (const job of all) {
      if (job.status === 'running' && job.phase === 'opening') {
        write({ status: 'unknown', phase: 'unknown', error_code: 'INTERRUPTED_OPEN', learning_cipher: null }, job.id);
      } else if (job.status === 'running' && job.phase === 'submitting') {
        write({ status: 'running', phase: 'verifying', learning_cipher: null }, job.id);
      } else if (job.status === 'running' && job.phase === 'video-submitting') {
        write({ status: 'running', phase: 'verifying', error_code: 'SUBMIT_OUTCOME_UNKNOWN', learning_cipher: null }, job.id);
      } else if (job.status === 'running' && job.phase === 'playing') {
        write({ status: 'running', phase: 'verifying', error_code: 'PLAYBACK_INTERRUPTED', learning_cipher: null }, job.id);
      } else if (job.status === 'running' && job.phase === 'discovering') {
        write({ status: 'pending', phase: 'queued' }, job.id);
      }
    }
    for (const job of store.list()) if (job.status === 'pending' || job.status === 'running') scheduleJob(job.id);
  }
  function cleanupSecrets() {
    const cutoff = now() - SECRET_RETENTION_MS;
    for (const job of store.list()) {
      if (job.status === 'unknown' && job.updated_at < cutoff && (job.auth_cipher || job.learning_cipher)) {
        try { write({ auth_cipher: null, learning_cipher: null }, job.id); } catch (_) { return; }
      }
    }
  }
  const ready = Promise.resolve().then(() => {
    recover();
    booted = true;
    cleanupSecrets();
    cleanupTimer = setInterval(cleanupSecrets, 60 * 60 * 1000);
    cleanupTimer.unref?.();
  }).catch(() => {
    bootError = true;
    booted = true;
  });
  const server = http.createServer((request, response) => { void handleRequest(request, response); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  return {
    server,
    ready,
    async listen(port = Number(process.env.PORT || 9138), host = '127.0.0.1') {
      await ready;
      if (bootError) throw new Error('worker storage initialization failed');
      return new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    async enqueueFiltered(input) {
      await ready;
      if (bootError || stopping) throw new SafeError('STORAGE_UNAVAILABLE', 503);
      if (!input || typeof input !== 'object') throw new SafeError('INVALID_REQUEST', 400);
      const activityId = normalizeId(input.activityId);
      const enrollmentId = normalizeId(input.activityEnrollmentId);
      const token = typeof input.token === 'string' ? input.token : '';
      if (!activityId || !enrollmentId || !token) throw new SafeError('INVALID_REQUEST', 400);
      await verifyOuterScope(activityId, enrollmentId, token);
      const result = store.createOrGet(activityId, enrollmentId, token, input.resourceKeys, input.requestId, input.allowVideo === true, now);
      scheduleJob(result.job.id);
      return publicJob(row(result.job.id), now);
    },
    async getFilteredJob(requestId) {
      await ready;
      if (bootError) throw new SafeError('STORAGE_UNAVAILABLE', 503);
      const job = store.getByRequestId(requestId);
      return job ? publicJob(job, now) : null;
    },
    async retryPreparation(input) {
      await ready;
      if (bootError || stopping) throw new SafeError('STORAGE_UNAVAILABLE', 503);
      const token = typeof input?.token === 'string' ? input.token : '';
      const job = typeof input?.requestId === 'string' ? store.getByRequestId(input.requestId) : null;
      if (!token || !job) throw new SafeError('JOB_NOT_FOUND', 404);
      if (job.status !== 'failed' || job.error_code !== 'RESOURCE_STATUS_UNVERIFIED' ||
          job.total !== 0 || job.completed !== 0 || job.current_resource_json) return publicJob(job, now);
      await verifyOuterScope(job.activity_id, job.activity_enrollment_id, token);
      const current = store.getByRequestId(input.requestId);
      if (!current || current.status !== 'failed' || current.error_code !== 'RESOURCE_STATUS_UNVERIFIED' ||
          current.total !== 0 || current.completed !== 0 || current.current_resource_json) return current ? publicJob(current, now) : null;
      if (store.getActiveByScope(current.activity_id, current.activity_enrollment_id) || store.activeCount() >= MAX_ACTIVE_JOBS) {
        throw new SafeError('QUEUE_FULL', 429);
      }
      write({ status: 'pending', phase: 'queued', error_code: null, auth_cipher: store.encrypt(token),
        learning_cipher: null, verified_complete: false }, current.id);
      scheduleJob(current.id);
      return publicJob(row(current.id), now);
    },
    async recheckUnknown(input) {
      await ready;
      if (bootError || stopping) throw new SafeError('STORAGE_UNAVAILABLE', 503);
      const token = typeof input?.token === 'string' ? input.token : '';
      const job = typeof input?.requestId === 'string' ? store.getByRequestId(input.requestId) : null;
      if (!job || !token || token.length > 8192 || /[\r\n]/.test(token)) throw new SafeError('INVALID_REQUEST', 400);
      if (job.status !== 'unknown' || job.error_code !== 'COMPLETION_UNVERIFIED') return publicJob(job, now);
      let resource;
      try { resource = JSON.parse(job.current_resource_json || 'null'); } catch (_) { throw new SafeError('STATE_INVALID', 500); }
      if (!resource || (!FILE_TYPES.has(resource.type) && resource.type !== 'VIDEO')) throw new SafeError('STATE_INVALID', 500);
      await verifyOuterScope(job.activity_id, job.activity_enrollment_id, token);
      const discovered = await discoverPlan(job, token);
      if (!catalogConfirmsResource(job, resource, discovered)) return publicJob(job, now);
      const current = store.getByRequestId(input.requestId);
      if (!current || current.status !== 'unknown' || current.error_code !== 'COMPLETION_UNVERIFIED' ||
          current.current_index !== job.current_index || current.current_resource_json !== job.current_resource_json) return current ? publicJob(current, now) : null;
      let plan;
      try { plan = JSON.parse(current.plan_json || '[]'); } catch (_) { throw new SafeError('STATE_INVALID', 500); }
      if (!Array.isArray(plan) || current.current_index >= plan.length) throw new SafeError('STATE_INVALID', 500);
      const planned = plan[current.current_index];
      if (!planned || ['id', 'activityId', 'activityEnrollmentId', 'type'].some(key => String(planned[key] ?? '') !== String(resource[key] ?? ''))) throw new SafeError('STATE_INVALID', 500);
      const nextIndex = current.current_index + 1;
      if (nextIndex >= plan.length) {
        write({ status: 'completed', phase: 'completed', completed: current.completed + 1, current_index: nextIndex,
          current_resource_json: null, auth_cipher: null, learning_cipher: null, deadline_at: null,
          open_received_at: null, error_code: null, verified_complete: true }, current.id);
      } else {
        write({ status: 'running', phase: 'opening', completed: current.completed + 1, current_index: nextIndex,
          current_resource_json: JSON.stringify(plan[nextIndex]), auth_cipher: store.encrypt(token), learning_cipher: null,
          deadline_at: null, open_received_at: null, error_code: null, verified_complete: false }, current.id);
        scheduleJob(current.id);
      }
      return publicJob(row(current.id), now);
    },
    async getActiveJob(activityId, enrollmentId) {
      await ready;
      if (bootError) throw new SafeError('STORAGE_UNAVAILABLE', 503);
      const job = store.getActiveByScope(activityId, enrollmentId);
      return job ? publicJob(job, now) : null;
    },
    async close() {
      stopping = true;
      abortController.abort();
      if (cleanupTimer) clearInterval(cleanupTimer);
      await new Promise(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
      await Promise.allSettled([...runningPromises]);
      try { await videoPlayer?.close?.(); } catch (_) {}
      try { store.close(); } catch (_) {}
    },
    _store: store,
    _scheduleJob: scheduleJob
  };
}

if (require.main === module) {
  const worker = createWorker();
  worker.listen().catch(() => {
    process.stderr.write('zgxy learning worker startup failed\n');
    process.exitCode = 1;
  });
  const stop = () => { void worker.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

module.exports = { createWorker, openStore, publicJob, defaultUpstream, API_ROUTE, ORIGIN, MAX_SUM_TIME_SECONDS };
