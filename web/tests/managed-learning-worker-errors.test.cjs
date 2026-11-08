'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workerDirectory = process.env.LEARN_WORKER_DIRECTORY || '/usr/local/lib/zg-managed-learning/worker';

test('mixed unstarted course submits a video and confirms its platform status', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-worker-mixed-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/worker-server.cjs'), path.join(directory, 'server.cjs'));
  fs.symlinkSync(path.join(workerDirectory, 'learning-courseware.js'), path.join(directory, 'learning-courseware.js'));
  const { createWorker } = require(path.join(directory, 'server.cjs'));
  const courseware = require(path.join(workerDirectory, 'learning-courseware.js'));
  const calls = [];
  let completed = false;
  const upstream = async ({ route, body }) => {
    calls.push({ route, body });
    if (route === courseware.ROUTES.trainingDetail) return { code: 200, data: { id: 'outer', activityEnrollmentId: 'outer-enrollment' } };
    if (route === courseware.ROUTES.trainingContentList) return { code: 200, data: { content: [{ id: 'section', resourceId: 'inner', type: 'ONLINE' }], totalPages: 1, last: true } };
    if (route === courseware.ROUTES.courseDetail) return { code: 200, data: { id: 'inner', activityEnrollmentId: 'inner-enrollment', studyStatus: 'NOTATTEMPT' } };
    if (route === courseware.ROUTES.trainingSectionDetail) return { code: 200, data: [
      { id: 'pdf', type: 'PDF', files: { url: '/file.pdf' }, completionStatus: null },
      { id: 'video', type: 'VIDEO', files: { url: '/video.mp4' }, totalTime: '02:30', completionStatus: completed ? 'COMPLETED' : null }
    ] };
    if (route === courseware.ROUTES.videoOpen) return { code: 200, data: { learningToken: 'learning-token' } };
    if (route === courseware.ROUTES.videoSubmit) { completed = true; return { code: 200, data: {} }; }
    throw new Error(`unexpected route ${route}`);
  };
  const worker = createWorker({ dataDir: path.join(directory, 'data'), upstream });
  try {
    await worker.ready;
    const requestId = '33333333-3333-4333-8333-333333333333';
    const created = worker._store.createOrGet('outer', 'outer-enrollment', 'old-token',
      ['inner:inner-enrollment:video'], requestId, true, () => Date.now());
    worker._store.write({ status: 'failed', phase: 'failed', error_code: 'RESOURCE_STATUS_UNVERIFIED',
      total: 0, completed: 0, current_resource_json: null, auth_cipher: null }, created.job.id, () => Date.now());
    await worker.retryPreparation({ requestId, token: 'token' });
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = await worker.getFilteredJob(requestId);
      if (['completed', 'failed', 'unknown'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'completed');
    assert.equal(job.verifiedComplete, true);
    const submit = calls.find(call => call.route === courseware.ROUTES.videoSubmit);
    assert.equal(submit.body.data, 150);
    assert.equal(calls.filter(call => call.route === courseware.ROUTES.videoSubmit).length, 1);
    assert.equal(calls.some(call => call.route === courseware.ROUTES.fileOpen), false);
  } finally {
    await worker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('submit rejection records status only and never logs account data', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-worker-error-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/worker-server.cjs'), path.join(directory, 'server.cjs'));
  fs.symlinkSync(path.join(workerDirectory, 'learning-courseware.js'), path.join(directory, 'learning-courseware.js'));
  const { defaultUpstream } = require(path.join(directory, 'server.cjs'));
  const warnings = [], original = console.warn;
  console.warn = value => warnings.push(value);
  try {
    const upstream = defaultUpstream(async () => new Response(JSON.stringify({ code: 500, message: 'sensitive-user-data' }), { status: 200 }));
    await assert.rejects(upstream({ route: '/gateway/activity/api/activity-resource/submits-resource', body: { id: 'private-resource' }, token: 'private-token' }), /UPSTREAM_REQUEST_FAILED/);
    assert.equal(warnings.length, 1);
    const logged = JSON.parse(warnings[0]);
    assert.equal(logged.httpStatus, 200);
    assert.equal(logged.platformCode, 500);
    assert.ok(!warnings[0].includes('private-token'));
    assert.ok(!warnings[0].includes('private-resource'));
    assert.ok(!warnings[0].includes('sensitive-user-data'));
  } finally {
    console.warn = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('expired platform authentication is distinguished from service errors', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-worker-auth-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/worker-server.cjs'), path.join(directory, 'server.cjs'));
  fs.symlinkSync(path.join(workerDirectory, 'learning-courseware.js'), path.join(directory, 'learning-courseware.js'));
  try {
    const { defaultUpstream } = require(path.join(directory, 'server.cjs'));
    const upstream = defaultUpstream(async () => new Response(JSON.stringify({ code: 401 }), { status: 200 }));
    await assert.rejects(upstream({ route: '/gateway/activity/api/training/detail', body: {}, token: 'expired' }), error => error.code === 'AUTH_EXPIRED');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preparation retry never reopens an uncertain submitted job', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-worker-no-repeat-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/worker-server.cjs'), path.join(directory, 'server.cjs'));
  fs.symlinkSync(path.join(workerDirectory, 'learning-courseware.js'), path.join(directory, 'learning-courseware.js'));
  const { createWorker } = require(path.join(directory, 'server.cjs'));
  let calls = 0;
  const worker = createWorker({ dataDir: path.join(directory, 'data'), upstream: async () => { calls++; throw new Error('unexpected request'); } });
  try {
    await worker.ready;
    const requestId = '44444444-4444-4444-8444-444444444444';
    const created = worker._store.createOrGet('activity', 'enrollment', 'token', ['activity:enrollment:video'], requestId, true, () => Date.now());
    worker._store.write({ status: 'unknown', phase: 'unknown', error_code: 'COMPLETION_UNVERIFIED', total: 1 }, created.job.id, () => Date.now());
    const result = await worker.retryPreparation({ requestId, token: 'token' });
    assert.equal(result.status, 'unknown');
    assert.equal(calls, 0);
  } finally {
    await worker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('uncertain completion is rechecked without reopening or resubmitting', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-worker-recheck-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/worker-server.cjs'), path.join(directory, 'server.cjs'));
  fs.symlinkSync(path.join(workerDirectory, 'learning-courseware.js'), path.join(directory, 'learning-courseware.js'));
  const { createWorker } = require(path.join(directory, 'server.cjs'));
  const courseware = require(path.join(workerDirectory, 'learning-courseware.js'));
  let completionStatus = 'PROGRESS';
  let scopeMatches = true;
  const calls = [];
  const upstream = async ({ route }) => {
    calls.push(route);
    if (route === courseware.ROUTES.trainingDetail) return { code: 200, data: { id: 'activity', activityEnrollmentId: scopeMatches ? 'enrollment' : 'other-enrollment', studyStatus: 'PROGRESS' } };
    if (route === courseware.ROUTES.trainingContentList) return { code: 200, data: { content: [{ id: 'file', activityId: 'activity', activityEnrollmentId: 'enrollment', type: 'PDF', files: { url: '/test.pdf' }, completionStatus }], totalPages: 1, last: true } };
    throw new Error(`unexpected write or route ${route}`);
  };
  const worker = createWorker({ dataDir: path.join(directory, 'data'), upstream });
  try {
    await worker.ready;
    const requestId = '11111111-1111-4111-8111-111111111111';
    const resource = { id: 'file', activityId: 'activity', activityEnrollmentId: 'enrollment', type: 'PDF', title: '课件' };
    const created = worker._store.createOrGet('activity', 'enrollment', 'token', ['activity:enrollment:file'], requestId, false, () => Date.now());
    worker._store.write({ status: 'unknown', phase: 'unknown', error_code: 'COMPLETION_UNVERIFIED', total: 1, current_index: 0,
      plan_json: JSON.stringify([resource]), current_resource_json: JSON.stringify(resource) }, created.job.id, () => Date.now());
    const unresolved = await worker.recheckUnknown({ requestId, token: 'token' });
    assert.equal(unresolved.status, 'unknown');
    assert.equal(unresolved.verifiedComplete, false);
    scopeMatches = false;
    await assert.rejects(worker.recheckUnknown({ requestId, token: 'token' }), /SCOPE_MISMATCH/);
    assert.equal((await worker.getFilteredJob(requestId)).status, 'unknown');
    scopeMatches = true;
    completionStatus = 'COMPLETED';
    const confirmed = await worker.recheckUnknown({ requestId, token: 'token' });
    assert.equal(confirmed.status, 'completed');
    assert.equal(confirmed.completed, 1);
    assert.equal(confirmed.verifiedComplete, true);
    assert.ok(calls.every(route => [courseware.ROUTES.trainingDetail, courseware.ROUTES.trainingContentList].includes(route)));
  } finally {
    await worker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('read-only confirmation resumes only the remaining resource in a batch', { skip: !fs.existsSync(workerDirectory) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-worker-resume-'));
  fs.copyFileSync(path.resolve(__dirname, '../../bridge/worker-server.cjs'), path.join(directory, 'server.cjs'));
  fs.symlinkSync(path.join(workerDirectory, 'learning-courseware.js'), path.join(directory, 'learning-courseware.js'));
  const { createWorker } = require(path.join(directory, 'server.cjs'));
  const courseware = require(path.join(workerDirectory, 'learning-courseware.js'));
  const calls = [];
  const upstream = async ({ route, body }) => {
    calls.push({ route, id: body.id });
    if (route === courseware.ROUTES.trainingDetail) return { code: 200, data: { id: 'activity', activityEnrollmentId: 'enrollment', studyStatus: 'PROGRESS' } };
    if (route === courseware.ROUTES.trainingContentList) return { code: 200, data: { content: ['file1', 'file2'].map((id, index) => ({ id, activityId: 'activity', activityEnrollmentId: 'enrollment', type: 'PDF', files: { url: '/test.pdf' }, completionStatus: index === 0 ? 'COMPLETED' : 'PROGRESS' })), totalPages: 1, last: true } };
    if (route === courseware.ROUTES.fileOpen) return { code: 200, data: { learningToken: 'fresh-token', sumTime: 60 } };
    throw new Error(`unexpected write or route ${route}`);
  };
  const worker = createWorker({ dataDir: path.join(directory, 'data'), upstream });
  try {
    await worker.ready;
    const requestId = '22222222-2222-4222-8222-222222222222';
    const resources = ['file1', 'file2'].map(id => ({ id, activityId: 'activity', activityEnrollmentId: 'enrollment', type: 'PDF', title: '课件' }));
    const created = worker._store.createOrGet('activity', 'enrollment', 'token', resources.map(x => `activity:enrollment:${x.id}`), requestId, false, () => Date.now());
    worker._store.write({ status: 'unknown', phase: 'unknown', error_code: 'COMPLETION_UNVERIFIED', total: 2, current_index: 0,
      plan_json: JSON.stringify(resources), current_resource_json: JSON.stringify(resources[0]) }, created.job.id, () => Date.now());
    await worker.recheckUnknown({ requestId, token: 'token' });
    for (let attempt = 0; attempt < 50 && !(await worker.getFilteredJob(requestId)).remainingSeconds; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const resumed = await worker.getFilteredJob(requestId);
    assert.equal(resumed.phase, 'waiting');
    assert.equal(resumed.completed, 1);
    assert.deepEqual(calls.filter(item => item.route === courseware.ROUTES.fileOpen).map(item => item.id), ['file2']);
    assert.equal(calls.some(item => item.route === courseware.ROUTES.fileSubmit), false);
  } finally {
    await worker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

