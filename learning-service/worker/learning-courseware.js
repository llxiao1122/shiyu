(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZgxyLearningCourseware = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROUTES = Object.freeze({
    courseDetail: '/gateway/activity/api/activity/detail',
    trainingDetail: '/gateway/activity/api/training/detail',
    trainingContentList: '/gateway/activity/api/training/content/list',
    trainingSectionDetail: '/gateway/activity/api/training/section-detail',
    trainingExamContentList: '/gateway/activity/api/training/exam-content-list',
    onlineContentList: '/gateway/activity/api/activity/online-content-list',
    sectionDetail: '/gateway/activity/api/activity/section-detail',
    fileOpen: '/gateway/activity/api/activity-resource/open-resource',
    fileSubmit: '/gateway/activity/api/activity-resource/submits-resource',
    videoOpen: '/gateway/activity/api/learn/attendance/time/open',
    videoSubmit: '/gateway/activity/api/learn/attendance/time/submit'
  });

  const FILE_TYPES = new Set(['PDF', 'OFFICE', 'H5', 'SCORM']);
  const SOURCE_URL = 'https://learning01.zzmetro.cn:30426/gateway/manage';
  const MAX_CATALOG_PAGES = 40;
  const MAX_RESOURCES = 1000;

  function positiveSeconds(value) {
    if (value === null || value === undefined || value === '') return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  function officialVideoDurationSeconds(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{1,3}):([0-5]\d)$/.exec(value);
    if (!match) return null;
    const seconds = Number(match[1]) * 60 + Number(match[2]);
    return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 7200 ? seconds : null;
  }

  function serverSeconds(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    if (value === 0 || (typeof value === 'string' && value.trim() === '0')) return 0;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  function fastForwardAllowed(value) {
    return value === true || value === 1 || ['1', 'true', 'yes', 'y'].includes(String(value).trim().toLowerCase());
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.ceil(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return [hours, minutes, rest].map(part => String(part).padStart(2, '0')).join(':');
  }

  function attachVideoTailJump(video, allowed, isCurrent) {
    let jumped = false;
    const attempt = () => {
      if (jumped || allowed !== true || typeof isCurrent !== 'function' || isCurrent() !== true) return;
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 1) return;
      jumped = true;
      try { video.currentTime = Math.max(0, duration - 1); } catch (_) {}
    };
    video.addEventListener('loadedmetadata', attempt);
    video.addEventListener('durationchange', attempt);
  }

  function normalizeResource(item, scope, sourceUrl = SOURCE_URL, options = {}) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'missing-item' };
    const type = String(item.type || item.resourceType || '').trim().toUpperCase();
    const resourceId = item.id === null || item.id === undefined ? '' : String(item.id);
    const activityId = item.activityId === null || item.activityId === undefined || item.activityId === '' ? scope.activityId : String(item.activityId);
    const enrollmentId = item.activityEnrollmentId === null || item.activityEnrollmentId === undefined || item.activityEnrollmentId === '' ? scope.activityEnrollmentId : String(item.activityEnrollmentId);
    if (!resourceId || !activityId || !enrollmentId) return { ok: false, reason: 'identity-mismatch' };
    if (Array.isArray(scope.resourceIdentityKeys) && !scope.resourceIdentityKeys.includes(activityId + ':' + enrollmentId)) return { ok: false, reason: 'identity-mismatch' };

    const kind = type === 'VIDEO' ? 'video' : type === 'IMAGE' ? 'image' : FILE_TYPES.has(type) ? 'file' : '';
    if (!kind) return { ok: false, reason: 'unsupported-type' };
    const fileUrl = item.files && typeof item.files.url === 'string' ? item.files.url : '';
    const fileMediaUrl = fileUrl ? (/^https:\/\//i.test(fileUrl) ? fileUrl : sourceUrl + fileUrl) : '';
    const rawUrl = item.mediaUrl || (kind === 'video' ? (item.videoSrc || fileMediaUrl) : fileMediaUrl);
    const completedMetadata = options.allowCompletedWithoutUrl === true &&
      String(item.completionStatus || '').trim().toUpperCase() === 'COMPLETED';
    if ((typeof rawUrl !== 'string' || !rawUrl) && !completedMetadata) return { ok: false, reason: 'missing-url' };

    let mediaUrl = '';
    try {
      if (typeof rawUrl === 'string' && rawUrl) {
      const parsed = new URL(rawUrl, sourceUrl);
      const trusted = new URL(sourceUrl);
      if (parsed.protocol === 'http:') return { ok: false, reason: 'insecure-url' };
      if (parsed.protocol !== 'https:') return { ok: false, reason: 'invalid-url' };
      if (parsed.origin !== trusted.origin) return { ok: false, reason: 'untrusted-media-host' };
      mediaUrl = parsed.href;
      }
    } catch (_) {
      return { ok: false, reason: 'invalid-url' };
    }

    const resource = {
      id: resourceId,
      activityId,
      activityEnrollmentId: enrollmentId,
      type,
      kind,
      title: String(item.resourceTitle || item.title || item.name || '学习课件'),
      mediaUrl,
      fastForwardAllowed: false
    };
    if (type === 'VIDEO') {
      const duration = officialVideoDurationSeconds(item.totalTime);
      if (duration !== null) resource.officialDurationSeconds = duration;
    }

    return {
      ok: true,
      resource
    };
  }

  function apiData(response, label) {
    if (!response || Number(response.code) !== 200) throw new Error(label + '-request-failed');
    return response.data;
  }

  function identityFieldMismatch(value, expected) {
    return value !== undefined && value !== null && value !== '' && String(value) !== String(expected);
  }

  function refreshOpenedResource(resource, opened, scope, sourceUrl) {
    if (opened === undefined || opened === null) return { ok: true, resource };
    if (typeof opened !== 'object' || Array.isArray(opened)) return { ok: false, reason: 'opened-resource-invalid' };
    if (identityFieldMismatch(opened.id, resource.id) || identityFieldMismatch(opened.activityId, resource.activityId) || identityFieldMismatch(opened.activityEnrollmentId, resource.activityEnrollmentId)) {
      return { ok: false, reason: 'opened-resource-identity-mismatch' };
    }
    const freshMediaUrl = typeof opened.mediaUrl === 'string' && opened.mediaUrl.trim() ? opened.mediaUrl : '';
    const freshVideoSrc = typeof opened.videoSrc === 'string' && opened.videoSrc.trim() ? opened.videoSrc : '';
    const freshFileUrl = typeof opened.files?.url === 'string' && opened.files.url.trim() ? opened.files.url : '';
    if (!freshMediaUrl && !freshVideoSrc && !freshFileUrl) return { ok: true, resource };
    const candidate = {
      ...opened,
      id: resource.id,
      activityId: resource.activityId,
      activityEnrollmentId: resource.activityEnrollmentId,
      type: resource.type,
      title: opened.resourceTitle || opened.title || resource.title,
      mediaUrl: freshMediaUrl
    };
    const normalized = normalizeResource(candidate, scope, sourceUrl);
    if (!normalized.ok) return { ok: false, reason: 'opened-resource-' + normalized.reason };
    return { ok: true, resource: normalized.resource };
  }

  async function discoverCourseware(options = {}) {
    const { postJson, isCurrent, scope, sessionSnapshot } = options;
    if (typeof postJson !== 'function' || typeof isCurrent !== 'function' || !scope?.activityId || !scope?.activityEnrollmentId) {
      return { ok: false, reason: 'missing-scope' };
    }
    const current = () => isCurrent(scope, sessionSnapshot) === true;
    const read = async (route, body, label) => {
      if (!current()) throw new Error('scope-changed');
      const response = await postJson(route, body, sessionSnapshot);
      if (!current()) throw new Error('scope-changed');
      return apiData(response, label);
    };
    const resources = [];
    const unsupported = [];
    const unavailableRows = [];
    const catalogRows = [];
    const courseDetails = [];
    const unavailableKeys = new Set();
    const catalogRowKeys = new Set();
    const courseDetailKeys = new Set();
    const resourceSignatures = new Map();
    const visitedActivities = new Set();
    const visitedSections = new Set();
    let detail = null;
    let rootLast = null;
    let pages = null;
    try {
      const rootScope = { activityId: String(scope.activityId), activityEnrollmentId: String(scope.activityEnrollmentId) };
      const recordUnavailable = (item, activityScope, reason, type = '') => {
        const entry = {
          title: String(item?.resourceTitle || item?.title || item?.name || '未命名在线课程'),
          activityId: String(activityScope?.activityId ?? item?.resourceId ?? item?.activityId ?? ''),
          sectionId: String(item?.sectionId ?? item?.id ?? ''),
          type: String(type || item?.type || item?.resourceType || '').trim().toUpperCase(),
          reason
        };
        const key = JSON.stringify(entry);
        if (!unavailableKeys.has(key)) {
          unavailableKeys.add(key);
          unavailableRows.push(entry);
        }
        return entry;
      };
      const safeFlag = value => {
        if (typeof value === 'boolean' || typeof value === 'number') return value;
        if (typeof value === 'string' && value.length <= 40) return value;
        return value === null || value === undefined ? null : 'UNKNOWN';
      };
      const recordCatalogRow = (item, activityScope) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        const row = {
          id: String(item.id ?? item.resourceId ?? item.sectionId ?? ''),
          activityId: String(item.activityId ?? activityScope?.activityId ?? ''),
          activityEnrollmentId: String(item.activityEnrollmentId ?? activityScope?.activityEnrollmentId ?? ''),
          type: String(item.type || item.resourceType || '').trim().toUpperCase(),
          resourceType: String(item.resourceType || '').trim().toUpperCase(),
          title: String(item.resourceTitle || item.title || item.name || ''),
          completionStatus: String(item.completionStatus || '').trim().toUpperCase(),
          completionStatusPresent: Object.prototype.hasOwnProperty.call(item, 'completionStatus'),
          completionStatusIsNull: Object.prototype.hasOwnProperty.call(item, 'completionStatus') && item.completionStatus === null,
          studyStatus: String(item.studyStatus || '').trim().toUpperCase(),
          signStatus: String(item.signStatus || '').trim().toUpperCase(),
          scoreStatus: String(item.scoreStatus || item.recordScoreStatus || '').trim().toUpperCase(),
          status: String(item.status || '').trim().toUpperCase(),
          flags: {}
        };
        for (const key of ['required', 'requiredInd', 'mustStudyInd', 'compulsoryInd', 'signInd', 'signOutInd', 'scoreInd', 'examInd', 'onlineInd', 'fileInd', 'operExamInd', 'faceTrainInd', 'liveInd', 'classesInd', 'enabledclasses', 'enabledClasses']) {
          if (Object.prototype.hasOwnProperty.call(item, key)) row.flags[key] = safeFlag(item[key]);
        }
        for (const key of ['score', 'passPercentage', 'totalTime', 'resourceTime', 'startDatetime', 'endDatetime']) {
          if (Object.prototype.hasOwnProperty.call(item, key)) row[key] = safeFlag(item[key]);
        }
        const signature = JSON.stringify(row);
        if (!catalogRowKeys.has(signature)) {
          catalogRowKeys.add(signature);
          catalogRows.push(row);
        }
      };
      const recordCourseDetail = (course, activityId, enrollmentId) => {
        const detail = {
          activityId: String(course?.id ?? course?.activityId ?? activityId),
          activityEnrollmentId: String(course?.activityEnrollmentId ?? enrollmentId),
          title: String(course?.title || course?.name || ''),
          type: String(course?.type || course?.activityType || '').trim().toUpperCase(),
          studyStatus: String(course?.studyStatus || '').trim().toUpperCase(),
          doneNum: String(course?.doneNum ?? ''),
          flags: {}
        };
        for (const key of ['onlineInd', 'examInd', 'operExamInd', 'fileInd', 'faceTrainInd', 'liveInd', 'classesInd', 'enabledclasses', 'enabledClasses']) {
          if (Object.prototype.hasOwnProperty.call(course || {}, key)) detail.flags[key] = safeFlag(course[key]);
        }
        for (const key of ['resourceNumber', 'resourceTime', 'totalTime', 'startDatetime', 'endDatetime']) {
          if (Object.prototype.hasOwnProperty.call(course || {}, key)) detail[key] = safeFlag(course[key]);
        }
        const signature = JSON.stringify(detail);
        if (!courseDetailKeys.has(signature)) {
          courseDetailKeys.add(signature);
          courseDetails.push(detail);
        }
      };
      const appendResource = (item, activityScope, sourceRow = item) => {
        const normalized = normalizeResource(item, activityScope, options.sourceUrl || SOURCE_URL, { allowCompletedWithoutUrl: options.allowCompletedWithoutUrl === true });
        if (!normalized.ok) {
          const issue = recordUnavailable(sourceRow, activityScope, normalized.reason, String(item?.type || item?.resourceType || '').trim().toUpperCase() || 'UNKNOWN');
          unsupported.push(issue);
          return false;
        }
        const resource = normalized.resource;
        const key = [resource.activityId, resource.activityEnrollmentId, resource.id].join(':');
        const signature = JSON.stringify([resource.type, resource.mediaUrl, resource.officialDurationSeconds ?? null]);
        if (resourceSignatures.has(key)) {
          if (resourceSignatures.get(key) !== signature) throw new Error('duplicate-resource-conflict');
          return true;
        }
        resourceSignatures.set(key, signature);
        resources.push(resource);
        return true;
      };
      const expandCourseRows = async (rows, activityScope, depth = 0) => {
        if (!Array.isArray(rows)) throw new Error('catalog-records-invalid');
        if (depth > 4) throw new Error('catalog-nesting-too-deep');
        let provided = false;
        for (const row of rows) {
          if (!current()) throw new Error('scope-changed');
          if (identityFieldMismatch(row?.activityId, activityScope.activityId) || identityFieldMismatch(row?.activityEnrollmentId, activityScope.activityEnrollmentId)) throw new Error('catalog-identity-mismatch');
          const type = String(row?.type || row?.resourceType || '').trim().toUpperCase();
          recordCatalogRow(row, activityScope);
          if (type === 'ONLINE') {
            const embedded = [row?.resources, row?.resourceList].find(value => Array.isArray(value) && value.length);
            if (embedded) {
              provided = await expandCourseRows(embedded, activityScope, depth + 1) || provided;
            } else if (row?.resourceId !== undefined && row?.resourceId !== null && String(row.resourceId) !== activityScope.activityId) {
              if (!visitedActivities.has(String(row.resourceId))) {
                provided = await expandCourseActivity(await loadCourseActivity(String(row.resourceId), row, depth + 1)) || provided;
              }
            } else {
              const sectionId = row?.sectionId ?? row?.id;
              if (sectionId === undefined || sectionId === null || String(sectionId) === '') throw new Error('section-id-missing');
              const key = activityScope.activityId + ':' + String(sectionId);
              if (visitedSections.has(key)) throw new Error('duplicate-section');
              visitedSections.add(key);
              const children = await read(ROUTES.sectionDetail, { activityId: activityScope.activityId, sectionId: String(sectionId) }, 'section-detail');
              if (!Array.isArray(children)) throw new Error('section-detail-invalid');
              if (!children.length) unsupported.push({ reason: 'online-section-empty', type });
              else provided = await expandCourseRows(children, activityScope, depth + 1) || provided;
            }
          } else {
            provided = appendResource(row, activityScope, row) || provided;
          }
          if (resources.length + unavailableRows.length > MAX_RESOURCES) throw new Error('catalog-too-large');
        }
        return provided;
      };
      const loadCourseActivity = async (activityId, sourceRow, depth = 0) => {
        if (depth > 4) throw new Error('catalog-nesting-too-deep');
        const key = String(activityId);
        if (visitedActivities.has(key)) throw new Error('duplicate-activity');
        visitedActivities.add(key);
        const raw = await read(ROUTES.courseDetail, { id: key }, 'course-detail');
        const course = raw?.detail || raw;
        if (!course || typeof course !== 'object' || Array.isArray(course)) throw new Error('course-detail-invalid');
        if (identityFieldMismatch(course.id ?? course.activityId, key)) throw new Error('course-detail-identity-mismatch');
        const enrollment = course.activityEnrollmentId;
        if (enrollment === undefined || enrollment === null || String(enrollment) === '') throw new Error('course-enrollment-missing');
        if (String(sourceRow?.activityId ?? '') === key && identityFieldMismatch(sourceRow?.activityEnrollmentId, enrollment)) throw new Error('catalog-identity-mismatch');
        const activityScope = { activityId: key, activityEnrollmentId: String(enrollment) };
        recordCourseDetail(course, key, String(enrollment));
        if (!detail) detail = course;
        return { course, activityScope, depth };
      };
      const expandCourseActivity = async loaded => {
        const { course, activityScope, depth } = loaded;
        let provided = false;
        if (Array.isArray(course.resources) && course.resources.length) provided = await expandCourseRows(course.resources, activityScope, depth + 1) || provided;
        if (Array.isArray(course.resourceList) && course.resourceList.length) provided = await expandCourseRows(course.resourceList, activityScope, depth + 1) || provided;
        let pages = null;
        for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
          const data = await read(ROUTES.onlineContentList, { page, limit: 50, params: { activityId: activityScope.activityId } }, 'course-catalog');
          if (!Array.isArray(data?.records)) throw new Error('catalog-records-invalid');
          pages = Number(data?.pages);
          if (!Number.isInteger(pages) || pages < 0 || pages > MAX_CATALOG_PAGES) throw new Error('catalog-pages-invalid');
          if (pages === 0 && data.records.length !== 0) throw new Error('catalog-pages-inconsistent');
          provided = await expandCourseRows(data.records, activityScope, depth + 1) || provided;
          if (pages === 0 || page >= pages) break;
          if (page === MAX_CATALOG_PAGES) throw new Error('catalog-too-large');
        }
        return provided;
      };
      const expandTrainingRows = async (rows, depth = 0) => {
        if (!Array.isArray(rows)) throw new Error('training-content-invalid');
        if (depth > 4) throw new Error('catalog-nesting-too-deep');
        for (const row of rows) {
          if (!current()) throw new Error('scope-changed');
          if (identityFieldMismatch(row?.activityId, rootScope.activityId) || identityFieldMismatch(row?.activityEnrollmentId, rootScope.activityEnrollmentId)) throw new Error('catalog-identity-mismatch');
          const type = String(row?.type || row?.resourceType || '').trim().toUpperCase();
          recordCatalogRow(row, rootScope);
          if (type === 'ONLINE') {
            const sectionId = row?.sectionId ?? row?.id;
            const innerId = row?.resourceId === undefined || row?.resourceId === null ? '' : String(row.resourceId);
            if (!innerId || sectionId === undefined || sectionId === null || String(sectionId) === '') {
              unsupported.push({ reason: 'online-section-id-missing', type });
              continue;
            }
            const loaded = await loadCourseActivity(innerId, row, depth + 1);
            const sectionKey = loaded.activityScope.activityId + ':' + String(sectionId);
            if (visitedSections.has(sectionKey)) throw new Error('duplicate-section');
            visitedSections.add(sectionKey);
            const children = await read(ROUTES.trainingSectionDetail, {
              activityId: loaded.activityScope.activityId,
              sectionId: String(sectionId)
            }, 'training-section-detail');
            if (!Array.isArray(children)) throw new Error('training-section-detail-invalid');
            const sectionProvided = children.length ? await expandCourseRows(children, loaded.activityScope, depth + 1) : false;
            let fallbackProvided = sectionProvided;
            if (!fallbackProvided) {
              const activityChildren = await read(ROUTES.sectionDetail, {
                activityId: loaded.activityScope.activityId,
                sectionId: String(sectionId)
              }, 'section-detail');
              if (!Array.isArray(activityChildren)) throw new Error('section-detail-invalid');
              fallbackProvided = activityChildren.length ? await expandCourseRows(activityChildren, loaded.activityScope, depth + 1) : false;
            }
            if (!fallbackProvided) fallbackProvided = await expandCourseActivity(loaded);
            if (!fallbackProvided) recordUnavailable(row, loaded.activityScope, 'courseware-not-returned', type);
          } else {
            appendResource(row, rootScope, row);
          }
          if (resources.length + unavailableRows.length > MAX_RESOURCES) throw new Error('catalog-too-large');
        }
      };

      for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
        const data = await read(ROUTES.trainingContentList, {
          page, limit: 1000, params: { activityId: rootScope.activityId, type: 'ONLINE', parentId: '0' }
        }, 'training-content');
        if (!Array.isArray(data?.content)) throw new Error('training-content-invalid');
        pages = Number(data?.totalPages);
        const last = data?.last;
        if (!Number.isInteger(pages) || pages < 0 || pages > MAX_CATALOG_PAGES || typeof last !== 'boolean') throw new Error('training-content-pages-invalid');
        if ((pages === 0 && (data.content.length !== 0 || last !== true)) ||
            (pages > 0 && last !== (page >= pages))) throw new Error('training-content-pages-inconsistent');
        rootLast = last;
        await expandTrainingRows(data.content);
        if (last || pages === 0 || page >= pages) break;
        if (page === MAX_CATALOG_PAGES) throw new Error('catalog-too-large');
      }
      if (!current()) throw new Error('scope-changed');
      if (!resources.length) return { ok: false, reason: unsupported.length ? 'unsupported-resources' : 'no-resources', resources, unsupported, unavailableRows, detail, rootLast, pages, catalogRows, courseDetails };
      const resourceIdentityKeys = [...new Set(resources.map(resource => String(resource.activityId) + ':' + String(resource.activityEnrollmentId)))];
      return { ok: true, resources, unsupported, unavailableRows, partial: unavailableRows.length > 0, detail, pages, rootLast, resourceIdentityKeys, catalogRows, courseDetails };
    } catch (error) {
      return { ok: false, reason: String(error?.message || 'catalog-read-failed'), resources, unsupported, unavailableRows, detail, rootLast, pages, catalogRows, courseDetails };
    }
  }

  async function verifyCoursewareCompletion(options = {}) {
    const { postJson, isCurrent, resources, sessionSnapshot } = options;
    if (typeof postJson !== 'function' || typeof isCurrent !== 'function' || !Array.isArray(resources) || !resources.length) {
      return { ok: false, reason: 'missing-scope-or-resources' };
    }
    const activities = new Map();
    for (const resource of resources) {
      const activityId = String(resource?.activityId ?? '');
      const enrollmentId = String(resource?.activityEnrollmentId ?? '');
      if (!activityId || !enrollmentId) return { ok: false, reason: 'identity-mismatch' };
      if (activities.has(activityId) && activities.get(activityId) !== enrollmentId) return { ok: false, reason: 'identity-mismatch' };
      activities.set(activityId, enrollmentId);
    }
    const current = () => isCurrent() === true;
    const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (const delayMs of [1000, 2000, 4000]) {
      if (!current()) return { ok: false, reason: 'stale-scope' };
      await wait(delayMs);
      if (!current()) return { ok: false, reason: 'stale-scope' };
      let allComplete = true;
      for (const [activityId, enrollmentId] of activities) {
        let response;
        try {
          response = await postJson(ROUTES.courseDetail, { id: activityId }, sessionSnapshot);
        } catch (_) {
          return { ok: false, reason: current() ? 'read-failed' : 'stale-scope' };
        }
        if (!current()) return { ok: false, reason: 'stale-scope' };
        let course;
        try {
          const data = apiData(response, 'course-detail');
          course = data?.detail || data;
        } catch (_) {
          return { ok: false, reason: 'read-failed' };
        }
        const returnedActivityId = course?.id ?? course?.activityId;
        if (returnedActivityId === undefined || returnedActivityId === null || String(returnedActivityId) !== activityId ||
            course?.activityEnrollmentId === undefined || course?.activityEnrollmentId === null || String(course.activityEnrollmentId) !== enrollmentId) {
          return { ok: false, reason: 'identity-mismatch' };
        }
        if (String(course.studyStatus ?? '').trim().toUpperCase() !== 'COMPLETED') allComplete = false;
      }
      if (allComplete) return { ok: true, complete: true, activityCount: activities.size };
    }
    return { ok: true, complete: false, activityCount: activities.size };
  }

  function createManager(options = {}) {
    if (typeof options.postJson !== 'function' || typeof options.isCurrent !== 'function') {
      throw new TypeError('postJson and isCurrent are required');
    }
    const now = options.now || (() => Date.now());
    const setIntervalFn = options.setInterval || setInterval;
    const clearIntervalFn = options.clearInterval || clearInterval;
    const onState = typeof options.onState === 'function' ? options.onState : () => {};
    let generation = 0;
    let runtime = null;
    let timer = null;
    let cancelWait = null;

    function emit(phase, values = {}) {
      if (!runtime) return;
      runtime.phase = phase;
      onState({ phase, index: runtime.index, total: runtime.resources.length, ...values });
    }

    function isCurrent(run) {
      return !!run && runtime === run && run.generation === generation && !run.stopped && options.isCurrent(run.scope, run.sessionSnapshot) === true;
    }

    function stopTimer() {
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
      if (cancelWait) cancelWait();
      cancelWait = null;
    }

    function clearTimerOnly() {
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
    }

    function stop(reason = 'left-page') {
      generation += 1;
      stopTimer();
      if (runtime && !['complete', 'error', 'unknown'].includes(runtime.phase)) {
        runtime.stopped = true;
        emit('stopped', { reason });
      }
      if (runtime?.itemState) runtime.itemState.learningToken = '';
      if (runtime) runtime.sessionSnapshot = null;
      return snapshot();
    }

    function snapshot() {
      if (!runtime) return { phase: 'idle', index: 0, total: 0 };
      return { phase: runtime.phase, index: runtime.index, total: runtime.resources.length, submittedCount: runtime.submittedCount || 0 };
    }

    async function post(run, path, body) {
      if (!isCurrent(run)) throw new Error('学习页面已离开');
      const response = await options.postJson(path, body, run.sessionSnapshot);
      if (!isCurrent(run)) throw new Error('学习页面已离开');
      if (!response || Number(response.code) !== 200) throw new Error('学习服务未确认本次操作');
      return response.data;
    }

    async function waitFile(run, resource, seconds) {
      const deadline = now() + seconds * 1000;
      return new Promise(resolve => {
        const tick = () => {
          if (!isCurrent(run)) {
            stop('identity-changed');
            return;
          }
          const remaining = Math.max(0, Math.ceil((deadline - now()) / 1000));
          emit('file-countdown', { resource, secondsRemaining: remaining, totalSeconds: seconds });
          if (remaining <= 0) {
            clearTimerOnly();
            cancelWait = null;
            resolve(true);
          }
        };
        cancelWait = () => resolve(false);
        tick();
        if (isCurrent(run) && now() < deadline) timer = setIntervalFn(tick, 250);
      });
    }

    async function submitFile(run, resource, learningToken) {
      if (!isCurrent(run)) return false;
      const itemState = run.itemState;
      if (itemState.submitSent) return false;
      itemState.submitSent = true;
      emit('submitting-file', { resource });
      try {
        await post(run, ROUTES.fileSubmit, {
          mode: 'LEARN', id: resource.id, activityId: resource.activityId,
          activityEnrollmentId: resource.activityEnrollmentId, learningToken
        });
        run.submittedCount += 1;
        itemState.learningToken = '';
        return true;
      } catch (_) {
        itemState.learningToken = '';
        if (isCurrent(run)) emit('unknown', { resource, reason: 'file-submit-unconfirmed' });
        return false;
      }
    }

    async function startNext(run) {
      if (!isCurrent(run)) return;
      if (run.index >= run.resources.length) {
        if (run.itemState) run.itemState.learningToken = '';
        run.sessionSnapshot = null;
        emit('complete');
        return;
      }
      let resource = run.resources[run.index];
      run.itemState = { openSent: false, submitSent: false, videoSubmitting: false, content: 0, duration: null, imageLoaded: false };
      if (!options.isCurrent(run.scope, run.sessionSnapshot)) {
        stop('identity-changed');
        return;
      }
      const openPath = resource.kind === 'video' ? ROUTES.videoOpen : ROUTES.fileOpen;
      const payload = { mode: 'LEARN', id: resource.id, activityId: resource.activityId, activityEnrollmentId: resource.activityEnrollmentId };
      run.itemState.openSent = true;
      emit('opening', { resource });
      let data;
      try {
        data = await post(run, openPath, payload);
      } catch (_) {
        if (isCurrent(run)) emit('unknown', { resource, reason: 'open-unconfirmed' });
        return;
      }
      const openedResource = refreshOpenedResource(resource, data?.resource, run.scope, options.sourceUrl || SOURCE_URL);
      if (!openedResource.ok) {
        emit('error', { resource, reason: openedResource.reason });
        return;
      }
      if (openedResource.resource !== resource) {
        resource = openedResource.resource;
        run.resources[run.index] = resource;
      }
      if (resource.kind === 'image') {
        run.itemState.learningToken = '';
        emit('image-ready', { resource, mediaUrl: resource.mediaUrl });
        return;
      }
      const learningToken = typeof data?.learningToken === 'string' ? data.learningToken : '';
      if (!learningToken) {
        run.itemState.learningToken = '';
        emit('error', { resource, reason: 'learning-token-missing' });
        return;
      }
      run.itemState.learningToken = learningToken;

      if (resource.kind === 'file') {
        const seconds = serverSeconds(data?.sumTime);
        if (seconds === null) {
          run.itemState.learningToken = '';
          emit('error', { resource, reason: 'server-duration-missing' });
          return;
        }
        run.itemState.fileTotalSeconds = seconds;
        emit('file-loading', { resource, mediaUrl: resource.mediaUrl, totalSeconds: seconds });
        return;
      }

      const allowed = fastForwardAllowed(data?.resource?.fastForwardInd);
      run.itemState.fastForwardAllowed = allowed;
      run.itemState.content = 0;
      emit('video-ready', { resource, mediaUrl: resource.mediaUrl, fastForwardAllowed: allowed, playbackRate: 1 });
    }

    async function submitVideo(run, duration) {
      if (!isCurrent(run) || !run.itemState || run.itemState.videoSubmitting || run.itemState.submitSent) return false;
      const resource = run.resources[run.index];
      if (!Number.isFinite(duration) || duration <= 0) {
        emit('error', { resource, reason: 'video-duration-missing' });
        return false;
      }
      run.itemState.videoSubmitting = true;
      run.itemState.submitSent = true;
      run.itemState.content = duration;
      run.itemState.duration = duration;
      emit('submitting-video', { resource });
      try {
        await post(run, ROUTES.videoSubmit, {
          mode: 'LEARN', id: resource.id, activityId: resource.activityId,
          activityEnrollmentId: resource.activityEnrollmentId, learningToken: run.itemState.learningToken,
          data: duration
        });
        if (!isCurrent(run)) return false;
        run.submittedCount += 1;
        run.itemState.learningToken = '';
        run.index += 1;
        await startNext(run);
        return true;
      } catch (_) {
        if (run.itemState) run.itemState.learningToken = '';
        if (isCurrent(run)) emit('unknown', { resource, reason: 'video-submit-unconfirmed' });
        return false;
      }
    }

    async function completeFileOnly() {
      const run = runtime;
      if (!isCurrent(run) || run.phase !== 'file-awaiting-complete' || !run.itemState || run.itemState.filePreviewLoaded !== true || run.itemState.awaitingUserComplete !== true || run.itemState.submitSent) return false;
      const resource = run.resources[run.index];
      if (!resource || resource.kind !== 'file' || !run.itemState.learningToken) return false;
      const submitted = await submitFile(run, resource, run.itemState.learningToken);
      if (!submitted || !isCurrent(run)) return false;
      run.itemState.awaitingUserComplete = false;
      run.index += 1;
      await startNext(run);
      return true;
    }

    async function filePreviewReady() {
      const run = runtime;
      if (!isCurrent(run) || run.phase !== 'file-loading' || !run.itemState || run.itemState.filePreviewLoaded === true || run.resources[run.index]?.kind !== 'file') return false;
      run.itemState.filePreviewLoaded = true;
      const resource = run.resources[run.index];
      const seconds = run.itemState.fileTotalSeconds;
      if (seconds === 0) {
        run.itemState.awaitingUserComplete = true;
        emit('file-awaiting-complete', { resource, mediaUrl: resource.mediaUrl, secondsRemaining: 0, totalSeconds: 0, requiresUserComplete: true });
        return true;
      }
      emit('file-ready', { resource, secondsRemaining: seconds, totalSeconds: seconds });
      const elapsed = await waitFile(run, resource, seconds);
      if (!elapsed || !isCurrent(run)) return false;
      const submitted = await submitFile(run, resource, run.itemState.learningToken);
      if (!submitted || !isCurrent(run)) return false;
      run.index += 1;
      await startNext(run);
      return true;
    }

    function filePreviewFailed() {
      const run = runtime;
      if (!isCurrent(run) || run.phase !== 'file-loading' || !run.itemState || run.resources[run.index]?.kind !== 'file') return false;
      run.itemState.learningToken = '';
      emit('error', { resource: run.resources[run.index], reason: 'file-preview-failed' });
      return true;
    }

    function imagePreviewReady() {
      const run = runtime;
      if (!isCurrent(run) || run.phase !== 'image-ready' || !run.itemState || run.resources[run.index]?.kind !== 'image') return false;
      run.itemState.imageLoaded = true;
      emit('image-awaiting-complete', { resource: run.resources[run.index], requiresUserComplete: true });
      return true;
    }

    function imagePreviewFailed() {
      const run = runtime;
      if (!isCurrent(run) || run.phase !== 'image-ready' || !run.itemState || run.resources[run.index]?.kind !== 'image') return false;
      emit('error', { resource: run.resources[run.index], reason: 'image-preview-failed' });
      return true;
    }

    async function completeImageOnly() {
      const run = runtime;
      if (!isCurrent(run) || run.phase !== 'image-awaiting-complete' || !run.itemState || run.itemState.imageLoaded !== true || run.itemState.imageCompleted === true || run.resources[run.index]?.kind !== 'image') return false;
      run.itemState.imageCompleted = true;
      run.itemState.learningToken = '';
      run.index += 1;
      await startNext(run);
      return true;
    }

    return {
      async start(scope, resources, sessionSnapshot) {
        if (runtime) return { ok: false, reason: ['complete', 'stopped', 'error', 'unknown'].includes(runtime.phase) ? 'already-started' : 'busy' };
        if (!scope?.activityId || !scope?.activityEnrollmentId || !Array.isArray(resources) || resources.length === 0) return { ok: false, reason: 'missing-scope-or-resources' };
        if (options.isCurrent(scope, sessionSnapshot) !== true) return { ok: false, reason: 'stale-scope' };
        const normalized = resources.map(item => normalizeResource(item, scope, options.sourceUrl || SOURCE_URL));
        const invalid = normalized.find(result => !result.ok);
        if (invalid) return { ok: false, reason: invalid.reason };
        const ids = normalized.map(result => [result.resource.activityId, result.resource.activityEnrollmentId, result.resource.id].join(':'));
        if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate-resource-id' };
        stopTimer();
        runtime = { generation: ++generation, scope: { ...scope }, sessionSnapshot, resources: normalized.map(result => result.resource), index: 0, submittedCount: 0, phase: 'starting', stopped: false, itemState: null };
        emit('starting', { total: runtime.resources.length });
        await startNext(runtime);
        return { ok: runtime.phase !== 'error' && runtime.phase !== 'unknown', ...snapshot() };
      },
      videoTimeUpdate(currentTime, duration) {
        const run = runtime;
        if (!isCurrent(run) || !['video-ready', 'video-playing'].includes(run.phase) || !run.itemState) return false;
        const time = Number(currentTime);
        if (!Number.isFinite(time) || time < 0) return false;
        run.itemState.content = time;
        if (Number.isFinite(Number(duration)) && Number(duration) > 0) run.itemState.duration = Number(duration);
        emit('video-playing', { resource: run.resources[run.index], currentTime: time, duration: run.itemState.duration, fastForwardAllowed: run.itemState.fastForwardAllowed, playbackRate: 1 });
        return true;
      },
      videoEnded(currentTime, duration) {
        const run = runtime;
        if (!isCurrent(run) || !['video-ready', 'video-playing'].includes(run.phase) || !run.itemState) return Promise.resolve(false);
        const time = Number(currentTime), total = Number(duration), observed = Number(run.itemState.content);
        if (!Number.isFinite(time) || !Number.isFinite(total) || total <= 0 || time < total - 1.5) {
          emit('error', { resource: run.resources[run.index], reason: 'video-ended-before-end' });
          return Promise.resolve(false);
        }
        if (!run.itemState.fastForwardAllowed && (!Number.isFinite(observed) || observed < total - 1.5)) {
          emit('error', { resource: run.resources[run.index], reason: 'video-progress-not-confirmed' });
          return Promise.resolve(false);
        }
        return submitVideo(run, total);
      },
      videoPlaybackError() {
        const run = runtime;
        if (!isCurrent(run) || !run.itemState || !['video-ready', 'video-playing'].includes(run.phase)) return false;
        run.itemState.learningToken = '';
        emit('error', { resource: run.resources[run.index], reason: 'video-playback-failed' });
        return true;
      },
      completeFileOnly,
      filePreviewReady,
      filePreviewFailed,
      imagePreviewReady,
      imagePreviewFailed,
      completeImageOnly,
      isFastForwardAllowed() { return !!runtime?.itemState?.fastForwardAllowed; },
      stop,
      snapshot
    };
  }

  return { ROUTES, SOURCE_URL, positiveSeconds, serverSeconds, officialVideoDurationSeconds, fastForwardAllowed, formatTime, attachVideoTailJump, normalizeResource, discoverCourseware, verifyCoursewareCompletion, createManager };
});
