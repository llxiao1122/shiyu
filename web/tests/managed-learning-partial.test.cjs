'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workerDirectory = process.env.LEARN_WORKER_DIRECTORY || '/usr/local/lib/zg-managed-learning/worker';

test('dashboard refresh performs one real scan with live progress and the existing platform token', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-learning-refresh-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/service.cjs'), path.join(directory, 'service.cjs'));
  fs.symlinkSync(workerDirectory, path.join(directory, 'worker'), 'dir');
  const mod = require(path.join(directory, 'service.cjs'));
  const cw = require(path.join(workerDirectory, 'learning-courseware.js'));
  const store = mod.openStore(path.join(directory, 'data'));
  const timestamp = Date.now(), cookie = 'B'.repeat(43);
  const accountId = store.saveAccount({ orgCode: 'ZGXY', username: 'test', password: 'password', token: 'current-token', userId: 'user', allowVideo: true }, timestamp);
  store.createSession(cookie, accountId, timestamp);
  const scopeHash = store.scopeHash(accountId, 'training', 'enrollment');
  store.setBaseline({ scopeHash, accountId, activityId: 'training', enrollmentId: 'enrollment', title: 'training', status: 'complete', learningStatus: 'incomplete', examStatus: 'none', completedAt: timestamp, updatedAt: timestamp });
  store.upsertDiscoveredResource({ accountId, scopeHash, activityId: 'training', enrollmentId: 'enrollment', resourceId: 'file', resourceKey: 'training:enrollment:file', type: 'PDF', title: 'file', trainingTitle: 'training', isBaseline: false, updatedAt: timestamp });
  const [batch] = store.createBatchesForNew(accountId, timestamp);
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const platform = async ({ route, token }) => {
    calls.push({ route, token });
    if (route === mod.TRAINING_ROUTE) return { code: 200, data: { content: { records: [{ id: 'training' }], current: 1, pages: 1 } } };
    if (route === cw.ROUTES.trainingDetail) { entered(); await waiting; return { code: 200, data: { id: 'training', activityEnrollmentId: 'enrollment', studyStatus: 'PROGRESS', onlineInd: true, examInd: false } }; }
    if (route === cw.ROUTES.trainingContentList) return { code: 200, data: { content: [{ id: 'file', type: 'PDF', files: { url: '/file.pdf' }, completionStatus: 'NOTATTEMPT' }], totalPages: 1, last: true } };
    if (route === mod.TRAINING_EXAM_ROUTE) return { code: 200, data: { content: [], number: 0, totalPages: 0, last: true } };
    throw new Error(`unexpected route ${route}`);
  };
  const worker = { ready: Promise.resolve(), close: async () => {}, getFilteredJob: async id => id === batch.id ? { id: 'running-job', status: 'waiting', phase: 'waiting', total: 1, completed: 0 } : null };
  const service = mod.createService({ store, worker, platform, origin: 'https://learn.ciphera.top', scheduleEnabled: false });
  try {
    const address = await service.listen(0), base = `http://127.0.0.1:${address.port}/zg/api/`;
    const headers = { Origin: 'https://learn.ciphera.top', 'Content-Type': 'application/json', Cookie: `zg_session=${cookie}` };
    const first = await fetch(base + 'refresh', { method: 'POST', headers, body: '{}' });
    assert.equal(first.status, 202);
    await started;
    for (let index = 0; index < 12; index++) {
      const repeated = await fetch(base + 'refresh', { method: 'POST', headers, body: '{}' });
      assert.equal(repeated.status, 202);
      assert.equal((await repeated.json()).alreadyRunning, true);
    }
    const identity = await (await fetch(base + 'exam-identity', { headers })).json();
    assert.equal(identity.platformToken, 'current-token');
    assert.equal(identity.userId, 'user');
    const progress = await (await fetch(base + 'progress', { headers })).json();
    assert.deepEqual({ stage: progress.progress.scanProgress.stage, processed: progress.progress.scanProgress.processed, total: progress.progress.scanProgress.total }, { stage: 'checking', processed: 0, total: 1 });
    const second = await (await fetch(base + 'refresh', { method: 'POST', headers, body: '{}' })).json();
    assert.equal(second.alreadyRunning, true);
    release(); await service.waitForIdle();
    assert.equal(store.progress(accountId).scanProgress.stage, 'complete');
    assert.equal(store.progress(accountId).scanProgress.processed, 1);
    assert.equal(store.listBatches(accountId)[0].status, 'running');
    assert.ok(calls.every(call => call.token === 'current-token'));
    assert.equal(calls.some(call => call.route === mod.LOGIN_ROUTE), false);
  } finally {
    release(); await service.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit platform session replacement is reported as login expiration', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-platform-auth-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/service.cjs'), path.join(directory, 'service.cjs'));
  fs.symlinkSync(workerDirectory, path.join(directory, 'worker'), 'dir');
  try {
    const mod = require(path.join(directory, 'service.cjs'));
    const platform = mod.createPlatform({ fetch: async () => new Response(JSON.stringify({ code: -1, message: '账号在其他设备登录', data: null })) });
    await assert.rejects(platform({ route: mod.TRAINING_ROUTE, body: {}, token: 'token' }), error => error.code === 'PLATFORM_AUTH_EXPIRED');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('mixed PDF and video leaves require matching identities and explicit unstarted evidence', { skip: !fs.existsSync(workerDirectory) }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-learning-evidence-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/service.cjs'), path.join(directory, 'service.cjs'));
  fs.symlinkSync(workerDirectory, path.join(directory, 'worker'), 'dir');
  try {
    const { learningEvidence } = require(path.join(directory, 'service.cjs'));
    const leaves = ['PDF', 'VIDEO'].map((type, index) => ({ id: String(index), activityId: 'inner',
      activityEnrollmentId: 'enrollment', type, completionStatusPresent: true, completionStatusIsNull: true }));
    const input = { catalogComplete: true, catalog: { catalogRows: leaves, courseDetails: [
      { activityId: 'inner', activityEnrollmentId: 'enrollment', studyStatus: 'NOTATTEMPT' }
    ] }, exams: { ok: true, records: [] }, resources: leaves.map(row => ({ resourceKey: `inner:enrollment:${row.id}` })) };
    assert.deepEqual(learningEvidence(input).resources.map(item => item.learningStatus), ['incomplete', 'incomplete']);
    leaves[1].completionStatusPresent = false;
    assert.deepEqual(learningEvidence(input).resources.map(item => item.learningStatus), ['unknown', 'unknown']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manual existing learning starts only verified courses when another course fails', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-learning-manual-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/service.cjs'), path.join(directory, 'service.cjs'));
  fs.symlinkSync(workerDirectory, path.join(directory, 'worker'), 'dir');
  const mod = require(path.join(directory, 'service.cjs'));
  const cw = require(path.join(workerDirectory, 'learning-courseware.js'));
  const store = mod.openStore(path.join(directory, 'data'));
  const timestamp = Date.now();
  const accountId = store.saveAccount({ orgCode: 'ZGXY', username: 'test', password: 'password', token: 'token', userId: 'user', allowVideo: true }, timestamp);
  const cookie = 'A'.repeat(43);
  store.createSession(cookie, accountId, timestamp);
  const submitted = [];
  const jobs = new Map();
  const worker = { ready: Promise.resolve(), close: async () => {}, getFilteredJob: async id => jobs.get(id) || null,
    getActiveJob: async () => null, enqueueFiltered: async input => {
      submitted.push(input);
      const job = { id: 'job', status: 'pending', phase: 'queued', total: 1, completed: 0 };
      jobs.set(input.requestId, job);
      return job;
    } };
  const platform = async ({ route, body }) => {
    if (route === mod.LOGIN_ROUTE) return { code: 200, data: { token: 'token', user: { id: 'user' } } };
    if (route === mod.TRAINING_ROUTE) return { code: 200, data: { content: { records: [{ id: 'good' }, { id: 'bad' }], current: 1, pages: 1 } } };
    if (route === cw.ROUTES.trainingDetail) return body.id === 'bad' ? { code: 500 } : { code: 200, data: { id: 'good', activityEnrollmentId: 'enrollment', studyStatus: 'PROGRESS', onlineInd: true, examInd: false } };
    if (route === cw.ROUTES.trainingContentList) return { code: 200, data: { content: [{ id: 'file', type: 'PDF', files: { url: '/file.pdf' }, completionStatus: 'NOTATTEMPT' }], totalPages: 1, last: true } };
    if (route === mod.TRAINING_EXAM_ROUTE) return { code: 200, data: { content: [], number: 0, totalPages: 0, last: true } };
    throw new Error(`unexpected route ${route}`);
  };
  const service = mod.createService({ store, worker, platform, now: () => timestamp, wait: async () => {}, origin: 'https://learn.ciphera.top', scheduleEnabled: false });
  try {
    const address = await service.listen(0);
    const response = await fetch(`http://127.0.0.1:${address.port}/zg/api/learn-existing`, { method: 'POST', headers: {
      Origin: 'https://learn.ciphera.top', 'Content-Type': 'application/json', Cookie: `zg_session=${cookie}` }, body: '{}' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.partial, true);
    assert.equal(data.scheduledCount, 1);
    assert.deepEqual(submitted[0].resourceKeys, ['good:enrollment:file']);
    assert.equal(store.hasInitialBaseline(accountId), false);
  } finally {
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const scenario of ['existing-baseline', 'initial-snapshot', 'partial-initial']) {
  test(`partial scan schedules only freshly verified new resources (${scenario})`, { skip: !fs.existsSync(workerDirectory) }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-learning-partial-'));
    fs.copyFileSync(path.resolve(__dirname, '../../bridge/service.cjs'), path.join(directory, 'service.cjs'));
    fs.symlinkSync(workerDirectory, path.join(directory, 'worker'), 'dir');
    const serviceModule = require(path.join(directory, 'service.cjs'));
    const courseware = require(path.join(workerDirectory, 'learning-courseware.js'));
    const store = serviceModule.openStore(path.join(directory, 'data'));
    const timestamp = Date.parse('2026-11-04T09:30:01+08:00');
    const accountId = store.saveAccount({ orgCode: 'ZGXY', username: 'test', password: 'password', token: 'token', userId: 'user', allowVideo: true }, timestamp - 60000);
    if (scenario === 'existing-baseline') store.markInitialBaseline(accountId, timestamp - 50000);
    const addBaseline = (activityId, enrollmentId) => {
      const scopeHash = store.scopeHash(accountId, activityId, enrollmentId);
      store.setBaseline({ scopeHash, accountId, activityId, enrollmentId, title: activityId, status: 'complete', learningStatus: 'unknown', examStatus: 'none', hasExamContent: false, completedAt: timestamp - 30000, updatedAt: timestamp - 30000 });
      return scopeHash;
    };
    if (scenario !== 'initial-snapshot') addBaseline('good', 'good-enrollment');
    const badScope = addBaseline('bad', 'bad-enrollment');
    const staleScope = addBaseline('stale', 'stale-enrollment');
    for (const [activityId, enrollmentId, scopeHash] of [['bad', 'bad-enrollment', badScope], ['stale', 'stale-enrollment', staleScope]]) {
      store.upsertDiscoveredResource({ accountId, scopeHash, activityId, enrollmentId, resourceId: 'old-new', resourceKey: `${activityId}:${enrollmentId}:old-new`, type: 'PDF', title: '课件', trainingTitle: activityId, isBaseline: false, updatedAt: timestamp - 1000 });
    }
    const jobs = new Map(), submitted = [];
    const worker = {
      ready: Promise.resolve(), close: async () => {}, getFilteredJob: async id => jobs.get(id) || null,
      getActiveJob: async () => null,
      enqueueFiltered: async input => {
        submitted.push(input);
        const job = { id: `job-${submitted.length}`, status: 'pending', phase: 'queued', total: input.resourceKeys.length, completed: 0 };
        jobs.set(input.requestId, job);
        return job;
      }
    };
    let goodCatalogCalls = 0, badDetailCalls = 0;
    const platform = async ({ route, body }) => {
      if (route === serviceModule.LOGIN_ROUTE) return { code: 200, data: { token: 'token', user: { id: 'user' } } };
      if (route === serviceModule.TRAINING_ROUTE) return { code: 200, data: { content: { records: [{ id: 'good', title: 'good' }, { id: 'bad', title: 'bad' }], current: 1, pages: 1 } } };
      if (route === courseware.ROUTES.trainingDetail) {
        if (body.id === 'bad') { badDetailCalls++; return { code: 500 }; }
        if (body.id === 'stale') return { code: 200, data: { id: 'stale', activityEnrollmentId: 'stale-enrollment', studyStatus: 'COMPLETED' } };
        return { code: 200, data: { id: 'good', activityEnrollmentId: 'good-enrollment', studyStatus: 'PROGRESS', onlineInd: true, examInd: false } };
      }
      if (route === courseware.ROUTES.trainingContentList) {
        goodCatalogCalls++;
        if (goodCatalogCalls === 1) return { code: 500 };
        return { code: 200, data: { content: [{ id: 'good-new', activityId: 'good', activityEnrollmentId: 'good-enrollment', type: 'PDF', files: { url: '/test.pdf' }, completionStatus: 'NOTATTEMPT' }], totalPages: 1, last: true } };
      }
      if (route === serviceModule.TRAINING_EXAM_ROUTE) return { code: 200, data: { content: [], number: 0, totalPages: 0, last: true } };
      throw new Error(`unexpected route ${route}`);
    };
    const service = serviceModule.createService({ store, dataDir: path.join(directory, 'data'), worker, platform, now: () => timestamp, wait: async () => {}, origin: 'https://learn.ciphera.top', scheduleEnabled: false });
    try {
      await service.ready;
      await service.tick();
      await service.waitForIdle();
      assert.equal(goodCatalogCalls, 2);
      assert.equal(badDetailCalls, 3);
      assert.equal(store.lastScan(accountId).status, 'action_needed');
      assert.equal(store.lastScan(accountId).errorCode, 'UPSTREAM_UNAVAILABLE');
      const { processed, succeeded, failed, skipped } = store.progress(accountId).scanProgress;
      assert.deepEqual({ processed, succeeded, failed, skipped }, { processed: 2, succeeded: 1, failed: 1, skipped: 0 });
      assert.equal(store.getBaseline(staleScope).learningStatus, 'completed');
      assert.equal(store.getBaseline(staleScope).examStatus, 'none');
      assert.equal(store.getResource(accountId, 'stale:stale-enrollment:old-new').status, 'new');
      assert.equal(store.progress(accountId).waitingCourseware.items.some(item => item.trainingTitle === 'stale'), false);
      if (scenario === 'initial-snapshot') {
        assert.equal(submitted.length, 0);
        assert.equal(store.hasInitialBaseline(accountId), false);
        await service.tick();
        await service.waitForIdle();
        assert.equal(store.scheduledSlot(accountId, '2026-11-04T09:30:00+08:00:retry').status, 'action_needed');
        assert.equal(badDetailCalls, 6);
        await service.tick();
        await service.waitForIdle();
        assert.equal(badDetailCalls, 6);
      } else {
        assert.equal(submitted.length, 1);
        assert.deepEqual(submitted[0].resourceKeys, ['good:good-enrollment:good-new']);
        assert.equal(store.getResource(accountId, 'bad:bad-enrollment:old-new').status, 'new');
        assert.equal(store.getResource(accountId, 'stale:stale-enrollment:old-new').status, 'new');
        if (scenario === 'partial-initial') assert.equal(store.hasInitialBaseline(accountId), false);
      }
    } finally {
      await service.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a single account runs one batch at a time and advances its verified queue', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-learning-queue-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/service.cjs'), path.join(directory, 'service.cjs'));
  fs.symlinkSync(workerDirectory, path.join(directory, 'worker'), 'dir');
  const serviceModule = require(path.join(directory, 'service.cjs'));
  const courseware = require(path.join(workerDirectory, 'learning-courseware.js'));
  const store = serviceModule.openStore(path.join(directory, 'data'));
  const timestamp = Date.parse('2026-11-04T09:30:01+08:00');
  const accountId = store.saveAccount({ orgCode: 'ZGXY', username: 'test', password: 'password', token: 'token', userId: 'user', allowVideo: true }, timestamp - 60000);
  store.markInitialBaseline(accountId, timestamp - 50000);
  for (const activityId of ['good1', 'good2']) {
    const enrollmentId = `${activityId}-enrollment`, scopeHash = store.scopeHash(accountId, activityId, enrollmentId);
    store.setBaseline({ scopeHash, accountId, activityId, enrollmentId, title: activityId, status: 'complete', learningStatus: 'unknown', examStatus: 'none', hasExamContent: false, completedAt: timestamp - 30000, updatedAt: timestamp - 30000 });
  }
  const jobs = new Map(), submitted = [];
  let rechecks = 0;
  const preparationTokens = [];
  const worker = {
    ready: Promise.resolve(), close: async () => {}, getFilteredJob: async id => jobs.get(id) || null, getActiveJob: async () => null,
    recheckUnknown: async input => { rechecks++; return jobs.get(input.requestId); },
    retryPreparation: async input => {
      preparationTokens.push(input.token);
      if (preparationTokens.length === 1) throw Object.assign(new Error('expired'), { code: 'AUTH_EXPIRED' });
      const job = jobs.get(input.requestId);
      Object.assign(job, { status: 'pending', phase: 'queued', errorCode: '' });
      return job;
    },
    enqueueFiltered: async input => {
      submitted.push(input);
      const job = { id: `job-${submitted.length}`, status: 'pending', phase: 'queued', total: 1, completed: 0 };
      jobs.set(input.requestId, job);
      return job;
    }
  };
  const platform = async ({ route, body }) => {
    if (route === serviceModule.LOGIN_ROUTE) return { code: 200, data: { token: 'token', user: { id: 'user' } } };
    if (route === serviceModule.TRAINING_ROUTE) return { code: 200, data: { content: { records: [{ id: 'good1', title: 'good1' }, { id: 'good2', title: 'good2' }, { id: 'bad', title: 'bad' }], current: 1, pages: 1 } } };
    if (route === courseware.ROUTES.trainingDetail) {
      if (body.id === 'bad') return { code: 500 };
      return { code: 200, data: { id: body.id, activityEnrollmentId: `${body.id}-enrollment`, studyStatus: 'PROGRESS', onlineInd: true, examInd: false } };
    }
    if (route === courseware.ROUTES.trainingContentList) {
      const activityId = body.params.activityId;
      return { code: 200, data: { content: [{ id: `${activityId}-new`, activityId, activityEnrollmentId: `${activityId}-enrollment`, type: 'PDF', files: { url: '/test.pdf' }, completionStatus: 'NOTATTEMPT' }], totalPages: 1, last: true } };
    }
    if (route === serviceModule.TRAINING_EXAM_ROUTE) return { code: 200, data: { content: [], number: 0, totalPages: 0, last: true } };
    throw new Error(`unexpected route ${route}`);
  };
  const service = serviceModule.createService({ store, dataDir: path.join(directory, 'data'), worker, platform, now: () => timestamp, wait: async () => {}, origin: 'https://learn.ciphera.top', scheduleEnabled: false });
  try {
    await service.ready;
    await service.tick();
    await service.waitForIdle();
    assert.equal(submitted.length, 1);
    assert.equal(store.listBatches(accountId).filter(batch => batch.status === 'queued').length, 2);
    Object.assign(jobs.get(submitted[0].requestId), { status: 'completed', phase: 'completed', completed: 1, verifiedComplete: true });
    await service.tick();
    await service.waitForIdle();
    assert.equal(submitted.length, 2);
    Object.assign(jobs.get(submitted[1].requestId), { status: 'completed', phase: 'completed', completed: 1, verifiedComplete: true });
    Object.assign(jobs.get(submitted[0].requestId), { status: 'unknown', phase: 'unknown', errorCode: 'COMPLETION_UNVERIFIED', verifiedComplete: false });
    await service.tick();
    await service.waitForIdle();
    assert.equal(rechecks, 1);
    await service.tick();
    await service.waitForIdle();
    assert.equal(rechecks, 1);
    assert.equal(submitted.length, 2);
    assert.notEqual(submitted[0].activityId, submitted[1].activityId);
    await service.tick();
    await service.waitForIdle();
    assert.equal(submitted.length, 2);
    Object.assign(jobs.get(submitted[0].requestId), { status: 'failed', phase: 'failed', errorCode: 'RESOURCE_STATUS_UNVERIFIED', retryable: true, total: 0, completed: 0 });
    await service.tick();
    await service.waitForIdle();
    assert.deepEqual(preparationTokens, ['token', 'token']);
    assert.equal(jobs.get(submitted[0].requestId).status, 'pending');
  } finally {
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
