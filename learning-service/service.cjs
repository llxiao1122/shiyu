'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const COURSEWARE = require('./worker/learning-courseware.js');
const { createWorker, publicJob } = require('./worker/server.cjs');

const DEFAULT_API_ORIGIN = 'https://learning01.zzmetro.cn:30426';
const DEFAULT_ORIGIN = 'https://work.ciphera.cn';
const LOGIN_ROUTE = '/gateway/organization/api/open/login/encrypt/loginByAccount';
const TRAINING_ROUTE = '/gateway/manage/api/mycenter/my-training';
const TRAINING_EXAM_ROUTE = COURSEWARE.ROUTES.trainingExamContentList;
const API_PREFIX = '/zg/api';
const COOKIE_NAME = 'zg_session';
const CONSENT_VERSION = 'zg-managed-v1';
const VIDEO_CONSENT_VERSION = 'zg-managed-video-v2';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_RETRY_DELAYS = [1000, 2000];
const SCHEDULE = Object.freeze({ timezone: 'Asia/Shanghai', scanTimes: ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '16:30'] });
const FILE_TYPES = new Set(['PDF', 'OFFICE', 'H5', 'SCORM']);
const HISTORY_STATUSES = new Set(['new', 'queued', 'running', 'completed', 'action_needed']);
const LEARNING_STATUSES = new Set(['completed', 'incomplete', 'unknown']);
const EXAM_STATUSES = new Set(['unknown', 'pending', 'passed', 'none']);
const CATALOG_ROUTES = new Set([
  TRAINING_ROUTE,
  COURSEWARE.ROUTES.trainingDetail,
  COURSEWARE.ROUTES.trainingContentList,
  COURSEWARE.ROUTES.trainingSectionDetail,
  TRAINING_EXAM_ROUTE,
  COURSEWARE.ROUTES.courseDetail,
  COURSEWARE.ROUTES.onlineContentList,
  COURSEWARE.ROUTES.sectionDetail
]);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
const SESSION_COOKIE_RE = /^[A-Za-z0-9_-]{40,64}$/;
const MAX_TRAINING_PAGES = 100;
const MAX_EXAM_PAGES = 100;
const SLOT_GRACE_MS = 5 * 60 * 1000;
const PUBLIC_SCAN_ERROR_CODES = new Set([
  'LOGIN_FAILED', 'PLATFORM_AUTH_EXPIRED', 'ACCOUNT_MISMATCH', 'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_RESPONSE_INVALID', 'INTERRUPTED_SCAN', 'SCAN_BUSY'
]);

class ServiceError extends Error {
  constructor(code, status = 500) { super(code); this.code = code; this.status = status; }
}

function expectedHttpsOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_) {}
  if (typeof value !== 'string' || !value || value !== value.trim() || !parsed ||
      parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash || (value !== parsed.origin && value !== `${parsed.origin}/`)) {
    throw new Error('managed learning expected origin must be an HTTPS origin');
  }
  return parsed.origin;
}

function safeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  const text = String(value);
  return /^[A-Za-z0-9._-]{1,128}$/.test(text) ? text : '';
}

function safeString(value, max = 180) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : '';
}

function safeTitle(value, max) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\t\r\n]+/g, ' ');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) return '';
  return Array.from(normalized.trim().replace(/\s+/g, ' ')).slice(0, max).join('').trim();
}

function firstSafeTitle(max, ...values) {
  for (const value of values) {
    const text = safeTitle(value, max);
    if (text) return text;
  }
  return '';
}

function encryptLoginField(value) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new ServiceError('INVALID_REQUEST', 400);
  // K1=K2=K3 reduces EDE3 to the shipped single DES block operation.
  const key = Buffer.from('efthhgl9', 'utf8');
  const cipher = crypto.createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('hex');
}

function formatShanghai(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+08:00`;
}

function shanghaiParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function shanghaiInstant(year, month, day, hour, minute = 0, second = 0) {
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second));
}

function parseShanghaiDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ServiceError('INVALID_REQUEST', 400);
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) throw new ServiceError('INVALID_REQUEST', 400);
  const utcCheck = new Date(Date.UTC(year, month - 1, day));
  if (utcCheck.getUTCFullYear() !== year || utcCheck.getUTCMonth() !== month - 1 || utcCheck.getUTCDate() !== day) {
    throw new ServiceError('INVALID_REQUEST', 400);
  }
  const fromAt = shanghaiInstant(year, month, day, 0, 0, 0);
  if (!formatShanghai(fromAt).startsWith(`${value}T00:00:00+08:00`)) throw new ServiceError('INVALID_REQUEST', 400);
  return { fromAt, toBefore: fromAt + 24 * 60 * 60 * 1000 };
}

function positiveQueryInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new ServiceError('INVALID_REQUEST', 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new ServiceError('INVALID_REQUEST', 400);
  return parsed;
}

function parseHistoryQuery(url) {
  const allowed = new Set(['keyword', 'status', 'from', 'to', 'page', 'pageSize']);
  const values = new Map();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || values.has(key)) throw new ServiceError('INVALID_REQUEST', 400);
    values.set(key, value);
  }
  const keywordValue = values.get('keyword') ?? '';
  if (keywordValue.length > 120 || /[\u0000-\u001f\u007f]/.test(keywordValue)) throw new ServiceError('INVALID_REQUEST', 400);
  const keyword = keywordValue.trim();
  const statusValue = (values.get('status') ?? '').trim();
  if (statusValue && !HISTORY_STATUSES.has(statusValue)) throw new ServiceError('INVALID_REQUEST', 400);
  const from = values.has('from') ? parseShanghaiDate(values.get('from')) : null;
  const to = values.has('to') ? parseShanghaiDate(values.get('to')) : null;
  if (from && to && from.fromAt > to.fromAt) throw new ServiceError('INVALID_REQUEST', 400);
  return {
    keyword,
    status: statusValue || null,
    fromAt: from?.fromAt ?? null,
    toBefore: to?.toBefore ?? null,
    page: positiveQueryInteger(values.get('page'), 1, 1_000_000),
    pageSize: positiveQueryInteger(values.get('pageSize'), 20, 50)
  };
}

function maskedUsername(value) {
  if (value.length <= 2) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 1)}${'*'.repeat(Math.min(8, value.length - 2))}${value.slice(-1)}`;
}

function parseTrainingCounter(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = String(value).trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return null;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  return Number.isSafeInteger(completed) && Number.isSafeInteger(total) && completed >= 0 && total >= 0 && completed <= total
    ? { completed, total } : null;
}

function parseDoneCount(value) {
  const counter = parseTrainingCounter(value);
  return counter && counter.completed > 0 && counter.total > 0 && counter.completed === counter.total ? counter : null;
}

function parseBeijingCutoff(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e15 ? timestamp : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 64) return null;
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (local) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', fractionText = '0'] = local;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
    const millisecond = Number(fractionText.padEnd(3, '0'));
    if (hour > 23 || minute > 59 || second > 59) return null;
    try {
      const dayStart = parseShanghaiDate(`${yearText}-${monthText}-${dayText}`).fromAt;
      const timestamp = dayStart + hour * 3_600_000 + minute * 60_000 + second * 1000 + millisecond;
      return timestamp > 0 ? timestamp : null;
    } catch (_) { return null; }
  }
  // An offset or Z suffix is required for every non-local representation.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):?(\d{2}))$/i);
  if (!iso) return null;
  const [, year, month, day, hourText, minuteText, secondText = '0', , zone, , offsetHourText, offsetMinuteText] = iso;
  try { parseShanghaiDate(`${year}-${month}-${day}`); } catch (_) { return null; }
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (zone.toUpperCase() !== 'Z') {
    const offsetHour = Number(offsetHourText), offsetMinute = Number(offsetMinuteText);
    if (offsetMinute > 59 || offsetHour > 14 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function officialTrainingCutoff(detail) {
  const endDatetime = detail?.endDatetime;
  const endTime = detail?.endTime;
  const first = endDatetime !== undefined && endDatetime !== null && String(endDatetime).trim() !== '' ? endDatetime : endTime;
  if (first === undefined || first === null || String(first).trim() === '') return null;
  const parsedFirst = parseBeijingCutoff(first);
  if (parsedFirst === null && first === endDatetime && endTime !== undefined && endTime !== null) return parseBeijingCutoff(endTime);
  if (parsedFirst !== null && endDatetime !== undefined && endTime !== undefined) {
    const parsedOther = parseBeijingCutoff(first === endDatetime ? endTime : endDatetime);
    if (parsedOther !== null && parsedOther !== parsedFirst) return null;
  }
  return parsedFirst;
}

function flagState(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (['1', 'TRUE', 'Y', 'YES', 'ON', 'ENABLED'].includes(normalized)) return true;
    if (['', '0', 'FALSE', 'N', 'NO', 'OFF', 'DISABLED', 'NULL'].includes(normalized)) return false;
  }
  return null;
}

const EXTRA_REQUIREMENT_FLAGS = Object.freeze([
  'faceTrainInd', 'operExamInd', 'liveInd', 'fileInd', 'classesInd', 'enabledclasses', 'enabledClasses'
]);

function statusOf(row, fields) {
  for (const field of fields) {
    const value = safeString(row?.[field], 80).toUpperCase();
    if (value) return value;
  }
  return '';
}

function normalizeLearningStatus(value) {
  return LEARNING_STATUSES.has(value) ? value : 'unknown';
}

function normalizeExamStatus(value) {
  return EXAM_STATUSES.has(value) ? value : 'unknown';
}

function hasUnverifiedEnabledFlag(flags, keys) {
  if (!flags || typeof flags !== 'object') return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(flags, key) || flags[key] === null || flags[key] === undefined) continue;
    if (flagState(flags[key]) !== false) return true;
  }
  return false;
}

function classifyTrainingAnomaly(input) {
  const training = input?.training;
  const catalog = input?.catalog;
  const exams = input?.exams;
  const catalogComplete = Boolean(catalog && (catalog.ok === true || catalog.cleanEmpty === true) &&
    Array.isArray(catalog.catalogRows) && Array.isArray(catalog.unsupported) && catalog.unsupported.length === 0 &&
    Array.isArray(catalog.unavailableRows) && catalog.unavailableRows.length === 0 && catalog.partial !== true);
  const examsComplete = Boolean(exams?.ok === true && Array.isArray(exams.records));
  const parentStatus = statusOf(training, ['studyStatus', 'status']);
  const deadlineAt = typeof training?.deadlineAt === 'number' ? training.deadlineAt : NaN;
  const checkedAt = Number.isFinite(input?.now) ? input.now : Date.now();
  if (['NOTATTEMPT', 'PROGRESS', 'INCOMPLETE'].includes(parentStatus) && Number.isFinite(deadlineAt) && deadlineAt < checkedAt) {
    return { complete: catalogComplete && examsComplete, code: 'TRAINING_OVERDUE', evidence: { deadlineExpired: true } };
  }
  if (!catalogComplete || !examsComplete) return { complete: false, code: null, evidence: null };

  const counter = parseTrainingCounter(training?.doneNum);
  if (!counter || !parentStatus) return { complete: false, code: null, evidence: null };
  if (!['NOTATTEMPT', 'PROGRESS', 'INCOMPLETE'].includes(parentStatus)) {
    return ['COMPLETED', 'COMPLETE', 'PASSED', 'PASS'].includes(parentStatus)
      ? { complete: true, code: null, evidence: null } : { complete: false, code: null, evidence: null };
  }

  const flags = training.flags && typeof training.flags === 'object' ? training.flags : {};
  const courseDetails = Array.isArray(catalog.courseDetails) ? catalog.courseDetails : [];
  const requirementsVerified = !(
    hasUnverifiedEnabledFlag(flags, EXTRA_REQUIREMENT_FLAGS) ||
    courseDetails.some(item => hasUnverifiedEnabledFlag(item?.flags, [...EXTRA_REQUIREMENT_FLAGS, 'examInd'])) ||
    catalog.catalogRows.some(row => hasUnverifiedEnabledFlag(row?.flags,
      ['signInd', 'signOutInd', 'scoreInd', 'examInd', 'operExamInd', 'faceTrainInd', 'liveInd', 'classesInd', 'enabledclasses', 'enabledClasses'])) ||
    training.hasUncataloguedRequirements === true
  );
  const examRows = exams.records;
  const hasExamFlag = Object.prototype.hasOwnProperty.call(flags, 'examInd');
  const requiredExamState = hasExamFlag ? flagState(flags.examInd) : false;
  const leaves = catalog.catalogRows.filter(row => {
    const type = statusOf(row, ['type', 'resourceType']);
    return type !== 'ONLINE';
  });
  // An explicitly required online catalog that was read completely but is
  // empty cannot explain an unfinished positive course counter. Keep this as
  // a directory anomaly; it does not invent per-resource learning statuses.
  if (counter.total > 0 && counter.completed < counter.total && flagState(flags.onlineInd) === true &&
      requirementsVerified && leaves.length === 0 && examRows.length === 0 && hasExamFlag && requiredExamState === false) {
    return { complete: true, code: 'COURSEWARE_UNAVAILABLE', evidence: {
      coursewareCount: 0, trainingCompleted: counter.completed, trainingTotal: counter.total
    } };
  }

  if (counter.total === 0 || counter.completed === 0 || counter.completed !== counter.total) return { complete: true, code: null, evidence: null };

  if (!requirementsVerified) return { complete: false, code: null, evidence: null };
  if (flagState(flags.onlineInd) !== true) return { complete: false, code: null, evidence: null };

  if (requiredExamState === true && examRows.length === 0) return { complete: false, code: null, evidence: null };
  if (examRows.length === 0 && (!hasExamFlag || (flags.examInd !== null && flags.examInd !== undefined && requiredExamState === null))) {
    return { complete: false, code: null, evidence: null };
  }
  const examStatuses = examRows.map(row => statusOf(row, ['completionStatus', 'scoreStatus', 'recordScoreStatus', 'studyStatus', 'status']));
  const passedStatus = value => ['PASS', 'PASSED'].includes(value);
  const knownPendingStatus = value => ['FAIL', 'FAILED', 'NOTATTEMPT', 'PROGRESS', 'INCOMPLETE', 'IN_PROGRESS', 'PENDING', 'SCORING', 'NOT_SCORE'].includes(value);
  if (examStatuses.some(value => !value)) return { complete: false, code: null, evidence: null };
  if (examStatuses.some(value => !passedStatus(value) && !knownPendingStatus(value))) return { complete: false, code: null, evidence: null };
  if (examStatuses.some(knownPendingStatus)) return { complete: true, code: null, evidence: null };

  if (!leaves.length && examRows.length === 0) {
    // An explicit exam requirement with an empty result is not proof of completion.
    if (requiredExamState === true) return { complete: false, code: null, evidence: null };
    return { complete: true, code: 'EMPTY_CONTENT_TRAINING_PENDING', evidence: { coursewareCount: 0, completedCount: 0, pendingCount: 0 } };
  }

  if (!leaves.length) return { complete: true, code: null, evidence: null };
  const leafStatuses = leaves.map(row => statusOf(row, ['completionStatus', 'studyStatus', 'signStatus', 'scoreStatus', 'status']));
  const completeStatus = value => ['COMPLETED', 'COMPLETE', 'PASS', 'PASSED'].includes(value);
  if (leafStatuses.some(value => !value)) return { complete: false, code: null, evidence: null };
  if (leafStatuses.some(value => !completeStatus(value) && !knownPendingStatus(value))) return { complete: false, code: null, evidence: null };
  if (leafStatuses.some(value => !completeStatus(value))) return { complete: true, code: null, evidence: null };
  const completed = leaves.length;
  return { complete: true, code: 'CONTENT_COMPLETE_TRAINING_PENDING', evidence: {
    coursewareCount: leaves.length, completedCount: completed, pendingCount: leaves.length - completed
  } };
}

function learningEvidence(input = {}) {
  const training = input.training || {};
  const catalog = input.catalog || {};
  const exams = input.exams || {};
  const sourceResources = Array.isArray(input.resources) ? input.resources : [];
  const catalogRows = Array.isArray(catalog.catalogRows) ? catalog.catalogRows : [];
  const catalogComplete = typeof input.catalogComplete === 'boolean' ? input.catalogComplete : Boolean(
    (catalog.ok === true || catalog.cleanEmpty === true) &&
    Array.isArray(catalog.unsupported) && catalog.unsupported.length === 0 &&
    Array.isArray(catalog.unavailableRows) && catalog.unavailableRows.length === 0 &&
    catalog.partial !== true && Array.isArray(catalog.catalogRows)
  );
  const unknownResources = sourceResources.map(resource => ({ resourceKey: resource.resourceKey, learningStatus: 'unknown' }));
  const unknown = { learningStatus: 'unknown', resources: unknownResources };
  if (!catalogComplete) return unknown;
  if (catalogRows.some(row => !statusOf(row, ['type', 'resourceType']))) return unknown;

  // ONLINE rows describe containers, not leaf learning resources. A complete
  // but empty directory cannot establish that any courseware was learned.
  const leaves = catalogRows.filter(row => statusOf(row, ['type', 'resourceType']) !== 'ONLINE');
  if (!leaves.length) return unknown;

  const leafStatus = row => {
    const status = statusOf(row, ['completionStatus', 'studyStatus', 'signStatus', 'scoreStatus', 'status']);
    if (['COMPLETED', 'COMPLETE'].includes(status)) return 'completed';
    if (['FAIL', 'FAILED', 'NOTATTEMPT', 'PROGRESS', 'INCOMPLETE', 'IN_PROGRESS', 'PENDING', 'SCORING', 'NOT_SCORE'].includes(status)) return 'incomplete';
    return 'unknown';
  };
  const rowIdentity = row => ({
    activityId: safeId(row?.activityId),
    enrollmentId: safeId(row?.activityEnrollmentId),
    resourceId: safeId(row?.id)
  });
  const identityKey = identity => identity.activityId && identity.enrollmentId && identity.resourceId
    ? `${identity.activityId}:${identity.enrollmentId}:${identity.resourceId}` : '';
  const evidenceKey = row => JSON.stringify([
    statusOf(row, ['type', 'resourceType']),
    row?.completionStatusPresent === true,
    row?.completionStatusIsNull === true,
    safeString(row?.completionStatus, 80).toUpperCase(),
    safeString(row?.studyStatus, 80).toUpperCase(),
    safeString(row?.signStatus, 80).toUpperCase(),
    safeString(row?.scoreStatus, 80).toUpperCase(),
    safeString(row?.status, 80).toUpperCase()
  ]);
  const detailStates = new Map();
  for (const detail of Array.isArray(catalog.courseDetails) ? catalog.courseDetails : []) {
    const activityId = safeId(detail?.activityId ?? detail?.id);
    const enrollmentId = safeId(detail?.activityEnrollmentId);
    if (!activityId || !enrollmentId) continue;
    const key = `${activityId}:${enrollmentId}`;
    const state = statusOf(detail, ['studyStatus']);
    const previous = detailStates.get(key);
    if (detailStates.has(key) && previous !== state) detailStates.set(key, 'CONFLICT');
    else if (!detailStates.has(key)) detailStates.set(key, state);
  }
  const allRowsHaveIdentity = leaves.every(row => {
    const identity = rowIdentity(row);
    return Boolean(identity.activityId && identity.enrollmentId && identity.resourceId);
  });
  const explicitNullCompletion = row => row?.completionStatusPresent === true && row?.completionStatusIsNull === true;
  const canInferUnstartedPdf = row => {
    if (!allRowsHaveIdentity || statusOf(row, ['type', 'resourceType']) !== 'PDF' || !explicitNullCompletion(row)) return false;
    const identity = rowIdentity(row);
    const innerKey = `${identity.activityId}:${identity.enrollmentId}`;
    if (detailStates.get(innerKey) !== 'NOTATTEMPT') return false;
    const activityRows = leaves.filter(candidate => {
      const candidateIdentity = rowIdentity(candidate);
      return candidateIdentity.activityId === identity.activityId && candidateIdentity.enrollmentId === identity.enrollmentId;
    });
    return activityRows.length > 0 && activityRows.every(candidate =>
      ['PDF', 'VIDEO'].includes(statusOf(candidate, ['type', 'resourceType'])) && explicitNullCompletion(candidate));
  };
  const canInferUnstartedVideo = row => {
    if (!allRowsHaveIdentity || statusOf(row, ['type', 'resourceType']) !== 'VIDEO' || !explicitNullCompletion(row)) return false;
    const identity = rowIdentity(row);
    if (detailStates.get(`${identity.activityId}:${identity.enrollmentId}`) !== 'NOTATTEMPT') return false;
    const activityRows = leaves.filter(candidate => {
      const other = rowIdentity(candidate);
      return other.activityId === identity.activityId && other.enrollmentId === identity.enrollmentId;
    });
    return activityRows.length > 0 && activityRows.every(candidate =>
      ['PDF', 'VIDEO'].includes(statusOf(candidate, ['type', 'resourceType'])) && explicitNullCompletion(candidate));
  };
  const classifyLeaf = (row, conflicted = false) => {
    if (conflicted) return 'unknown';
    const direct = leafStatus(row);
    if (direct !== 'unknown') return direct;
    const type = statusOf(row, ['type', 'resourceType']);
    const identity = rowIdentity(row);
    const innerState = identity.activityId && identity.enrollmentId
      ? detailStates.get(`${identity.activityId}:${identity.enrollmentId}`) : '';
    if (type !== 'VIDEO' && innerState === 'COMPLETED') return 'completed';
    if (canInferUnstartedPdf(row) || canInferUnstartedVideo(row)) return 'incomplete';
    return 'unknown';
  };
  const leafGroups = new Map();
  const unkeyedLeafStatuses = [];
  for (const row of leaves) {
    const key = identityKey(rowIdentity(row));
    if (!key) {
      unkeyedLeafStatuses.push(leafStatus(row));
      continue;
    }
    const signature = evidenceKey(row);
    const group = leafGroups.get(key);
    if (!group) leafGroups.set(key, { row, signature, conflicted: false });
    else if (group.signature !== signature) group.conflicted = true;
  }
  const byResourceKey = new Map();
  for (const [key, group] of leafGroups) byResourceKey.set(key, classifyLeaf(group.row, group.conflicted));
  const leafStatuses = [...byResourceKey.values(), ...unkeyedLeafStatuses];
  const examsComplete = exams.ok === true && Array.isArray(exams.records);
  const examStatuses = examsComplete
    ? exams.records.map(row => statusOf(row, ['completionStatus', 'scoreStatus', 'recordScoreStatus', 'studyStatus', 'status']))
    : [];
  const passedExam = value => ['PASS', 'PASSED'].includes(value);
  const pendingExam = value => ['FAIL', 'FAILED', 'NOTATTEMPT', 'PROGRESS', 'INCOMPLETE', 'IN_PROGRESS', 'PENDING', 'SCORING', 'NOT_SCORE'].includes(value);
  const examsUnknown = !examsComplete || examStatuses.some(value => !value || (!passedExam(value) && !pendingExam(value)));
  const examPending = examStatuses.some(pendingExam);
  const leafPending = leafStatuses.includes('incomplete');

  const trainingFlags = training.flags && typeof training.flags === 'object' ? training.flags : {};
  const nestedDetails = Array.isArray(catalog.courseDetails) ? catalog.courseDetails : [];
  const hasUnknownRequirements = hasUnverifiedEnabledFlag(trainingFlags, EXTRA_REQUIREMENT_FLAGS) ||
    nestedDetails.some(item => hasUnverifiedEnabledFlag(item?.flags, [...EXTRA_REQUIREMENT_FLAGS, 'examInd'])) ||
    catalogRows.some(row => hasUnverifiedEnabledFlag(row?.flags,
      ['signInd', 'signOutInd', 'scoreInd', 'examInd', 'operExamInd', 'faceTrainInd', 'liveInd', 'classesInd', 'enabledclasses', 'enabledClasses'])) ||
    training.hasUncataloguedRequirements === true;
  const examFlagPresent = Object.prototype.hasOwnProperty.call(trainingFlags, 'examInd');
  const requiredExamState = examFlagPresent ? flagState(trainingFlags.examInd) : null;
  const noExamRequirementVerified = examsComplete && (examStatuses.length > 0 ||
    (examFlagPresent && requiredExamState === false));
  const parentStatus = statusOf(training, ['studyStatus', 'status']);

  let learningStatus = 'unknown';
  if (leafPending || examPending) {
    learningStatus = 'incomplete';
  } else if (['COMPLETED', 'COMPLETE'].includes(parentStatus) && examsComplete && !examsUnknown) {
    // A verified parent completion can label the training, while missing leaf
    // statuses remain unknown on their individual courseware rows.
    learningStatus = 'completed';
  } else if (leafStatuses.every(value => value === 'completed') &&
      examStatuses.every(passedExam) && !examsUnknown && noExamRequirementVerified &&
      !hasUnknownRequirements && flagState(trainingFlags.onlineInd) === true) {
    learningStatus = 'completed';
  }

  const resourceStatuses = sourceResources.map(resource => ({
    resourceKey: resource.resourceKey,
    learningStatus: normalizeLearningStatus(byResourceKey.get(resource.resourceKey))
  }));
  return { learningStatus, resources: resourceStatuses };
}

function classifyTrainingExamStatus(training, exams) {
  if (exams?.ok !== true || !Array.isArray(exams.records)) return 'unknown';
  if (exams.records.length === 0) {
    const flags = training?.flags && typeof training.flags === 'object' ? training.flags : {};
    if (!Object.prototype.hasOwnProperty.call(flags, 'examInd')) return 'unknown';
    const raw = flags.examInd;
    return raw === null || flagState(raw) === false ? 'none' : 'unknown';
  }
  const passed = new Set(['PASS', 'PASSED']);
  const pending = new Set(['FAIL', 'FAILED', 'NOTATTEMPT', 'PROGRESS', 'INCOMPLETE', 'IN_PROGRESS', 'PENDING']);
  const rowStates = exams.records.map(row => {
    const values = ['completionStatus', 'scoreStatus', 'recordScoreStatus', 'studyStatus', 'status']
      .map(field => safeString(row?.[field], 80).toUpperCase()).filter(Boolean);
    if (!values.length || values.some(value => !passed.has(value) && !pending.has(value))) return 'unknown';
    const states = new Set(values.map(value => passed.has(value) ? 'passed' : 'pending'));
    return states.size === 1 ? [...states][0] : 'unknown';
  });
  if (rowStates.some(value => value === 'unknown')) return 'unknown';
  if (rowStates.some(value => value === 'pending')) return 'pending';
  return 'passed';
}

function openStore(dataDir) {
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
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid service key');
  fs.chmodSync(keyPath, 0o600);

  const dbPath = path.join(dataDir, 'managed-learning.sqlite');
  const db = new DatabaseSync(dbPath);
  fs.chmodSync(dbPath, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL UNIQUE,
    org_cipher TEXT NOT NULL,
    username_cipher TEXT NOT NULL,
    password_cipher TEXT NOT NULL,
    token_cipher TEXT NOT NULL,
    user_id_cipher TEXT NOT NULL,
    display_name_cipher TEXT NOT NULL,
    username_masked_cipher TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    consent_accepted_at INTEGER NOT NULL,
    initial_baseline_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id, expires_at);
  CREATE TABLE IF NOT EXISTS training_baselines (
    scope_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    activity_id_cipher TEXT NOT NULL,
    enrollment_id_cipher TEXT NOT NULL,
    title_cipher TEXT NOT NULL,
    status TEXT NOT NULL,
    learning_status TEXT NOT NULL DEFAULT 'unknown' CHECK(learning_status IN ('completed','incomplete','unknown')),
    exam_status TEXT NOT NULL DEFAULT 'unknown' CHECK(exam_status IN ('unknown','pending','passed','none')),
    has_exam_content INTEGER CHECK(has_exam_content IN (0,1)),
    completed_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS baseline_account ON training_baselines(account_id, updated_at);
  CREATE TABLE IF NOT EXISTS training_anomalies (
    scope_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    activity_id_cipher TEXT NOT NULL,
    enrollment_id_cipher TEXT NOT NULL,
    title_cipher TEXT NOT NULL,
    code TEXT NOT NULL,
    evidence_cipher TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS anomalies_account_checked ON training_anomalies(account_id, checked_at DESC);
  CREATE TABLE IF NOT EXISTS anomaly_scan_state (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    status TEXT NOT NULL CHECK(status IN ('pending','checked','partial','unavailable')),
    checked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS resources (
    resource_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    scope_hash TEXT NOT NULL,
    resource_key_cipher TEXT NOT NULL,
    activity_id_cipher TEXT NOT NULL,
    enrollment_id_cipher TEXT NOT NULL,
    resource_id_cipher TEXT NOT NULL,
    type_cipher TEXT NOT NULL,
    title_cipher TEXT NOT NULL,
    training_title_cipher TEXT NOT NULL,
    is_baseline INTEGER NOT NULL,
    learning_status TEXT NOT NULL DEFAULT 'unknown' CHECK(learning_status IN ('completed','incomplete','unknown')),
    status TEXT NOT NULL,
    batch_id TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    remaining_seconds INTEGER NOT NULL DEFAULT 0,
    worker_verified_complete INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS resources_account_status ON resources(account_id, status, updated_at);
  CREATE INDEX IF NOT EXISTS resources_batch ON resources(batch_id);
  CREATE TABLE IF NOT EXISTS history_events (
    event_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    resource_hash TEXT NOT NULL,
    resource_id_cipher TEXT NOT NULL,
    name_cipher TEXT NOT NULL,
    training_title_cipher TEXT NOT NULL,
    status TEXT NOT NULL,
    previous_status TEXT,
    event TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS history_owner_recorded ON history_events(account_id, recorded_at DESC, event_id DESC);
  CREATE INDEX IF NOT EXISTS history_owner_status_recorded ON history_events(account_id, status, recorded_at DESC, event_id DESC);
  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    scope_hash TEXT NOT NULL,
    activity_id_cipher TEXT NOT NULL,
    enrollment_id_cipher TEXT NOT NULL,
    resource_keys_cipher TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_job_id TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    remaining_seconds INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS batches_account_status ON batches(account_id, status, updated_at);
  CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    slot_key TEXT NOT NULL,
    status TEXT NOT NULL,
    scanned_at INTEGER,
    login_attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    learn_existing INTEGER NOT NULL DEFAULT 0,
    learn_existing_requested_at INTEGER,
    selected_resource_hashes_cipher TEXT,
    selected_count INTEGER NOT NULL DEFAULT 0,
    existing_completed_at INTEGER,
    UNIQUE(account_id, slot_key)
  );
  CREATE INDEX IF NOT EXISTS scan_runs_account ON scan_runs(account_id, scanned_at DESC);
  CREATE TABLE IF NOT EXISTS scan_progress (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN ('discovering','checking','complete','failed')),
    processed INTEGER NOT NULL DEFAULT 0 CHECK(processed >= 0),
    total INTEGER CHECK(total IS NULL OR total >= 0),
    error_code TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scan_locks (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    run_id TEXT NOT NULL,
    started_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credential_locks (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    lock_id TEXT NOT NULL,
    started_at INTEGER NOT NULL
  );`);
  const accountColumns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(column => column.name));
  if (!accountColumns.has('initial_baseline_at')) db.exec('ALTER TABLE accounts ADD COLUMN initial_baseline_at INTEGER');
  const batchColumns = new Set(db.prepare('PRAGMA table_info(batches)').all().map(column => column.name));
  if (!batchColumns.has('video_enabled')) db.exec('ALTER TABLE batches ADD COLUMN video_enabled INTEGER NOT NULL DEFAULT 0');
  const baselineColumns = new Set(db.prepare('PRAGMA table_info(training_baselines)').all().map(column => column.name));
  if (!baselineColumns.has('learning_status')) db.exec("ALTER TABLE training_baselines ADD COLUMN learning_status TEXT NOT NULL DEFAULT 'unknown' CHECK(learning_status IN ('completed','incomplete','unknown'))");
  if (!baselineColumns.has('exam_status')) db.exec("ALTER TABLE training_baselines ADD COLUMN exam_status TEXT NOT NULL DEFAULT 'unknown' CHECK(exam_status IN ('unknown','pending','passed','none'))");
  if (!baselineColumns.has('has_exam_content')) db.exec('ALTER TABLE training_baselines ADD COLUMN has_exam_content INTEGER CHECK(has_exam_content IN (0,1))');
  if (!accountColumns.has('existing_content_completed_at')) db.exec('ALTER TABLE accounts ADD COLUMN existing_content_completed_at INTEGER');
  const resourceColumns = new Set(db.prepare('PRAGMA table_info(resources)').all().map(column => column.name));
  if (!resourceColumns.has('learning_status')) db.exec("ALTER TABLE resources ADD COLUMN learning_status TEXT NOT NULL DEFAULT 'unknown' CHECK(learning_status IN ('completed','incomplete','unknown'))");
  if (!resourceColumns.has('worker_verified_complete')) db.exec('ALTER TABLE resources ADD COLUMN worker_verified_complete INTEGER NOT NULL DEFAULT 0');
  const scanRunColumns = new Set(db.prepare('PRAGMA table_info(scan_runs)').all().map(column => column.name));
  if (!scanRunColumns.has('learn_existing')) db.exec('ALTER TABLE scan_runs ADD COLUMN learn_existing INTEGER NOT NULL DEFAULT 0');
  if (!scanRunColumns.has('learn_existing_requested_at')) db.exec('ALTER TABLE scan_runs ADD COLUMN learn_existing_requested_at INTEGER');
  if (!scanRunColumns.has('selected_resource_hashes_cipher')) db.exec('ALTER TABLE scan_runs ADD COLUMN selected_resource_hashes_cipher TEXT');
  if (!scanRunColumns.has('selected_count')) db.exec('ALTER TABLE scan_runs ADD COLUMN selected_count INTEGER NOT NULL DEFAULT 0');
  if (!scanRunColumns.has('existing_completed_at')) db.exec('ALTER TABLE scan_runs ADD COLUMN existing_completed_at INTEGER');
  const scanProgressColumns = new Set(db.prepare('PRAGMA table_info(scan_progress)').all().map(column => column.name));
  if (!scanProgressColumns.has('succeeded')) db.exec('ALTER TABLE scan_progress ADD COLUMN succeeded INTEGER');
  if (!scanProgressColumns.has('skipped')) db.exec('ALTER TABLE scan_progress ADD COLUMN skipped INTEGER');
  if (!scanProgressColumns.has('results_json')) db.exec("ALTER TABLE scan_progress ADD COLUMN results_json TEXT NOT NULL DEFAULT '[]'");
  function videoAuthorized(accountId) { return selectAccount.get(accountId)?.consent_version === VIDEO_CONSENT_VERSION; }
  function supportedType(accountId, type) { return FILE_TYPES.has(type) || (type === 'VIDEO' && videoAuthorized(accountId)); }

  function encrypt(value) {
    if (typeof value !== 'string' || !value) throw new Error('missing encrypted value');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  }
  function decrypt(value) {
    if (typeof value !== 'string' || !value) throw new Error('missing encrypted value');
    const [ivPart, tagPart, dataPart, extra] = value.split('.');
    if (!ivPart || !tagPart || dataPart === undefined || extra !== undefined) throw new Error('invalid encrypted value');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  }
  function digest(value) { return crypto.createHmac('sha256', key).update(value, 'utf8').digest('base64url'); }
  function hashSession(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('base64url'); }
  let transactionDepth = 0;
  function tx(work) {
    if (transactionDepth > 0) return work();
    db.exec('BEGIN IMMEDIATE');
    transactionDepth = 1;
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
    finally { transactionDepth = 0; }
  }
  const selectAccount = db.prepare('SELECT * FROM accounts WHERE id=?');
  const selectAccountKey = db.prepare('SELECT * FROM accounts WHERE account_key=?');
  const insertAccount = db.prepare(`INSERT INTO accounts(id,account_key,org_cipher,username_cipher,password_cipher,token_cipher,user_id_cipher,display_name_cipher,username_masked_cipher,consent_version,consent_accepted_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateAccount = db.prepare(`UPDATE accounts SET org_cipher=?,username_cipher=?,password_cipher=?,token_cipher=?,user_id_cipher=?,display_name_cipher=?,username_masked_cipher=?,consent_version=?,consent_accepted_at=?,updated_at=? WHERE id=?`);

  function decodeAccount(row) {
    if (!row) return null;
    return {
      id: row.id,
      accountKey: row.account_key,
      orgCode: decrypt(row.org_cipher),
      username: decrypt(row.username_cipher),
      password: decrypt(row.password_cipher),
      token: decrypt(row.token_cipher),
      userId: decrypt(row.user_id_cipher),
      displayName: decrypt(row.display_name_cipher),
      usernameMasked: decrypt(row.username_masked_cipher),
      consentVersion: row.consent_version,
      consentAcceptedAt: Number(row.consent_accepted_at),
      initialBaselineAt: row.initial_baseline_at === null ? null : Number(row.initial_baseline_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }
  function getAccount(id) { return decodeAccount(selectAccount.get(id)); }
  function findAccountByKey(accountKey) { return decodeAccount(selectAccountKey.get(accountKey)); }
  function saveAccount(input, timestamp) {
    const normalizedOrgCode = input.orgCode.toUpperCase();
    const accountKey = digest(`${normalizedOrgCode}\u0000${input.userId}`);
    return tx(() => {
      const existing = decodeAccount(selectAccountKey.get(accountKey));
      const values = [encrypt(normalizedOrgCode), encrypt(input.username), encrypt(input.password), encrypt(input.token),
        encrypt(input.userId), encrypt(input.displayName || input.username), encrypt(maskedUsername(input.username)),
        input.allowVideo === true || existing?.consentVersion === VIDEO_CONSENT_VERSION ? VIDEO_CONSENT_VERSION : CONSENT_VERSION, timestamp, timestamp];
      if (existing) {
        updateAccount.run(...values, existing.id);
        return existing.id;
      }
      const id = crypto.randomUUID();
      insertAccount.run(id, accountKey, ...values.slice(0, 9), timestamp, timestamp);
      return id;
    });
  }
  function updateCredentials(id, input, timestamp) {
    const account = getAccount(id);
    if (!account) throw new ServiceError('AUTH_REQUIRED', 401);
    updateAccount.run(encrypt(input.orgCode), encrypt(input.username), encrypt(input.password), encrypt(input.token),
      encrypt(input.userId), encrypt(input.displayName || input.username), encrypt(maskedUsername(input.username)),
      account.consentVersion, account.consentAcceptedAt, timestamp, id);
  }
  function saveToken(id, token, timestamp) {
    const account = selectAccount.get(id);
    if (!account) throw new ServiceError('AUTH_REQUIRED', 401);
    updateAccount.run(account.org_cipher, account.username_cipher, account.password_cipher, encrypt(token),
      account.user_id_cipher, account.display_name_cipher, account.username_masked_cipher,
      account.consent_version, Number(account.consent_accepted_at), timestamp, id);
  }
  function markInitialBaseline(id, timestamp) {
    db.prepare('UPDATE accounts SET initial_baseline_at=COALESCE(initial_baseline_at,?),updated_at=? WHERE id=?').run(timestamp, timestamp, id);
  }
  function hasInitialBaseline(id) {
    const row = db.prepare('SELECT initial_baseline_at FROM accounts WHERE id=?').get(id);
    return Boolean(row && row.initial_baseline_at !== null);
  }
  function createSession(rawToken, accountId, timestamp) {
    const hash = hashSession(rawToken);
    tx(() => db.prepare('INSERT INTO sessions(session_hash,account_id,created_at,expires_at) VALUES(?,?,?,?)')
      .run(hash, accountId, timestamp, timestamp + SESSION_TTL_MS));
    return hash;
  }
  function sessionAccount(rawToken, timestamp) {
    const hash = hashSession(rawToken);
    const row = db.prepare('SELECT account_id,expires_at FROM sessions WHERE session_hash=?').get(hash);
    if (!row || Number(row.expires_at) <= timestamp) {
      if (row) db.prepare('DELETE FROM sessions WHERE session_hash=?').run(hash);
      return null;
    }
    return getAccount(row.account_id);
  }
  function revokeSession(rawToken) { db.prepare('DELETE FROM sessions WHERE session_hash=?').run(hashSession(rawToken)); }
  function listAccounts() { return db.prepare('SELECT id FROM accounts ORDER BY created_at').all().map(row => getAccount(row.id)); }
  function accountExists(id) { return Boolean(selectAccount.get(id)); }

  const selectBaseline = db.prepare('SELECT * FROM training_baselines WHERE scope_hash=?');
  const selectBaselinesForAccount = db.prepare('SELECT * FROM training_baselines WHERE account_id=? ORDER BY updated_at');
  const upsertBaseline = db.prepare(`INSERT INTO training_baselines(scope_hash,account_id,activity_id_cipher,enrollment_id_cipher,title_cipher,status,learning_status,exam_status,has_exam_content,completed_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_hash) DO UPDATE SET activity_id_cipher=excluded.activity_id_cipher,enrollment_id_cipher=excluded.enrollment_id_cipher,title_cipher=excluded.title_cipher,status=excluded.status,learning_status=excluded.learning_status,exam_status=excluded.exam_status,has_exam_content=excluded.has_exam_content,completed_at=excluded.completed_at,updated_at=excluded.updated_at`);
  function decodeBaseline(row) {
    return row ? { scopeHash: row.scope_hash, accountId: row.account_id, activityId: decrypt(row.activity_id_cipher),
      enrollmentId: decrypt(row.enrollment_id_cipher), title: decrypt(row.title_cipher), status: row.status,
      learningStatus: normalizeLearningStatus(row.learning_status), examStatus: normalizeExamStatus(row.exam_status),
      hasExamContent: row.has_exam_content === null || row.has_exam_content === undefined ? null : Number(row.has_exam_content) === 1,
      completedAt: row.completed_at === null ? null : Number(row.completed_at), updatedAt: Number(row.updated_at) } : null;
  }
  function getBaseline(scopeHash) { return decodeBaseline(selectBaseline.get(scopeHash)); }
  function setBaseline(input) {
    if (!LEARNING_STATUSES.has(input.learningStatus ?? 'unknown')) throw new Error('invalid learning status');
    if (!EXAM_STATUSES.has(input.examStatus ?? 'unknown')) throw new Error('invalid baseline exam status');
    if (!accountExists(input.accountId) || input.scopeHash !== scopeHash(input.accountId, input.activityId, input.enrollmentId)) {
      throw new Error('invalid baseline scope');
    }
    return tx(() => upsertBaseline.run(input.scopeHash, input.accountId, encrypt(input.activityId), encrypt(input.enrollmentId),
      encrypt(firstSafeTitle(180, input.title, '未命名培训')), input.status, input.learningStatus ?? 'unknown', input.examStatus ?? 'unknown',
      input.hasExamContent === true ? 1 : input.hasExamContent === false ? 0 : null, input.completedAt ?? null, input.updatedAt));
  }
  function listBaselines(accountId) { return selectBaselinesForAccount.all(accountId).map(decodeBaseline); }

  function markLearningEvidenceUnknownForScope(accountId, scopeHash) {
    return tx(() => {
      const row = selectBaseline.get(scopeHash);
      if (!row || row.account_id !== accountId) return false;
      db.prepare("UPDATE training_baselines SET learning_status='unknown',exam_status='unknown' WHERE scope_hash=? AND account_id=?").run(scopeHash, accountId);
      db.prepare("UPDATE resources SET learning_status='unknown' WHERE scope_hash=? AND account_id=? AND is_baseline=1").run(scopeHash, accountId);
      return true;
    });
  }
  function markLearningEvidenceUnknownForActivity(accountId, activityId) {
    let matched = false;
    for (const baseline of listBaselines(accountId)) {
      if (baseline.activityId !== activityId) continue;
      matched = markLearningEvidenceUnknownForScope(accountId, baseline.scopeHash) || matched;
    }
    return matched;
  }
  function setTrainingLearningStatus(accountId, scopeHash, learningStatus) {
    if (!LEARNING_STATUSES.has(learningStatus)) throw new Error('invalid learning status');
    const result = db.prepare('UPDATE training_baselines SET learning_status=? WHERE scope_hash=? AND account_id=?')
      .run(learningStatus, scopeHash, accountId);
    return Number(result.changes) > 0;
  }
  function setTrainingExamStatus(accountId, scopeHash, examStatus) {
    if (!EXAM_STATUSES.has(examStatus)) throw new Error('invalid baseline exam status');
    const result = db.prepare('UPDATE training_baselines SET exam_status=? WHERE scope_hash=? AND account_id=?')
      .run(examStatus, scopeHash, accountId);
    return Number(result.changes) > 0;
  }
  function setLearningEvidence(input) {
    if (!input || !accountExists(input.accountId) || typeof input.scopeHash !== 'string' || !LEARNING_STATUSES.has(input.learningStatus)) {
      throw new Error('invalid learning evidence');
    }
    const baseline = selectBaseline.get(input.scopeHash);
    if (!baseline || baseline.account_id !== input.accountId) return false;
    const updateResources = Object.prototype.hasOwnProperty.call(input, 'resources');
    if (updateResources && !Array.isArray(input.resources)) throw new Error('invalid resource learning evidence');
    const resources = updateResources ? input.resources : [];
    return tx(() => {
      db.prepare('UPDATE training_baselines SET learning_status=? WHERE scope_hash=? AND account_id=?')
        .run(input.learningStatus, input.scopeHash, input.accountId);
      if (updateResources) {
        db.prepare("UPDATE resources SET learning_status='unknown' WHERE scope_hash=? AND account_id=? AND is_baseline=1")
          .run(input.scopeHash, input.accountId);
        for (const item of resources) {
          if (!item || typeof item.resourceKey !== 'string' || !item.resourceKey || !LEARNING_STATUSES.has(item.learningStatus)) {
            throw new Error('invalid resource learning evidence');
          }
          const hash = resourceHash(input.accountId, item.resourceKey);
          db.prepare(`UPDATE resources SET learning_status=? WHERE resource_hash=? AND account_id=? AND scope_hash=? AND is_baseline=1`)
            .run(item.learningStatus, hash, input.accountId, input.scopeHash);
        }
      }
      return true;
    });
  }

  const selectAnomaliesForAccount = db.prepare('SELECT * FROM training_anomalies WHERE account_id=? ORDER BY detected_at,scope_hash');
  const selectFreshAnomalyForScope = db.prepare('SELECT 1 FROM training_anomalies WHERE account_id=? AND scope_hash=? AND stale=0');
  function decodeAnomaly(row) {
    if (!row) return null;
    let evidence = null;
    try { evidence = JSON.parse(decrypt(row.evidence_cipher)); } catch (_) { evidence = null; }
    return { scopeHash: row.scope_hash, accountId: row.account_id,
      activityId: decrypt(row.activity_id_cipher), enrollmentId: decrypt(row.enrollment_id_cipher),
      trainingTitle: decrypt(row.title_cipher), code: row.code, evidence,
      detectedAt: Number(row.detected_at), checkedAt: Number(row.checked_at), stale: Number(row.stale) === 1 };
  }
  function listTrainingAnomalies(accountId) { return selectAnomaliesForAccount.all(accountId).map(decodeAnomaly); }
  function hasFreshAnomalyScope(accountId, scopeHash) { return Boolean(selectFreshAnomalyForScope.get(accountId, scopeHash)); }
  function saveAnomalyCheck(input) {
    return tx(() => {
      const existing = db.prepare('SELECT code,detected_at FROM training_anomalies WHERE scope_hash=? AND account_id=?').get(input.scopeHash, input.accountId);
      if (!input.code) {
        db.prepare('DELETE FROM training_anomalies WHERE scope_hash=? AND account_id=?').run(input.scopeHash, input.accountId);
        return;
      }
      const detectedAt = existing?.code === input.code ? Number(existing.detected_at) : input.checkedAt;
      db.prepare(`INSERT INTO training_anomalies(scope_hash,account_id,activity_id_cipher,enrollment_id_cipher,title_cipher,code,evidence_cipher,detected_at,checked_at,stale)
        VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(scope_hash) DO UPDATE SET account_id=excluded.account_id,
        activity_id_cipher=excluded.activity_id_cipher,enrollment_id_cipher=excluded.enrollment_id_cipher,title_cipher=excluded.title_cipher,
        code=excluded.code,evidence_cipher=excluded.evidence_cipher,detected_at=excluded.detected_at,checked_at=excluded.checked_at,stale=0`)
        .run(input.scopeHash, input.accountId, encrypt(input.activityId), encrypt(input.enrollmentId), encrypt(firstSafeTitle(180, input.trainingTitle, '未命名培训')),
          input.code, encrypt(JSON.stringify(input.evidence || {})), detectedAt, input.checkedAt);
    });
  }
  function markAnomaliesStale(accountId) {
    db.prepare('UPDATE training_anomalies SET stale=1 WHERE account_id=?').run(accountId);
  }
  function markAnomalyStaleForActivity(accountId, activityId) {
    for (const anomaly of listTrainingAnomalies(accountId)) {
      if (anomaly.activityId === activityId) db.prepare('UPDATE training_anomalies SET stale=1 WHERE scope_hash=? AND account_id=?').run(anomaly.scopeHash, accountId);
    }
  }
  function markAnomaliesStaleForOtherEnrollments(accountId, activityId, enrollmentId) {
    tx(() => {
      for (const anomaly of listTrainingAnomalies(accountId)) {
        if (anomaly.activityId === activityId && anomaly.enrollmentId !== enrollmentId) {
          db.prepare('UPDATE training_anomalies SET stale=1 WHERE scope_hash=? AND account_id=?').run(anomaly.scopeHash, accountId);
        }
      }
    });
  }
  function deleteAnomalyForScope(accountId, scopeHash) {
    db.prepare('DELETE FROM training_anomalies WHERE scope_hash=? AND account_id=?').run(scopeHash, accountId);
  }
  function setAnomalyScanState(accountId, status, checkedAt) {
    if (!['pending', 'checked', 'partial', 'unavailable'].includes(status)) throw new Error('invalid anomaly scan status');
    db.prepare(`INSERT INTO anomaly_scan_state(account_id,status,checked_at) VALUES(?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at`)
      .run(accountId, status, checkedAt ?? null);
  }
  function anomalyScanState(accountId) {
    const row = db.prepare('SELECT status,checked_at FROM anomaly_scan_state WHERE account_id=?').get(accountId);
    return row ? { status: row.status, checkedAt: row.checked_at === null ? null : Number(row.checked_at) }
      : { status: 'pending', checkedAt: null };
  }

  const selectResource = db.prepare('SELECT * FROM resources WHERE resource_hash=?');
  const selectResourcesForAccount = db.prepare('SELECT * FROM resources WHERE account_id=? ORDER BY updated_at DESC LIMIT 100');
  const selectAllResourceStatusesForAccount = db.prepare('SELECT scope_hash,type_cipher,is_baseline,status,learning_status FROM resources WHERE account_id=?');
  const selectWaitingCandidates = db.prepare(`SELECT * FROM resources WHERE account_id=? AND
    (status IN ('new','queued') OR (is_baseline=1 AND status='baseline' AND learning_status='incomplete'))
    ORDER BY updated_at DESC,resource_hash`);
  const selectBaselineCoursewareLearningStatuses = db.prepare('SELECT type_cipher,learning_status FROM resources WHERE account_id=? AND scope_hash=? AND is_baseline=1');
  const selectBaselineSummaryResources = db.prepare('SELECT scope_hash,type_cipher,learning_status FROM resources WHERE account_id=? AND is_baseline=1');
  const selectUnbatchedResources = db.prepare("SELECT * FROM resources WHERE account_id=? AND status='new' AND batch_id IS NULL ORDER BY updated_at,resource_hash");
  const insertResource = db.prepare(`INSERT INTO resources(resource_hash,account_id,scope_hash,resource_key_cipher,activity_id_cipher,enrollment_id_cipher,resource_id_cipher,type_cipher,title_cipher,training_title_cipher,is_baseline,learning_status,status,batch_id,total,completed,remaining_seconds,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateResource = db.prepare(`UPDATE resources SET title_cipher=?,training_title_cipher=?,is_baseline=?,status=?,batch_id=?,total=?,completed=?,remaining_seconds=?,updated_at=? WHERE resource_hash=?`);
  const insertHistoryEvent = db.prepare(`INSERT INTO history_events(event_id,account_id,resource_hash,resource_id_cipher,name_cipher,training_title_cipher,status,previous_status,event,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  function appendHistoryEvent(resourceRow, status, previousStatus, event, recordedAt) {
    if (!resourceRow || resourceRow.status === 'baseline' || !HISTORY_STATUSES.has(status)) return;
    insertHistoryEvent.run(crypto.randomUUID(), resourceRow.account_id, resourceRow.resource_hash,
      resourceRow.resource_id_cipher, resourceRow.title_cipher, resourceRow.training_title_cipher,
      status, previousStatus ?? null, event, recordedAt);
  }
  function decodeResource(row) {
    return row ? { resourceHash: row.resource_hash, accountId: row.account_id, scopeHash: row.scope_hash,
      resourceKey: decrypt(row.resource_key_cipher), activityId: decrypt(row.activity_id_cipher),
      enrollmentId: decrypt(row.enrollment_id_cipher), resourceId: decrypt(row.resource_id_cipher),
      type: decrypt(row.type_cipher), title: decrypt(row.title_cipher), trainingTitle: decrypt(row.training_title_cipher),
      isBaseline: Number(row.is_baseline) === 1, learningStatus: normalizeLearningStatus(row.learning_status), status: row.status, batchId: row.batch_id,
      total: Number(row.total), completed: Number(row.completed), remainingSeconds: Number(row.remaining_seconds),
      updatedAt: Number(row.updated_at) } : null;
  }
  function resourceHash(accountId, resourceKey) { return digest(`resource\u0000${accountId}\u0000${resourceKey}`); }
  function scopeHash(accountId, activityId, enrollmentId) { return digest(`scope\u0000${accountId}\u0000${activityId}\u0000${enrollmentId}`); }
  function getResource(accountId, resourceKey) { return decodeResource(selectResource.get(resourceHash(accountId, resourceKey))); }
  function upsertDiscoveredResource(input) {
    return tx(() => {
      const hash = resourceHash(input.accountId, input.resourceKey);
      const row = selectResource.get(hash);
      const title = firstSafeTitle(240, input.title, '学习课件');
      const trainingTitle = firstSafeTitle(180, input.trainingTitle, '未命名培训');
      if (!row) {
        const isFile = supportedType(input.accountId, input.type);
        insertResource.run(hash, input.accountId, input.scopeHash, encrypt(input.resourceKey), encrypt(input.activityId),
          encrypt(input.enrollmentId), encrypt(input.resourceId), encrypt(input.type), encrypt(title),
          encrypt(trainingTitle), input.isBaseline ? 1 : 0,
          input.isBaseline ? normalizeLearningStatus(input.learningStatus) : 'unknown', input.isBaseline ? 'baseline' : isFile ? 'new' : 'skipped',
          null, 0, 0, 0, input.updatedAt);
        const inserted = selectResource.get(hash);
        if (isFile && !input.isBaseline) appendHistoryEvent(inserted, 'new', null, 'discovered', input.updatedAt);
        return { created: true, resource: decodeResource(inserted) };
      }
      const current = decodeResource(row);
      const status = current.status === 'new' ? 'new' : current.status;
      updateResource.run(encrypt(title), encrypt(trainingTitle), current.isBaseline ? 1 : 0,
        status, current.batchId, current.total, current.completed, current.remainingSeconds, input.updatedAt, hash);
      return { created: false, resource: decodeResource(selectResource.get(hash)) };
    });
  }
  function unbatchedResources(accountId) { return selectUnbatchedResources.all(accountId).map(decodeResource).filter(item => supportedType(accountId, item.type)); }
  function listResources(accountId) { return selectResourcesForAccount.all(accountId).map(decodeResource); }
  function countUnverifiedBaselineResources(accountId) {
    return db.prepare("SELECT * FROM resources WHERE account_id=? AND is_baseline=1 AND status='baseline' AND learning_status='unknown'")
      .all(accountId).map(decodeResource).filter(item => supportedType(accountId, item.type)).length;
  }
  function baselineCoursewareLearningStatus(accountId, scopeHash) {
    const statuses = selectBaselineCoursewareLearningStatuses.all(accountId, scopeHash)
      .filter(row => supportedType(accountId, decrypt(row.type_cipher).toUpperCase()))
      .map(row => normalizeLearningStatus(row.learning_status));
    if (!statuses.length) return 'unknown';
    if (statuses.includes('incomplete')) return 'incomplete';
    return statuses.every(status => status === 'completed') ? 'completed' : 'unknown';
  }
  function historyWhere(filters = {}) {
    const clauses = ['account_id=?'];
    const values = [filters.accountId];
    if (filters.status) { clauses.push('status=?'); values.push(filters.status); }
    if (filters.fromAt !== undefined && filters.fromAt !== null) { clauses.push('recorded_at>=?'); values.push(filters.fromAt); }
    if (filters.toBefore !== undefined && filters.toBefore !== null) { clauses.push('recorded_at<?'); values.push(filters.toBefore); }
    return { where: clauses.join(' AND '), values };
  }
  function decodeHistoryRow(row, name = null, trainingTitle = null) {
    return {
      eventId: row.event_id,
      id: decrypt(row.resource_id_cipher),
      name: name ?? decrypt(row.name_cipher),
      trainingTitle: trainingTitle ?? decrypt(row.training_title_cipher),
      status: row.status,
      previousStatus: row.previous_status,
      event: row.event,
      recordedAt: Number(row.recorded_at)
    };
  }
  const historySelectFields = 'event_id,resource_id_cipher,name_cipher,training_title_cipher,status,previous_status,event,recorded_at';
  function historyRows(accountId, filters = {}) {
    const { where, values } = historyWhere({ ...filters, accountId });
    const rows = db.prepare(`SELECT ${historySelectFields} FROM history_events WHERE ${where} ORDER BY recorded_at DESC,rowid DESC`).all(...values);
    return rows.map(row => decodeHistoryRow(row));
  }
  function searchHistory(accountId, filters) {
    const { where, values } = historyWhere({ ...filters, accountId });
    const keyword = filters.keyword.toLowerCase();
    const offset = (filters.page - 1) * filters.pageSize;
    if (!keyword) {
      const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM history_events WHERE ${where}`).get(...values).total);
      const rows = db.prepare(`SELECT ${historySelectFields} FROM history_events WHERE ${where}
        ORDER BY recorded_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...values, filters.pageSize, offset);
      return { total, items: rows.map(row => decodeHistoryRow(row)) };
    }
    const rows = db.prepare(`SELECT ${historySelectFields} FROM history_events WHERE ${where} ORDER BY recorded_at DESC,rowid DESC`).iterate(...values);
    const items = [];
    let total = 0;
    for (const row of rows) {
      const name = decrypt(row.name_cipher);
      const trainingTitle = decrypt(row.training_title_cipher);
      if (!name.toLowerCase().includes(keyword) && !trainingTitle.toLowerCase().includes(keyword)) continue;
      if (total >= offset && total < offset + filters.pageSize) {
        items.push(decodeHistoryRow(row, name, trainingTitle));
      }
      total += 1;
    }
    return { total, items };
  }
  function updateResourcesForBatch(batchId, patch, timestamp) {
    return tx(() => {
      const rows = db.prepare(`SELECT resource_hash,account_id,resource_id_cipher,title_cipher,training_title_cipher,
        is_baseline,status,total,completed,remaining_seconds FROM resources WHERE batch_id=?`).all(batchId);
      for (const row of rows) {
        updateResource.run(row.title_cipher, row.training_title_cipher, Number(row.is_baseline),
          patch.status, batchId, patch.total ?? Number(row.total), patch.completed ?? Number(row.completed),
          patch.remainingSeconds ?? Number(row.remaining_seconds), timestamp, row.resource_hash);
        if (patch.status === 'completed' && patch.verifiedComplete === true) {
          db.prepare("UPDATE resources SET worker_verified_complete=1 WHERE resource_hash=? AND account_id=?")
            .run(row.resource_hash, row.account_id);
          if (Number(row.is_baseline) === 1) {
            db.prepare("UPDATE resources SET learning_status='completed' WHERE resource_hash=? AND account_id=?")
              .run(row.resource_hash, row.account_id);
          }
        }
        if (row.status !== patch.status) appendHistoryEvent(row, patch.status, row.status, 'status_changed', timestamp);
      }
    });
  }
  function assignBatchResources(batchId, resources, timestamp) {
    return tx(() => {
      for (const resource of resources) {
        const hash = resource.resourceHash;
        const existing = selectResource.get(hash);
        if (!existing || existing.account_id !== resource.accountId || existing.status !== 'new' || existing.batch_id !== null) {
          throw new ServiceError('RESOURCE_STATE_CONFLICT', 409);
        }
        updateResource.run(existing.title_cipher, existing.training_title_cipher, Number(existing.is_baseline),
          'queued', batchId, 0, 0, 0, timestamp, hash);
        appendHistoryEvent(existing, 'queued', existing.status, 'status_changed', timestamp);
      }
    });
  }

  const insertBatch = db.prepare(`INSERT INTO batches(id,account_id,scope_hash,activity_id_cipher,enrollment_id_cipher,resource_keys_cipher,status,worker_job_id,total,completed,remaining_seconds,created_at,updated_at,video_enabled)
    VALUES(?,?,?,?,?,?,?,NULL,0,0,0,?,?,?)`);
  const selectBatch = db.prepare('SELECT * FROM batches WHERE id=?');
  const selectBatchesForAccount = db.prepare('SELECT * FROM batches WHERE account_id=? ORDER BY created_at');
  const updateBatch = db.prepare('UPDATE batches SET status=?,worker_job_id=?,total=?,completed=?,remaining_seconds=?,updated_at=? WHERE id=?');
  function decodeBatch(row) {
    return row ? { id: row.id, accountId: row.account_id, scopeHash: row.scope_hash,
      activityId: decrypt(row.activity_id_cipher), enrollmentId: decrypt(row.enrollment_id_cipher),
      resourceKeys: JSON.parse(decrypt(row.resource_keys_cipher)), allowVideo: Number(row.video_enabled) === 1, status: row.status, workerJobId: row.worker_job_id,
      total: Number(row.total), completed: Number(row.completed), remainingSeconds: Number(row.remaining_seconds),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) } : null;
  }
  function promoteExistingResources(accountId, freshResourcesByScope, timestamp) {
    if (!(freshResourcesByScope instanceof Map)) throw new Error('invalid fresh resource map');
    if (!accountExists(accountId) || freshResourcesByScope.size === 0) return [];
    return tx(() => {
      const baselines = new Map(listBaselines(accountId).map(item => [item.scopeHash, item]));
      const rows = db.prepare("SELECT * FROM resources WHERE account_id=? AND is_baseline=1 AND status='baseline' AND batch_id IS NULL AND learning_status='incomplete'")
        .all(accountId);
      const promoted = [];
      for (const row of rows) {
        if (db.prepare('SELECT 1 FROM training_anomalies WHERE account_id=? AND scope_hash=? AND stale=0').get(accountId, row.scope_hash)) continue;
        const resource = decodeResource(row);
        const baseline = baselines.get(resource.scopeHash);
        const freshKeys = freshResourcesByScope.get(resource.scopeHash);
        if (!baseline || baseline.status !== 'complete' || baseline.completedAt === null ||
            !(freshKeys instanceof Set) || !freshKeys.has(resource.resourceKey) || resource.accountId !== accountId ||
            resource.scopeHash !== scopeHash(accountId, baseline.activityId, baseline.enrollmentId) ||
            !safeId(resource.resourceId) || resource.resourceKey !== `${resource.activityId}:${resource.enrollmentId}:${resource.resourceId}` ||
            !supportedType(accountId, resource.type)) continue;
        updateResource.run(row.title_cipher, row.training_title_cipher, Number(row.is_baseline), 'new', row.batch_id,
          Number(row.total), Number(row.completed), Number(row.remaining_seconds), timestamp, row.resource_hash);
        promoted.push(decodeResource(selectResource.get(row.resource_hash)));
      }
      return promoted;
    });
  }
  function createBatchesForNew(accountId, timestamp, resourceHashes = null) {
    const allowedHashes = resourceHashes === null ? null : new Set(resourceHashes);
    const pending = unbatchedResources(accountId).filter(item => allowedHashes === null || allowedHashes.has(item.resourceHash));
    const groups = new Map();
    for (const resource of pending) {
      const list = groups.get(resource.scopeHash) || [];
      list.push(resource);
      groups.set(resource.scopeHash, list);
    }
    const created = [];
    tx(() => {
      for (const [hash, resources] of groups) {
        if (db.prepare('SELECT 1 FROM training_anomalies WHERE account_id=? AND scope_hash=? AND stale=0').get(accountId, hash)) continue;
        const batch = decodeBaseline(selectBaseline.get(hash));
        if (!batch || batch.accountId !== accountId || batch.status !== 'complete') continue;
        const id = crypto.randomUUID();
        // The worker authorizes the outer training; resource keys retain each inner course identity.
        const activityId = batch.activityId;
        const enrollmentId = batch.enrollmentId;
        const keys = resources.map(item => item.resourceKey);
        insertBatch.run(id, accountId, hash, encrypt(activityId), encrypt(enrollmentId), encrypt(JSON.stringify(keys)), 'queued', timestamp, timestamp, videoAuthorized(accountId) ? 1 : 0);
        assignBatchResources(id, resources, timestamp);
        created.push(id);
      }
    });
    return created.map(getBatch);
  }
  function getBatch(id) { return decodeBatch(selectBatch.get(id)); }
  function listBatches(accountId) { return selectBatchesForAccount.all(accountId).map(decodeBatch); }
  function saveBatchStatus(id, patch, timestamp) {
    return tx(() => {
      const current = getBatch(id);
      if (!current) return;
      updateBatch.run(patch.status ?? current.status, patch.workerJobId === undefined ? current.workerJobId : patch.workerJobId,
        patch.total ?? current.total, patch.completed ?? current.completed, patch.remainingSeconds ?? current.remainingSeconds,
        timestamp, id);
      if (patch.resourceStatus) updateResourcesForBatch(id, { status: patch.resourceStatus, total: patch.total,
        completed: patch.completed, remainingSeconds: patch.remainingSeconds,
        verifiedComplete: patch.verifiedComplete === true }, timestamp);
      latchExistingLearningCompletion(current.accountId, timestamp);
      latchCompletedExistingContent(current.accountId, timestamp);
    });
  }
  function refreshBatchCounters(id, job, timestamp) {
    const batch = getBatch(id);
    if (!batch || !job) return;
    let status = 'running';
    let resourceStatus = 'running';
    if (job.status === 'completed') { status = 'completed'; resourceStatus = 'completed'; }
    else if (job.status === 'failed' || job.status === 'unknown') { status = 'action_needed'; resourceStatus = 'action_needed'; }
    else if (job.status === 'pending' || job.phase === 'queued') { status = 'queued'; resourceStatus = 'queued'; }
    saveBatchStatus(id, { status, workerJobId: job.id, total: job.total, completed: job.completed,
      remainingSeconds: job.remainingSeconds || 0, resourceStatus, verifiedComplete: job.verifiedComplete === true }, timestamp);
  }

  const insertScanRun = db.prepare(`INSERT INTO scan_runs(id,account_id,slot_key,status,scanned_at,login_attempts,error_code,learn_existing,learn_existing_requested_at,selected_resource_hashes_cipher,selected_count)
    VALUES(?,?,?,'running',NULL,0,NULL,?,?,NULL,0)`);
  const getSlot = db.prepare('SELECT * FROM scan_runs WHERE account_id=? AND slot_key=?');
  const updateSlot = db.prepare('UPDATE scan_runs SET status=?,scanned_at=?,login_attempts=?,error_code=? WHERE id=?');
  const lastScanForAccount = db.prepare('SELECT status,scanned_at,login_attempts,error_code FROM scan_runs WHERE account_id=? AND scanned_at IS NOT NULL ORDER BY scanned_at DESC LIMIT 1');
  const upsertScanProgress = db.prepare(`INSERT INTO scan_progress(account_id,run_id,stage,processed,total,error_code,updated_at,succeeded,skipped,results_json)
    VALUES(?,?,'discovering',0,NULL,NULL,?,0,0,'[]') ON CONFLICT(account_id) DO UPDATE SET run_id=excluded.run_id,stage='discovering',processed=0,total=NULL,error_code=NULL,updated_at=excluded.updated_at,succeeded=0,skipped=0,results_json='[]'`);
  const selectScanProgress = db.prepare('SELECT run_id,stage,processed,total,error_code,updated_at,succeeded,skipped,results_json FROM scan_progress WHERE account_id=?');
  const selectLatestExistingLearningRun = db.prepare(`SELECT * FROM scan_runs WHERE account_id=? AND learn_existing=1
    ORDER BY learn_existing_requested_at DESC,rowid DESC LIMIT 1`);
  const selectUnlatchedExistingLearningRuns = db.prepare(`SELECT id,selected_resource_hashes_cipher,selected_count FROM scan_runs
    WHERE account_id=? AND learn_existing=1 AND existing_completed_at IS NULL AND selected_count>0`);
  const selectResourceStatusByHash = db.prepare('SELECT status,learning_status,worker_verified_complete FROM resources WHERE resource_hash=? AND account_id=?');
  function getScanProgress(accountId) {
    const row = selectScanProgress.get(accountId);
    if (!row) return { stage: 'idle', unit: 'trainings', processed: 0, succeeded: null, failed: null, skipped: null, total: null, errorCode: null, items: [] };
    let items = [];
    try {
      const parsed = JSON.parse(row.results_json || '[]');
      if (Array.isArray(parsed)) {
        items = parsed.filter(item => item && typeof item === 'object' &&
          ['verified', 'unverified', 'skipped'].includes(item.status) && typeof item.title === 'string')
          .slice(0, MAX_TRAINING_PAGES * 10)
          .map(item => ({ title: safeTitle(item.title, 180) || '未命名培训', status: item.status,
            reason: safeTitle(item.reason, 180) }));
      }
    } catch (_) { items = []; }
    return { stage: row.stage, unit: 'trainings', processed: Number(row.processed), total: row.total === null ? null : Number(row.total),
      succeeded: row.succeeded === null ? null : Number(row.succeeded), skipped: row.skipped === null ? null : Number(row.skipped),
      failed: row.succeeded === null || row.skipped === null ? null : Math.max(0, Number(row.processed) - Number(row.succeeded) - Number(row.skipped)),
      errorCode: PUBLIC_SCAN_ERROR_CODES.has(row.error_code) ? row.error_code : null, items };
  }
  function updateScanProgress(accountId, runId, patch, timestamp) {
    const current = selectScanProgress.get(accountId);
    if (!current || current.run_id !== runId) return false;
    if (patch.stage === 'checking') {
      db.prepare("UPDATE scan_progress SET stage='checking',processed=0,succeeded=0,skipped=0,total=?,error_code=NULL,results_json='[]',updated_at=? WHERE account_id=? AND run_id=?")
        .run(patch.total, timestamp, accountId, runId);
    } else if (patch.increment === true) {
      if (!['success', 'failed', 'skipped'].includes(patch.outcome)) throw new Error('invalid scan outcome');
      let items = [];
      try {
        const parsed = JSON.parse(current.results_json || '[]');
        if (Array.isArray(parsed)) items = parsed;
      } catch (_) { items = []; }
      if (patch.result && typeof patch.result === 'object' &&
          ['verified', 'unverified', 'skipped'].includes(patch.result.status)) {
        items.push({
          title: safeTitle(patch.result.title, 180) || '未命名培训',
          status: patch.result.status,
          reason: safeTitle(patch.result.reason, 180)
        });
      }
      if (items.length > MAX_TRAINING_PAGES * 10) items = items.slice(-MAX_TRAINING_PAGES * 10);
      db.prepare('UPDATE scan_progress SET processed=MIN(processed+1,total),succeeded=succeeded+?,skipped=skipped+?,results_json=?,updated_at=? WHERE account_id=? AND run_id=? AND stage=\'checking\' AND processed<total')
        .run(patch.outcome === 'success' ? 1 : 0, patch.outcome === 'skipped' ? 1 : 0, JSON.stringify(items), timestamp, accountId, runId);
    } else {
      db.prepare('UPDATE scan_progress SET updated_at=? WHERE account_id=? AND run_id=?').run(timestamp, accountId, runId);
    }
    return true;
  }
  function setExistingLearningSelection(runId, resourceHashes) {
    if (!Array.isArray(resourceHashes) || resourceHashes.some(hash => typeof hash !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(hash))) {
      throw new Error('invalid existing learning selection');
    }
    const result = db.prepare(`UPDATE scan_runs SET selected_resource_hashes_cipher=?,selected_count=? WHERE id=? AND learn_existing=1`)
      .run(encrypt(JSON.stringify(resourceHashes)), resourceHashes.length, runId);
    return Number(result.changes) > 0;
  }
  function latchExistingLearningCompletion(accountId, timestamp) {
    for (const row of selectUnlatchedExistingLearningRuns.all(accountId)) {
      try {
        const hashes = JSON.parse(decrypt(row.selected_resource_hashes_cipher));
        if (!Array.isArray(hashes) || hashes.length !== Number(row.selected_count) || hashes.length === 0) continue;
        const resources = hashes.map(hash => selectResourceStatusByHash.get(hash, accountId));
        if (resources.every(resource => resource && resource.status === 'completed' && resource.learning_status === 'completed' && Number(resource.worker_verified_complete) === 1)) {
          db.prepare('UPDATE scan_runs SET existing_completed_at=COALESCE(existing_completed_at,?) WHERE id=?')
            .run(timestamp, row.id);
        }
      } catch (_) { /* Corrupt selection remains action_needed; never infer completion. */ }
    }
  }
  function existingLearning(accountId) {
    if (selectAccount.get(accountId)?.existing_content_completed_at != null) return { state: 'completed', hideBaselineList: true };
    const row = selectLatestExistingLearningRun.get(accountId);
    if (!row) return { state: 'not_started', hideBaselineList: false };
    let state = 'action_needed';
    if (row.status === 'running') state = 'running';
    else if (row.existing_completed_at !== null && row.existing_completed_at !== undefined) state = 'action_needed';
    else if (row.selected_resource_hashes_cipher) {
      try {
        const hashes = JSON.parse(decrypt(row.selected_resource_hashes_cipher));
        if (!Array.isArray(hashes) || hashes.length !== Number(row.selected_count)) throw new Error('selection mismatch');
        if (hashes.length > 0) {
          const resources = hashes.map(hash => selectResourceStatusByHash.get(hash, accountId));
          if (resources.some(resource => !resource)) state = 'action_needed';
          else if (resources.some(resource => ['action_needed', 'skipped'].includes(resource.status)) ||
              resources.some(resource => !['queued', 'running', 'completed'].includes(resource.status))) state = 'action_needed';
          else if (resources.every(resource => resource.status === 'completed')) state = 'action_needed';
          else state = 'running';
        }
      } catch (_) { state = 'action_needed'; }
    }
    return { state, hideBaselineList: state === 'completed' };
  }
  function latchCompletedExistingContent(accountId, timestamp) {
    if (!hasInitialBaseline(accountId)) return false;
    const excluded = new Set(listTrainingAnomalies(accountId).map(item => item.scopeHash));
    const normal = listBaselines(accountId).filter(item => !excluded.has(item.scopeHash));
    if (normal.some(item => item.status !== 'complete')) return false;
    const scopes = new Set(normal.map(item => item.scopeHash));
    const allRows = selectBaselineSummaryResources.all(accountId).filter(row =>
      supportedType(accountId, decrypt(row.type_cipher).toUpperCase()));
    const rows = allRows.filter(row =>
      !excluded.has(row.scope_hash) && supportedType(accountId, decrypt(row.type_cipher).toUpperCase()));
    if (rows.length === 0 && allRows.some(row => row.learning_status !== 'completed')) return false;
    if (rows.some(row => !scopes.has(row.scope_hash) || row.learning_status !== 'completed')) return false;
    db.prepare('UPDATE accounts SET existing_content_completed_at=COALESCE(existing_content_completed_at,?) WHERE id=?').run(timestamp, accountId);
    return true;
  }
  function startSlot(accountId, slotKey, runId, timestamp) {
    return tx(() => {
      const existing = getSlot.get(accountId, slotKey);
      if (existing) return null;
      insertScanRun.run(runId, accountId, slotKey, 0, null);
      db.prepare('INSERT INTO scan_locks(account_id,run_id,started_at) VALUES(?,?,?)').run(accountId, runId, timestamp);
      upsertScanProgress.run(accountId, runId, timestamp);
      return runId;
    });
  }
  function tryAcquireInitial(accountId, slotKey, runId, timestamp, learnExisting = false) {
    return tx(() => {
      if (db.prepare('SELECT run_id FROM scan_locks WHERE account_id=?').get(accountId)) return false;
      if (db.prepare('SELECT lock_id FROM credential_locks WHERE account_id=?').get(accountId)) return false;
      if (slotKey !== null && getSlot.get(accountId, slotKey)) return false;
      insertScanRun.run(runId, accountId, slotKey ?? `initial:${runId}`, learnExisting ? 1 : 0, learnExisting ? timestamp : null);
      db.prepare('INSERT INTO scan_locks(account_id,run_id,started_at) VALUES(?,?,?)').run(accountId, runId, timestamp);
      upsertScanProgress.run(accountId, runId, timestamp);
      return true;
    });
  }
  function acquireScheduled(accountId, slotKey, runId, timestamp) {
    return tryAcquireInitial(accountId, slotKey, runId, timestamp);
  }
  function finishScan(runId, accountId, status, timestamp, loginAttempts, errorCode) {
    tx(() => {
      updateSlot.run(status, timestamp, loginAttempts, errorCode || null, runId);
      db.prepare('DELETE FROM scan_locks WHERE account_id=? AND run_id=?').run(accountId, runId);
      const progress = selectScanProgress.get(accountId);
      const hasFailedItems = progress?.run_id === runId && progress.succeeded !== null && progress.skipped !== null && Number(progress.processed) > Number(progress.succeeded) + Number(progress.skipped);
      db.prepare(`UPDATE scan_progress SET stage=?,error_code=?,updated_at=? WHERE account_id=? AND run_id=?`)
        .run(status === 'complete' && !hasFailedItems ? 'complete' : 'failed', errorCode || null, timestamp, accountId, runId);
    });
  }
  function acquireCredentialLock(accountId, lockId, timestamp) {
    return tx(() => {
      if (db.prepare('SELECT run_id FROM scan_locks WHERE account_id=?').get(accountId)) return false;
      if (db.prepare('SELECT lock_id FROM credential_locks WHERE account_id=?').get(accountId)) return false;
      db.prepare('INSERT INTO credential_locks(account_id,lock_id,started_at) VALUES(?,?,?)').run(accountId, lockId, timestamp);
      return true;
    });
  }
  function releaseCredentialLock(accountId, lockId) {
    db.prepare('DELETE FROM credential_locks WHERE account_id=? AND lock_id=?').run(accountId, lockId);
  }
  function markSkippedSlot(accountId, slotKey, timestamp) {
    tx(() => {
      if (getSlot.get(accountId, slotKey)) return;
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO scan_runs(id,account_id,slot_key,status,scanned_at,login_attempts,error_code) VALUES(?,?,?,'skipped',?,0,'MISSED_SLOT')`).run(id, accountId, slotKey, timestamp);
    });
  }
  function recordLoginAttempts(runId, attempts) { db.prepare('UPDATE scan_runs SET login_attempts=? WHERE id=?').run(attempts, runId); }
  function lastScan(accountId) { const row = lastScanForAccount.get(accountId); return row ? { status: row.status, scannedAt: row.scanned_at === null ? null : Number(row.scanned_at), loginAttempts: Number(row.login_attempts), errorCode: PUBLIC_SCAN_ERROR_CODES.has(row.error_code) ? row.error_code : null } : { status: 'never', scannedAt: null, loginAttempts: 0, errorCode: null }; }
  function scheduledSlot(accountId, slotKey) {
    const row = getSlot.get(accountId, slotKey);
    return row ? { status: row.status, errorCode: row.error_code } : null;
  }
  function acquireLockForRecovery(timestamp) {
    tx(() => {
      const interrupted = db.prepare("SELECT DISTINCT account_id FROM scan_runs WHERE status='running'").all().map(row => row.account_id);
      db.prepare("UPDATE scan_runs SET status='action_needed',scanned_at=COALESCE(scanned_at,?),error_code='INTERRUPTED_SCAN' WHERE status='running'").run(timestamp);
      db.exec('DELETE FROM scan_locks');
      db.exec('DELETE FROM credential_locks');
      db.prepare("UPDATE training_baselines SET status='pending',updated_at=? WHERE status='running' AND completed_at IS NULL").run(timestamp);
      for (const accountId of interrupted) {
        db.prepare(`UPDATE scan_progress SET stage='failed',error_code='INTERRUPTED_SCAN',updated_at=?
          WHERE account_id=? AND stage IN ('discovering','checking')`).run(timestamp, accountId);
        db.prepare(`INSERT INTO anomaly_scan_state(account_id,status,checked_at) VALUES(?,'partial',?)
          ON CONFLICT(account_id) DO UPDATE SET status='partial',checked_at=excluded.checked_at`).run(accountId, timestamp);
      }
    });
  }

  function progress(accountId) {
    const baselineRows = listBaselines(accountId);
    const completedTrainingScopes = new Set(baselineRows.filter(item => item.learningStatus === 'completed').map(item => item.scopeHash));
    const storedAnomalies = listTrainingAnomalies(accountId);
    const anomalousScopes = new Set(storedAnomalies.map(item => item.scopeHash));
    const trainings = baselineRows.map(item => {
      const coursewareLearningStatus = baselineCoursewareLearningStatus(accountId, item.scopeHash);
      return { activityId: item.activityId, title: item.title, status: item.status,
        learningStatus: item.learningStatus, examStatus: item.examStatus,
        needsExam: item.examStatus === 'pending' && coursewareLearningStatus === 'completed',
        coursewareLearningStatus,
        completedAt: item.completedAt === null ? null : formatShanghai(item.completedAt) };
    });
    const currentIncomplete = trainings.length ? trainings : [];
    const accountRow = selectAccount.get(accountId);
    const initialAt = accountRow?.initial_baseline_at === null || accountRow?.initial_baseline_at === undefined ? null : Number(accountRow.initial_baseline_at);
    let baselineStatus = 'pending';
    if (currentIncomplete.some(item => item.status === 'action_needed')) baselineStatus = 'action_needed';
    else if (currentIncomplete.some(item => item.status === 'running')) baselineStatus = 'running';
    else if (initialAt !== null) baselineStatus = 'complete';
    const baselineTimes = baselineRows.filter(item => item.status === 'complete' && item.completedAt !== null).map(item => item.completedAt);
    const completedAt = initialAt !== null ? formatShanghai(initialAt) : baselineStatus === 'complete' && baselineTimes.length ? formatShanghai(Math.max(...baselineTimes)) : null;
    const baselineSummary = { total: 0, completed: 0, incomplete: 0, unknown: 0, needsExamTrainings: 0 };
    const normalBaselineScopes = new Set(baselineRows.filter(item => !anomalousScopes.has(item.scopeHash)).map(item => item.scopeHash));
    for (const row of selectBaselineSummaryResources.all(accountId)) {
      if (!normalBaselineScopes.has(row.scope_hash) || !supportedType(accountId, decrypt(row.type_cipher).toUpperCase())) continue;
      baselineSummary.total += 1;
      baselineSummary[normalizeLearningStatus(row.learning_status)] += 1;
    }
    for (const item of baselineRows) {
      if (anomalousScopes.has(item.scopeHash) || item.examStatus !== 'pending') continue;
      if (baselineCoursewareLearningStatus(accountId, item.scopeHash) === 'completed') baselineSummary.needsExamTrainings += 1;
    }
    const publicCourseware = item => ({
      id: item.resourceId,
      activityId: item.activityId,
      trainingGroupId: digest(`public-training\u0000${accountId}\u0000${item.scopeHash}`),
      trainingTitle: item.trainingTitle,
      name: item.title,
      type: item.type,
      status: item.status,
      learningStatus: item.learningStatus,
      updatedAt: formatShanghai(item.updatedAt),
      total: item.total,
      completed: item.completed,
      remainingSeconds: item.remainingSeconds
    });
    const fileCourseware = listResources(accountId).filter(item => supportedType(accountId, item.type)).map(publicCourseware);
    const waitingRows = selectWaitingCandidates.all(accountId).filter(row =>
      !anomalousScopes.has(row.scope_hash) && !(row.status === 'new' && completedTrainingScopes.has(row.scope_hash)) &&
      supportedType(accountId, decrypt(row.type_cipher).toUpperCase()));
    const waitingCourseware = {
      items: waitingRows.slice(0, 100).map(decodeResource).map(publicCourseware),
      total: waitingRows.length,
      truncated: waitingRows.length > 100
    };
    const dashboardSummary = { total: 0, baseline: 0, completed: 0, learning: 0, waiting: 0, needsAttention: 0 };
    const categoryGroups = { completed: new Map(), learning: new Map(), waiting: new Map() };
    const scopeCoursewareCounts = new Map();
    const baselineByScope = new Map(baselineRows.map(item => [item.scopeHash, item]));
    const addCourseCount = (category, scope) => {
      const groups = categoryGroups[category];
      if (!groups.has(scope)) groups.set(scope, {
        trainingGroupId: digest(`public-training\u0000${accountId}\u0000${scope}`),
        trainingTitle: baselineByScope.get(scope)?.title || '学习课程', coursewareCount: 0
      });
      groups.get(scope).coursewareCount += 1;
    };
    let fileCoursewareTotal = 0;
    for (const row of selectAllResourceStatusesForAccount.all(accountId)) {
      if (!supportedType(accountId, decrypt(row.type_cipher).toUpperCase())) continue;
      if (row.status === 'new' && completedTrainingScopes.has(row.scope_hash)) continue;
      fileCoursewareTotal += 1;
      scopeCoursewareCounts.set(row.scope_hash, (scopeCoursewareCounts.get(row.scope_hash) || 0) + 1);
      if (anomalousScopes.has(row.scope_hash)) {
        // Expiry/unavailable parent requirements do not erase verified leaf history.
        // Only completed evidence is visible here; no excluded work is queued.
        if (row.learning_status === 'completed') {
          dashboardSummary.total += 1;
          if (row.status === 'baseline') dashboardSummary.baseline += 1;
          dashboardSummary.completed += 1;
          addCourseCount('completed', row.scope_hash);
        }
        continue;
      }
      dashboardSummary.total += 1;
      if (row.status === 'baseline') {
        dashboardSummary.baseline += 1;
        if (row.learning_status === 'completed') { dashboardSummary.completed += 1; addCourseCount('completed', row.scope_hash); }
        else if (row.learning_status === 'incomplete') { dashboardSummary.waiting += 1; addCourseCount('waiting', row.scope_hash); }
        else dashboardSummary.needsAttention += 1;
        continue;
      }
      if (row.status === 'completed') { dashboardSummary.completed += 1; addCourseCount('completed', row.scope_hash); }
      else if (row.status === 'running') { dashboardSummary.learning += 1; addCourseCount('learning', row.scope_hash); }
      else if (row.status === 'new' || row.status === 'queued') { dashboardSummary.waiting += 1; addCourseCount('waiting', row.scope_hash); }
      else dashboardSummary.needsAttention += 1;
    }
    const scan = lastScan(accountId);
    if (initialAt === null && scan.status === 'action_needed' && baselineStatus !== 'running') baselineStatus = 'action_needed';
    const anomalies = storedAnomalies.map(item => ({
      id: item.activityId,
      trainingTitle: item.trainingTitle,
      code: item.code,
      stale: item.stale,
      checkedAt: formatShanghai(item.checkedAt),
      ...(item.evidence && Object.keys(item.evidence).length ? { evidence: item.evidence } : {})
    }));
    const anomalyState = anomalyScanState(accountId);
    const anomalyCountsByCode = {};
    for (const item of anomalies) if (!item.stale) anomalyCountsByCode[item.code] = (anomalyCountsByCode[item.code] || 0) + 1;
    const courseSummaries = Object.fromEntries(Object.entries(categoryGroups).map(([category, groups]) => [category, {
      items: [...groups.values()], totalCourses: groups.size, totalCourseware: dashboardSummary[category]
    }]));
    const anomalyCourses = storedAnomalies.filter(item => !item.stale).map(item => ({
      trainingGroupId: digest(`public-training\u0000${accountId}\u0000${item.scopeHash}`),
      trainingTitle: item.trainingTitle,
      coursewareCount: scopeCoursewareCounts.get(item.scopeHash) ??
        (Number.isSafeInteger(item.evidence?.coursewareCount) ? item.evidence.coursewareCount :
          baselineByScope.get(item.scopeHash)?.status === 'complete' ? 0 : null)
    }));
    courseSummaries.anomalies = { items: anomalyCourses, totalCourses: anomalyCourses.length };
    const examCourses = baselineRows.filter(item => item.examStatus === 'pending' || (item.hasExamContent === true && !['passed', 'none'].includes(item.examStatus))).map(item => ({
      trainingGroupId: digest(`public-training\u0000${accountId}\u0000${item.scopeHash}`),
      trainingTitle: item.title,
      examStatus: item.examStatus,
      coursewareCount: scopeCoursewareCounts.get(item.scopeHash) ?? null
    }));
    courseSummaries.exams = { items: examCourses, totalCourses: examCourses.length };
    return { baseline: { status: baselineStatus, completedAt, trainings, summary: baselineSummary }, lastScan: scan,
      scanProgress: getScanProgress(accountId), existingLearning: existingLearning(accountId), fileCourseware, waitingCourseware, courseSummaries,
      fileCoursewareTotal, fileCoursewareTruncated: fileCoursewareTotal > fileCourseware.length, dashboardSummary,
      anomalies, anomalySummary: { total: anomalies.filter(item => !item.stale).length, countsByCode: anomalyCountsByCode, status: anomalyState.status,
        checkedAt: anomalyState.checkedAt === null ? null : formatShanghai(anomalyState.checkedAt) } };
  }

  return {
    db, encrypt, decrypt, digest, transaction: work => tx(work),
    getAccount, findAccountByKey, saveAccount, updateCredentials, saveToken, markInitialBaseline, hasInitialBaseline, latchCompletedExistingContent,
    createSession, sessionAccount, revokeSession, listAccounts, accountExists, scheduledSlot,
    scopeHash, getBaseline, setBaseline, listBaselines, setLearningEvidence,
    markLearningEvidenceUnknownForScope, markLearningEvidenceUnknownForActivity, setTrainingLearningStatus, setTrainingExamStatus,
    listTrainingAnomalies, saveAnomalyCheck, markAnomaliesStale, markAnomalyStaleForActivity,
    markAnomaliesStaleForOtherEnrollments, deleteAnomalyForScope, setAnomalyScanState, anomalyScanState,
    getResource, upsertDiscoveredResource, unbatchedResources, listResources, countUnverifiedBaselineResources, historyRows, searchHistory,
    hasFreshAnomalyScope,
    promoteExistingResources, createBatchesForNew, getBatch, listBatches, saveBatchStatus, refreshBatchCounters,
    acquireInitial: (accountId, runId, timestamp, learnExisting = false) => tryAcquireInitial(accountId, null, runId, timestamp, learnExisting),
    updateScanProgress, setExistingLearningSelection,
    acquireScheduled, finishScan, markSkippedSlot, recordLoginAttempts, lastScan, progress,
    acquireCredentialLock, releaseCredentialLock,
    recover: acquireLockForRecovery,
    close() { db.close(); }
  };
}

function createPlatform(options = {}) {
  const apiOrigin = options.apiOrigin || DEFAULT_API_ORIGIN;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const allowed = new Set([LOGIN_ROUTE, TRAINING_ROUTE, ...CATALOG_ROUTES]);
  return async function platform({ route, body, token, signal }) {
    if (!allowed.has(route)) throw new ServiceError('UPSTREAM_ROUTE_REJECTED', 500);
    const controllerSignal = AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), signal].filter(Boolean));
    const response = await fetchImpl(apiOrigin + route, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: controllerSignal,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        ...(token ? { 'X-Auth-Token': `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
    if (!response.body) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_UPSTREAM_BYTES) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks, size).toString('utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502); }
    if (route !== LOGIN_ROUTE && Number(parsed?.code) === -1 && parsed?.message === '账号在其他设备登录' && parsed?.data == null) {
      throw new ServiceError('PLATFORM_AUTH_EXPIRED', 401);
    }
    if (!response.ok || !parsed || typeof parsed !== 'object' || Number(parsed.code) !== 200) {
      throw new ServiceError(route === LOGIN_ROUTE ? 'LOGIN_FAILED' : 'UPSTREAM_UNAVAILABLE', route === LOGIN_ROUTE ? 401 : 502);
    }
    return parsed;
  };
}

function loginPayload(orgCode, username, password) {
  return {
    orgCode: encryptLoginField(orgCode),
    username: encryptLoginField(username),
    password: encryptLoginField(password),
    openId: null,
    userInfo: null,
    platform: 'Android'
  };
}

function verifiedLogin(result, expected = null) {
  const data = result?.data;
  const token = typeof data?.token === 'string' ? data.token : '';
  const user = data?.user && typeof data.user === 'object' && !Array.isArray(data.user) ? data.user : null;
  const userId = safeId(user?.id);
  const returnedOrgs = [
    user?.orgCode, user?.organizationCode, data?.orgCode, data?.organizationCode
  ].map(value => safeString(value || '', 128).toUpperCase()).filter(Boolean);
  if (Number(result?.code) !== 200 || !token || token.length > 8192 || /[\r\n]/.test(token) || !userId) {
    throw new ServiceError('LOGIN_FAILED', 401);
  }
  const expectedOrg = safeString(expected?.orgCode || '', 128).toUpperCase();
  if (expectedOrg && returnedOrgs.some(returnedOrg => returnedOrg !== expectedOrg)) throw new ServiceError('ACCOUNT_MISMATCH', 409);
  // Some versions of the official login API do not echo the tenant on the user
  // object. In that case the successfully authenticated tenant-scoped request
  // is the organization proof; credential replacement additionally requires
  // the stable user ID below to match the stored account.
  if (expected && expected.userId && userId !== expected.userId) {
    throw new ServiceError('ACCOUNT_MISMATCH', 409);
  }
  return {
    token, userId,
    displayName: safeString(user.realName || user.nickname || user.name || '', 120)
  };
}

function evidenceFlag(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string' && value.length <= 40) return value;
  return 'UNKNOWN';
}

const TRAINING_EVIDENCE_FLAGS = Object.freeze([
  'onlineInd', 'examInd', 'operExamInd', 'faceTrainInd', 'liveInd', 'fileInd', 'classesInd',
  'enabledclasses', 'enabledClasses'
]);

function trainingHasUncataloguedRequirements(detail) {
  for (const key of ['resources', 'resource', 'activityPackageList', 'activityPackages', 'contents', 'content']) {
    const value = detail?.[key];
    if (Array.isArray(value) && value.length) return true;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) return true;
    if (typeof value === 'string' && value.trim()) return true;
  }
  for (const key of ['liveContent', 'liveUrl', 'liveStatus']) {
    const value = detail?.[key];
    if (value !== null && value !== undefined && String(value).trim()) return true;
  }
  return false;
}

async function readTrainingExamContent(postJson, training) {
  const records = [];
  const signatures = new Map();
  let page = 1;
  let pages = 1;
  try {
    for (; page <= MAX_EXAM_PAGES && page <= pages; page += 1) {
      const response = await postJson(TRAINING_EXAM_ROUTE, {
        page, limit: 50, params: { activityId: training.activityId, resourceType: 'PAPER', isControlTerminal: true }
      });
      if (Number(response?.code) !== 200) throw new Error('exam-response-invalid');
      const data = response?.data;
      if (!data || !Array.isArray(data.content)) throw new Error('exam-content-invalid');
      const current = data.number === undefined ? page : Number(data.number) + 1;
      const reportedPages = Number(data.totalPages);
      if (!Number.isInteger(reportedPages) || reportedPages < 0 || reportedPages > MAX_EXAM_PAGES || current !== page || typeof data.last !== 'boolean') {
        throw new Error('exam-pages-invalid');
      }
      if ((reportedPages === 0 && (data.content.length !== 0 || data.last !== true)) ||
          (reportedPages > 0 && data.last !== (page >= reportedPages))) throw new Error('exam-pages-inconsistent');
      pages = reportedPages;
      for (const row of data.content) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('exam-record-invalid');
        const returnedActivityId = row.activityId === undefined || row.activityId === null || String(row.activityId) === ''
          ? '' : safeId(String(row.activityId));
        if (row.activityId !== undefined && row.activityId !== null && String(row.activityId) !== '' && returnedActivityId !== training.activityId) {
          throw new Error('exam-identity-mismatch');
        }
        if (row.activityEnrollmentId !== undefined && row.activityEnrollmentId !== null && String(row.activityEnrollmentId) !== '' &&
            String(row.activityEnrollmentId) !== training.enrollmentId) throw new Error('exam-enrollment-mismatch');
        const evidence = {
          completionStatus: safeString(row.completionStatus || '', 80).toUpperCase(),
          scoreStatus: safeString(row.scoreStatus || row.recordScoreStatus || '', 80).toUpperCase(),
          studyStatus: safeString(row.studyStatus || '', 80).toUpperCase(),
          status: safeString(row.status || '', 80).toUpperCase(),
          title: safeString(row.resourceTitle || row.title || row.name || '', 180)
        };
        const id = safeId(String(row.id ?? row.resourceId ?? ''));
        const key = id || JSON.stringify(evidence);
        const signature = JSON.stringify(evidence);
        if (signatures.has(key) && signatures.get(key) !== signature) throw new Error('exam-record-conflict');
        if (!signatures.has(key)) { signatures.set(key, signature); records.push(evidence); }
      }
      if (reportedPages === 0 || page >= reportedPages) break;
      if (page === MAX_EXAM_PAGES) throw new Error('exam-catalog-too-large');
    }
    if (page > MAX_EXAM_PAGES && pages > MAX_EXAM_PAGES) throw new Error('exam-catalog-too-large');
    return { ok: true, records, pages };
  } catch (_) {
    return { ok: false, records: [], pages: null };
  }
}

async function inspectTraining(options = {}) {
  const { postJson, record, sourceUrl = COURSEWARE.SOURCE_URL } = options;
  const timestamp = typeof options.now === 'function' ? options.now() : Number.isFinite(options.now) ? options.now : Date.now();
  if (typeof postJson !== 'function') throw new TypeError('postJson is required');
  const activityId = safeId(record?.id ?? record?.activityId);
  const listEnrollment = safeId(record?.activityEnrollmentId);
  if (!activityId) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
  const detailResponse = await postJson(COURSEWARE.ROUTES.trainingDetail, { id: activityId });
  if (Number(detailResponse?.code) !== 200) throw new ServiceError('UPSTREAM_UNAVAILABLE', 502);
  const detail = detailResponse?.data?.detail || detailResponse?.data;
  const detailId = safeId(detail?.id ?? detail?.activityId);
  const enrollmentId = safeId(detail?.activityEnrollmentId);
  if (!detail || detailId !== activityId || !enrollmentId || (listEnrollment && listEnrollment !== enrollmentId)) {
    throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
  }
  const studyStatus = safeString(detail.studyStatus || record.studyStatus || record.status || '', 80).toUpperCase();
  if (studyStatus && !['NOTATTEMPT', 'PROGRESS', 'INCOMPLETE'].includes(studyStatus)) {
    throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
  }
  const flags = {};
  for (const key of TRAINING_EVIDENCE_FLAGS) {
    if (Object.prototype.hasOwnProperty.call(detail, key)) flags[key] = evidenceFlag(detail[key]);
  }
  const training = {
    activityId, enrollmentId,
    title: firstSafeTitle(180, record.title, record.name, detail.title, detail.name, '未命名培训'),
    studyStatus,
    doneNum: typeof (detail.doneNum ?? record.doneNum) === 'string' || typeof (detail.doneNum ?? record.doneNum) === 'number'
      ? String(detail.doneNum ?? record.doneNum).slice(0, 40) : '',
    deadlineAt: officialTrainingCutoff(detail),
    flags,
    hasUncataloguedRequirements: trainingHasUncataloguedRequirements(detail)
  };
  let catalog;
  try {
    catalog = await COURSEWARE.discoverCourseware({
      postJson,
      isCurrent: () => true,
      scope: { activityId: training.activityId, activityEnrollmentId: training.enrollmentId },
      sourceUrl,
      allowCompletedWithoutUrl: true
    });
  } catch (_) {
    catalog = { ok: false, partial: true, rootLast: false, pages: null, resources: [], catalogRows: [], courseDetails: [], unsupported: [], unavailableRows: [] };
  }
  const cleanEmpty = catalog && catalog.ok !== true && catalog.reason === 'no-resources' &&
    Array.isArray(catalog.resources) && catalog.resources.length === 0 &&
    Array.isArray(catalog.unsupported) && catalog.unsupported.length === 0 &&
    Array.isArray(catalog.unavailableRows) && catalog.unavailableRows.length === 0 &&
    catalog.rootLast === true && Number.isInteger(catalog.pages) && catalog.pages >= 0 && Array.isArray(catalog.catalogRows);
  const catalogComplete = Boolean((catalog?.ok === true || cleanEmpty) && Array.isArray(catalog?.catalogRows) &&
    Array.isArray(catalog?.unsupported) && catalog.unsupported.length === 0 &&
    Array.isArray(catalog?.unavailableRows) && catalog.unavailableRows.length === 0 && catalog.partial !== true &&
    catalog.rootLast === true && Number.isInteger(catalog.pages) && catalog.pages >= 0);
  const exams = await readTrainingExamContent(postJson, training);
  const resources = [];
  let resourcesValid = catalogComplete;
  for (const item of catalogComplete && Array.isArray(catalog.resources) ? catalog.resources : []) {
    const resourceActivityId = safeId(item.activityId);
    const resourceEnrollmentId = safeId(item.activityEnrollmentId);
    const resourceId = safeId(item.id);
    const type = safeString(item.type, 32).toUpperCase();
    if (!resourceActivityId || !resourceEnrollmentId || !resourceId || !type) { resourcesValid = false; continue; }
    resources.push({ activityId: resourceActivityId, enrollmentId: resourceEnrollmentId, resourceId, type,
      title: firstSafeTitle(240, item.title, item.name, '学习课件'), resourceKey: `${resourceActivityId}:${resourceEnrollmentId}:${resourceId}` });
  }
  const classification = classifyTrainingAnomaly({ training, now: timestamp, catalog: {
    ...catalog,
    cleanEmpty,
    catalogRows: Array.isArray(catalog?.catalogRows) ? catalog.catalogRows : [],
    unsupported: Array.isArray(catalog?.unsupported) ? catalog.unsupported : [],
    unavailableRows: Array.isArray(catalog?.unavailableRows) ? catalog.unavailableRows : []
  }, exams });
  return { training, catalog, catalogComplete: resourcesValid, resources, exams,
    hasExamContent: flagState(flags.examInd) === true || (exams.ok && exams.records.length > 0) ? true :
      exams.ok && exams.records.length === 0 && Object.hasOwn(flags, 'examInd') && flagState(flags.examInd) === false ? false : null,
    examStatus: classifyTrainingExamStatus(training, exams), anomaly: classification };
}

async function verifyTrainingCompleted(postJson, anomaly) {
  try {
    const response = await postJson(COURSEWARE.ROUTES.trainingDetail, { id: anomaly.activityId });
    if (Number(response?.code) !== 200) return false;
    const detail = response?.data?.detail || response?.data;
    const activityId = safeId(detail?.id ?? detail?.activityId);
    const enrollmentId = safeId(detail?.activityEnrollmentId);
    const status = safeString(detail?.studyStatus || detail?.status || '', 80).toUpperCase();
    return activityId === anomaly.activityId && enrollmentId === anomaly.enrollmentId && status === 'COMPLETED';
  } catch (_) {
    return false;
  }
}

function errorMessage(code) {
  const messages = {
    INVALID_REQUEST: '请求格式无效。', CONSENT_REQUIRED: '请先阅读并同意服务说明。',
    AUTH_REQUIRED: '登录状态已过期，请重新登录。', PLATFORM_AUTH_EXPIRED: '官方平台登录已失效，请重新登录。', LOGIN_FAILED: '官方账号登录失败，请检查组织代码、账号和密码。',
    ACCOUNT_MISMATCH: '新凭据对应的官方账号与当前账号不一致。', ORIGIN_REJECTED: '请求来源无效。',
    CSRF_REJECTED: '请求校验失败，请刷新页面后重试。', BODY_TOO_LARGE: '请求内容过大。',
    METHOD_NOT_ALLOWED: '请求方法不支持。', NOT_FOUND: '未找到请求的接口。', RATE_LIMITED: '操作过于频繁，请稍后再试。',
    SCAN_BUSY: '当前学习目录正在检查，请稍后再试。', UPSTREAM_UNAVAILABLE: '官方服务暂时无法读取，请稍后再试。',
    UPSTREAM_RESPONSE_INVALID: '官方服务返回内容无法核验。', SERVICE_UNAVAILABLE: '托管服务暂时无法安全处理请求。',
    REQUEST_FAILED: '请求暂时无法完成。'
  };
  return messages[code] || messages.REQUEST_FAILED;
}

function createService(options = {}) {
  const origin = expectedHttpsOrigin(options.origin ?? (process.env.ZG_MANAGED_ORIGIN || DEFAULT_ORIGIN));
  const scheduleEnabled = options.scheduleEnabled === undefined
    ? process.env.ZG_MANAGED_SCHEDULE_ENABLED !== '0'
    : options.scheduleEnabled !== false;
  const now = options.now || (() => Date.now());
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const dataDir = options.dataDir || process.env.ZG_MANAGED_LEARNING_DATA || '/var/lib/zg-managed-learning';
  const store = options.store || openStore(dataDir);
  const platform = options.platform || createPlatform(options);
  const worker = options.worker || createWorker({
    dataDir: path.join(dataDir, 'worker'),
    ...(options.workerUpstream ? { upstream: options.workerUpstream } : {}),
    ...(options.workerNow ? { now: options.workerNow } : {}),
    ...(options.workerWait ? { wait: options.workerWait } : {})
  });
  const serverAbort = new AbortController();
  const activeScans = new Map();
  const queueRetryAt = new Map();
  const dispatchingAccounts = new Set();
  const unknownRecheckAt = new Map();
  const preparationRetryAt = new Map();
  const loginRates = new Map();
  let schedulerTimer = null;
  let schedulerBusy = false;
  let closing = false;
  let bootError = false;

  function rateLimit(request, timestamp, subject = '', bucket = 'default', subjectLimit = 8) {
    const remote = typeof request.socket.remoteAddress === 'string' ? request.socket.remoteAddress : 'unknown';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const forwarded = options.trustForwardedFor !== false && loopback && typeof request.headers['x-forwarded-for'] === 'string'
      ? request.headers['x-forwarded-for'].split(',')[0].trim() : '';
    const client = forwarded && net.isIP(forwarded) ? forwarded : remote;
    const keys = [
      { value: `${bucket}\u0000client\u0000${client}`, limit: 60 },
      ...(subject ? [{ value: `${bucket}\u0000subject\u0000${subject}`, limit: subjectLimit }] : [])
    ];
    for (const entry of keys) {
      const key = store.digest(`login-rate\u0000${entry.value}`);
      const current = loginRates.get(key);
      if (!current || timestamp - current.startedAt > 15 * 60 * 1000) loginRates.set(key, { startedAt: timestamp, count: 1 });
      else if (current.count >= entry.limit) throw new ServiceError('RATE_LIMITED', 429);
      else current.count += 1;
    }
    if (loginRates.size > 4096) {
      for (const [key, value] of loginRates) if (timestamp - value.startedAt > 15 * 60 * 1000) loginRates.delete(key);
    }
  }

  async function callCatalog(route, body, token) {
    if (!CATALOG_ROUTES.has(route)) throw new ServiceError('UPSTREAM_ROUTE_REJECTED', 500);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await platform({ route, body, token, signal: serverAbort.signal });
        if (!response || Number(response.code) !== 200) throw new ServiceError('UPSTREAM_UNAVAILABLE', 502);
        return response;
      } catch (error) {
        const temporary = error?.code === 'UPSTREAM_UNAVAILABLE' || error?.name === 'TimeoutError' || error?.name === 'TypeError';
        if (!temporary || attempt === 2 || closing || serverAbort.signal.aborted) throw error;
        await wait((attempt + 1) * 500);
      }
    }
  }

  async function authenticate(orgCode, username, password, expected = null) {
    const result = await platform({ route: LOGIN_ROUTE, body: loginPayload(orgCode, username, password), signal: serverAbort.signal });
    return verifiedLogin(result, expected);
  }

  async function authenticateStored(account, runId = null) {
    let attempts = 0;
    let lastError = null;
    for (let i = 0; i < 3; i += 1) {
      attempts = i + 1;
      try {
        const auth = await authenticate(account.orgCode, account.username, account.password, { orgCode: account.orgCode, userId: account.userId });
        store.saveToken(account.id, auth.token, now());
        if (runId) store.recordLoginAttempts(runId, attempts);
        return { auth, attempts };
      } catch (error) {
        lastError = error;
        if (error instanceof ServiceError && error.code === 'ACCOUNT_MISMATCH') {
          if (runId) store.recordLoginAttempts(runId, attempts);
          error.attempts = attempts;
          throw error;
        }
        if (i < LOGIN_RETRY_DELAYS.length) await wait(LOGIN_RETRY_DELAYS[i]);
      }
    }
    if (runId) store.recordLoginAttempts(runId, attempts);
    const failure = lastError instanceof ServiceError && lastError.code === 'LOGIN_FAILED' ? lastError : new ServiceError('LOGIN_FAILED', 401);
    failure.attempts = attempts;
    throw failure;
  }

  async function listIncompleteTrainings(token, onPage = null) {
    const output = new Map();
    let page = 1;
    let pages = 1;
    for (; page <= MAX_TRAINING_PAGES && page <= pages; page += 1) {
      const response = await callCatalog(TRAINING_ROUTE, { page, limit: 10, params: { status: 'INCOMPLETE' } }, token);
      const content = response?.data?.content;
      if (!content || !Array.isArray(content.records)) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
      const current = Number(content.current || page);
      const reportedPages = Number(content.pages || current);
      if (current !== page || !Number.isInteger(reportedPages) || reportedPages < 0 || reportedPages > MAX_TRAINING_PAGES) {
        throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
      }
      pages = reportedPages;
      for (const record of content.records) {
        const id = safeId(record?.id ?? record?.activityId);
        if (!id) { output.set(`invalid:${output.size}`, record); continue; }
        const existing = output.get(id);
        if (existing) {
          const beforeEnrollment = safeId(existing.activityEnrollmentId);
          const nextEnrollment = safeId(record.activityEnrollmentId);
          if (beforeEnrollment && nextEnrollment && beforeEnrollment !== nextEnrollment) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
          continue;
        }
        output.set(id, record);
      }
      if (typeof onPage === 'function') onPage({ page, pages, listed: output.size });
      if (pages === 0 || current >= pages) break;
    }
    if (page > MAX_TRAINING_PAGES && pages > MAX_TRAINING_PAGES) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
    return [...output.values()];
  }

  async function inspectTrainingForAccount(record, token) {
    return inspectTraining({ record, now, postJson: (route, body) => callCatalog(route, body, token) });
  }

  async function reconcileBatches(accountId) {
    const batches = store.listBatches(accountId);
    for (const batch of batches) {
      let job = batch.workerJobId ? await worker.getFilteredJob(batch.id) : null;
      if (!job) job = await worker.getFilteredJob(batch.id);
      if (job) store.refreshBatchCounters(batch.id, job, now());
      else if (batch.status === 'queued') continue;
    }
  }

  async function dispatchBatches(account, token) {
    if (dispatchingAccounts.has(account.id)) return;
    dispatchingAccounts.add(account.id);
    try {
    for (const batch of store.listBatches(account.id)) {
      if (!['queued', 'running'].includes(batch.status)) continue;
      const existing = await worker.getFilteredJob(batch.id);
      if (!existing) continue;
      store.refreshBatchCounters(batch.id, existing, now());
      if (!['completed', 'failed', 'unknown'].includes(existing.status)) return;
    }
    const batches = store.listBatches(account.id).filter(batch => batch.status === 'queued');
    for (const batch of batches) {
      let job = await worker.getFilteredJob(batch.id);
      if (!job) {
        if (store.hasFreshAnomalyScope(account.id, batch.scopeHash)) {
          store.saveBatchStatus(batch.id, { status: 'action_needed', resourceStatus: 'action_needed' }, now());
          continue;
        }
        try {
          job = await worker.enqueueFiltered({
            activityId: batch.activityId,
            activityEnrollmentId: batch.enrollmentId,
            token,
            resourceKeys: batch.resourceKeys,
            requestId: batch.id,
            allowVideo: batch.allowVideo === true
          });
        } catch (error) {
          const existing = await worker.getFilteredJob(batch.id);
          if (existing) job = existing;
          else {
            if (error?.code === 'QUEUE_FULL') return;
            const active = await worker.getActiveJob(batch.activityId, batch.enrollmentId);
            if (active && !['completed', 'failed', 'unknown'].includes(active.status)) return;
            if (active && (active.status === 'unknown' || active.status === 'failed')) {
              store.saveBatchStatus(batch.id, { status: 'action_needed', resourceStatus: 'action_needed' }, now());
              continue;
            }
            if (['RESOURCE_FILTER_REQUIRED', 'REQUEST_ID_CONFLICT', 'SCOPE_MISMATCH', 'SCOPE_UNVERIFIED', 'CATALOG_IDENTITY_MISMATCH'].includes(error?.code)) {
              store.saveBatchStatus(batch.id, { status: 'action_needed', resourceStatus: 'action_needed' }, now());
              continue;
            }
            throw new ServiceError('UPSTREAM_UNAVAILABLE', 502);
          }
        }
      }
      if (job) {
        store.refreshBatchCounters(batch.id, job, now());
        if (!['completed', 'failed', 'unknown'].includes(job.status)) return;
      }
    }
    } finally {
      dispatchingAccounts.delete(account.id);
    }
  }

  async function hasLiveWorkerBatch(accountId, { ignoreDispatch = false } = {}) {
    if (!ignoreDispatch && dispatchingAccounts.has(accountId)) return true;
    for (const batch of store.listBatches(accountId)) {
      if (batch.status !== 'queued' && batch.status !== 'running') continue;
      const job = await worker.getFilteredJob(batch.id);
      if (!job) continue; // Durable outbox rows with no worker job must be dispatched, not treated as a lock.
      store.refreshBatchCounters(batch.id, job, now());
      if (!['completed', 'failed', 'unknown'].includes(job.status)) return true;
    }
    return false;
  }

  async function runScan(accountId, options = {}) {
    const slotKey = options.slotKey || null;
    const runId = crypto.randomUUID();
    const timestamp = now();
    if (activeScans.has(accountId)) {
      if (slotKey) store.markSkippedSlot(accountId, slotKey, timestamp);
      throw new ServiceError('SCAN_BUSY', 409);
    }
    const acquired = options.initial
      ? store.acquireInitial(accountId, runId, timestamp, options.learnExisting === true)
      : store.acquireScheduled(accountId, slotKey, runId, timestamp);
    if (!acquired) {
      if (slotKey) store.markSkippedSlot(accountId, slotKey, timestamp);
      throw new ServiceError('SCAN_BUSY', 409);
    }
    const current = activeScans.get(accountId);
    if (current) {
      store.finishScan(runId, accountId, 'skipped', now(), 0, 'SCAN_BUSY');
      throw new ServiceError('SCAN_BUSY', 409);
    }
    const scanPromise = (async () => {
      let attempts = 0;
      let status = 'action_needed';
      let errorCode = null;
      let scheduledCount = 0;
      let unverifiedCount = 0;
      const freshResourcesByScope = new Map();
      let anomalyReadStarted = false;
      let anomalyCheckFinished = false;
      let checkedTrainingRows = 0;
      try {
        await reconcileBatches(accountId);
        if (!options.manualRefresh && await hasLiveWorkerBatch(accountId)) throw new ServiceError('SCAN_BUSY', 409);
        let account = store.getAccount(accountId);
        if (!account) throw new ServiceError('AUTH_REQUIRED', 401);
        let token = options.token || '';
        if (!token) {
          const result = await authenticateStored(account, runId);
          account = store.getAccount(accountId);
          token = result.auth.token;
          attempts = result.attempts;
        } else {
          attempts = 1;
          store.recordLoginAttempts(runId, attempts);
        }
        const pendingOutbox = store.listBatches(accountId).some(batch => batch.status === 'queued');
        if (pendingOutbox && !options.manualRefresh) {
          await dispatchBatches(account, token);
          await reconcileBatches(accountId);
        }
        if (!options.manualRefresh && await hasLiveWorkerBatch(accountId)) throw new ServiceError('SCAN_BUSY', 409);

        anomalyReadStarted = true;
        store.transaction(() => {
          store.markAnomaliesStale(accountId);
          store.setAnomalyScanState(accountId, 'partial', now());
        });
        const rows = await listIncompleteTrainings(token, () => {
          store.updateScanProgress(accountId, runId, { discovering: true }, now());
        });
        store.updateScanProgress(accountId, runId, { stage: 'checking', total: rows.length }, now());
        const presentActivities = new Set(rows.map(record => safeId(record?.id ?? record?.activityId)).filter(Boolean));
        const hasInvalidListedActivity = rows.some(record => !safeId(record?.id ?? record?.activityId));
        let anomalyFailures = 0;
        if (hasInvalidListedActivity) {
          store.markAnomaliesStale(accountId);
          anomalyFailures += 1;
        } else {
          const cachedAnomalies = store.listTrainingAnomalies(accountId);
          const anomaliesByScope = new Map(cachedAnomalies.map(item => [item.scopeHash, item]));
          const unbatchedScopes = new Set(store.unbatchedResources(accountId).map(item => item.scopeHash));
          const baselinesToVerify = store.listBaselines(accountId).filter(item =>
            !presentActivities.has(item.activityId) &&
            (item.examStatus === 'pending' || (item.hasExamContent === true && item.examStatus !== 'passed') || anomaliesByScope.has(item.scopeHash) || unbatchedScopes.has(item.scopeHash)));
          for (const baseline of baselinesToVerify) {
            const cached = anomaliesByScope.get(baseline.scopeHash);
            const officiallyComplete = await verifyTrainingCompleted((route, body) => callCatalog(route, body, token), baseline);
            if (officiallyComplete) {
              store.deleteAnomalyForScope(accountId, baseline.scopeHash);
              store.setTrainingLearningStatus(accountId, baseline.scopeHash, 'completed');
              if (baseline.examStatus === 'pending' || baseline.hasExamContent === true) {
                const examEvidence = await readTrainingExamContent((route, body) => callCatalog(route, body, token), baseline);
                store.setTrainingExamStatus(accountId, baseline.scopeHash, classifyTrainingExamStatus(baseline, examEvidence));
              }
            }
            else {
              if (baseline.examStatus === 'pending') store.setTrainingExamStatus(accountId, baseline.scopeHash, 'unknown');
              if (cached) {
                store.markAnomalyStaleForActivity(accountId, cached.activityId);
                anomalyFailures += 1;
              } else if (baseline.examStatus === 'pending') anomalyFailures += 1;
            }
          }
        }
        let successfulRows = 0;
        let firstError = null;
        for (const record of rows) {
          const listedActivityId = safeId(record?.id ?? record?.activityId);
          if (listedActivityId) store.markLearningEvidenceUnknownForActivity(accountId, listedActivityId);
          let training = null;
          let scopeHash = '';
          let inspection = null;
          try {
            inspection = await inspectTrainingForAccount(record, token);
            training = inspection.training;
            scopeHash = store.scopeHash(accountId, training.activityId, training.enrollmentId);
            store.markAnomaliesStaleForOtherEnrollments(accountId, training.activityId, training.enrollmentId);
            if (!inspection.anomaly.complete || !inspection.exams.ok) {
              if (inspection.anomaly.code !== 'TRAINING_OVERDUE') store.markAnomalyStaleForActivity(accountId, training.activityId);
              anomalyFailures += 1;
            }
            const evidence = learningEvidence(inspection);
            const oldBaseline = store.getBaseline(scopeHash);
            const hasSuccessfulSnapshot = oldBaseline?.completedAt !== null && oldBaseline?.completedAt !== undefined;
            const isBaseline = !hasSuccessfulSnapshot && !store.hasInitialBaseline(accountId);
            if (!hasSuccessfulSnapshot) {
              store.setBaseline({ ...training, scopeHash, accountId, status: 'running', examStatus: inspection.examStatus, hasExamContent: inspection.hasExamContent, completedAt: null, updatedAt: now() });
            }
            if (!inspection.catalogComplete && inspection.anomaly.code === 'TRAINING_OVERDUE') {
              // A verified expired enrollment is excluded, not a failed read of
              // the other eligible trainings. Never seed its partial resources.
              store.transaction(() => {
                store.setBaseline({ ...training, scopeHash, accountId, status: 'excluded', learningStatus: 'unknown',
                  examStatus: inspection.examStatus, hasExamContent: inspection.hasExamContent,
                  completedAt: oldBaseline?.completedAt ?? null, updatedAt: now() });
                store.saveAnomalyCheck({ accountId, scopeHash, activityId: training.activityId, enrollmentId: training.enrollmentId,
                  trainingTitle: training.title, code: 'TRAINING_OVERDUE', evidence: inspection.anomaly.evidence, checkedAt: now() });
                store.updateScanProgress(accountId, runId, { increment: true, outcome: 'skipped', result: {
                  title: training.title, status: 'skipped', reason: '官方平台显示培训已超过有效期限'
                } }, now());
              });
              successfulRows += 1;
              checkedTrainingRows += 1;
              continue;
            }
            if (!inspection.catalogComplete) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
            // Persist one fully verified training catalog atomically. Failed reads never seed/advance a baseline.
            store.transaction(() => {
              for (const resource of inspection.resources) {
                store.upsertDiscoveredResource({
                  ...resource, scopeHash, accountId, title: resource.title,
                  trainingTitle: training.title, isBaseline, updatedAt: now()
                });
              }
              store.setBaseline({ ...training, scopeHash, accountId, status: 'complete', learningStatus: evidence.learningStatus,
                examStatus: inspection.examStatus,
                hasExamContent: inspection.hasExamContent,
                completedAt: oldBaseline?.completedAt ?? now(), updatedAt: now() });
              store.setLearningEvidence({ accountId, scopeHash, learningStatus: evidence.learningStatus, resources: evidence.resources });
              if ((inspection.anomaly.complete && inspection.exams.ok) || inspection.anomaly.code === 'TRAINING_OVERDUE') {
                store.saveAnomalyCheck({ accountId, scopeHash, activityId: training.activityId, enrollmentId: training.enrollmentId,
                  trainingTitle: training.title, code: inspection.anomaly.code, evidence: inspection.anomaly.evidence, checkedAt: now() });
              }
              const scanOutcome = inspection.anomaly.code === 'TRAINING_OVERDUE' ? 'skipped' : inspection.exams.ok ? 'success' : 'failed';
              store.updateScanProgress(accountId, runId, { increment: true, outcome: scanOutcome, result: {
                title: training.title,
                status: scanOutcome === 'skipped' ? 'skipped' : scanOutcome === 'success' ? 'verified' : 'unverified',
                reason: scanOutcome === 'skipped' ? '官方平台显示培训已超过有效期限' : scanOutcome === 'failed' ? '考试信息未能完整读取' : ''
              } }, now());
            });
            successfulRows += 1;
            checkedTrainingRows += 1;
            freshResourcesByScope.set(scopeHash, new Set(inspection.resources.map(resource => resource.resourceKey)));
          } catch (error) {
            firstError ||= error;
            const activityId = safeId(record?.id ?? record?.activityId);
            store.transaction(() => {
              if (activityId) store.markAnomalyStaleForActivity(accountId, activityId);
              if (inspection?.anomaly?.code === 'TRAINING_OVERDUE' && training && scopeHash) {
                store.saveAnomalyCheck({ accountId, scopeHash, activityId: training.activityId, enrollmentId: training.enrollmentId,
                  trainingTitle: training.title, code: 'TRAINING_OVERDUE', evidence: inspection.anomaly.evidence, checkedAt: now() });
              }
              if (scopeHash) store.markLearningEvidenceUnknownForScope(accountId, scopeHash);
              else if (activityId) store.markLearningEvidenceUnknownForActivity(accountId, activityId);
              if (training && scopeHash) {
                const currentBaseline = store.getBaseline(scopeHash);
                if (!currentBaseline?.completedAt) {
                  try { store.setBaseline({ ...training, scopeHash, accountId, status: 'action_needed', learningStatus: 'unknown', completedAt: null, updatedAt: now() }); } catch (_) {}
                }
              }
              const reason = error?.code === 'PLATFORM_AUTH_EXPIRED' ? '官方平台登录已失效，请重新登录' :
                error?.code === 'UPSTREAM_UNAVAILABLE' ? '官方平台暂时无法读取，请稍后重试' :
                  error?.code === 'UPSTREAM_RESPONSE_INVALID' ? '平台返回的信息不完整，暂时无法核实' : '本项信息未能核实，请刷新看板重试';
              store.updateScanProgress(accountId, runId, { increment: true, outcome: 'failed', result: {
                title: training?.title || firstSafeTitle(180, record?.title, record?.name, '未命名培训'),
                status: 'unverified', reason
              } }, now());
            });
            anomalyFailures += 1;
            checkedTrainingRows += 1;
          }
        }
        const hasStaleAnomaly = store.listTrainingAnomalies(accountId).some(item => item.stale);
        store.setAnomalyScanState(accountId, anomalyFailures || hasStaleAnomaly ? 'partial' : 'checked', now());
        anomalyCheckFinished = true;
        const baselineComplete = firstError === null && successfulRows === rows.length;
        const scheduleFreshResources = async () => {
          const verifiedHashes = store.unbatchedResources(accountId).filter(resource => {
            const keys = freshResourcesByScope.get(resource.scopeHash);
            return keys instanceof Set && keys.has(resource.resourceKey);
          }).map(resource => resource.resourceHash);
          if (!verifiedHashes.length) return;
          store.createBatchesForNew(accountId, now(), verifiedHashes);
          account = store.getAccount(accountId);
          await dispatchBatches(account, token);
        };
        const scheduleExistingResources = async () => {
          let promoted = [];
          store.transaction(() => {
            promoted = store.promoteExistingResources(accountId, freshResourcesByScope, now());
            store.createBatchesForNew(accountId, now(), promoted.map(item => item.resourceHash));
            store.setExistingLearningSelection(runId, promoted.map(item => item.resourceHash));
          });
          scheduledCount = promoted.length;
          account = store.getAccount(accountId);
          await dispatchBatches(account, token);
        };
        if (!baselineComplete && options.scheduled) await scheduleFreshResources();
        if (!baselineComplete && options.learnExisting) await scheduleExistingResources();
        if (firstError || !baselineComplete) throw firstError || new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
        if (!store.hasInitialBaseline(accountId)) store.markInitialBaseline(accountId, now());
        if (options.scheduled) {
          await scheduleFreshResources();
        } else if (options.learnExisting) {
          await scheduleExistingResources();
        }
        store.latchCompletedExistingContent(accountId, now());
        status = 'complete';
      } catch (error) {
        const partialAnomalyResults = anomalyReadStarted && checkedTrainingRows > 0;
        const anomalyStateUnavailable = (!partialAnomalyResults && anomalyReadStarted && !anomalyCheckFinished) ||
          (!anomalyReadStarted && error?.code !== 'SCAN_BUSY');
        if (partialAnomalyResults) {
          try { store.setAnomalyScanState(accountId, 'partial', now()); } catch (_) {}
        } else if (anomalyStateUnavailable) {
          try {
            store.markAnomaliesStale(accountId);
            store.setAnomalyScanState(accountId, 'unavailable', now());
          } catch (_) {}
        }
        if (Number.isInteger(error?.attempts)) attempts = error.attempts;
        status = error instanceof ServiceError && error.code === 'SCAN_BUSY' ? 'skipped' : 'action_needed';
        errorCode = error instanceof ServiceError ? error.code : 'UPSTREAM_UNAVAILABLE';
      } finally {
        store.finishScan(runId, accountId, status, now(), attempts, errorCode);
        activeScans.delete(accountId);
      }
      if (options.learnExisting) unverifiedCount = store.countUnverifiedBaselineResources(accountId);
      return { status, scannedAt: now(), loginAttempts: attempts, errorCode,
        ...(options.learnExisting ? { scheduledCount, unverifiedCount } : {}) };
    })();
    activeScans.set(accountId, scanPromise);
    return scanPromise;
  }

  function nextScanAt(timestamp) {
    const parts = shanghaiParts(timestamp);
    for (const slot of SCHEDULE.scanTimes) {
      const [hour, minute] = slot.split(':').map(Number);
      const candidate = shanghaiInstant(parts.year, parts.month, parts.day, hour, minute);
      if (candidate > timestamp) return formatShanghai(candidate);
    }
    const tomorrow = new Date(shanghaiInstant(parts.year, parts.month, parts.day, 0) + 24 * 60 * 60 * 1000);
    const next = shanghaiParts(tomorrow.getTime());
    const [hour, minute] = SCHEDULE.scanTimes[0].split(':').map(Number);
    return formatShanghai(shanghaiInstant(next.year, next.month, next.day, hour, minute));
  }

  function publicSession(account) {
    const timestamp = now();
    const progress = store.progress(account.id);
    const last = store.lastScan(account.id);
    return {
      ok: true,
      authenticated: true,
      user: { orgCode: account.orgCode, usernameMasked: account.usernameMasked },
      consent: { accepted: true, version: account.consentVersion, acceptedAt: formatShanghai(account.consentAcceptedAt) },
      schedule: { ...SCHEDULE, nextScanAt: nextScanAt(timestamp), lastScanAt: last.scannedAt === null ? null : formatShanghai(last.scannedAt) },
      progress: {
        ...progress,
        lastScan: { ...progress.lastScan, scannedAt: progress.lastScan.scannedAt === null ? null : formatShanghai(progress.lastScan.scannedAt) }
      }
    };
  }

  function parseCookie(request) {
    const header = request.headers.cookie;
    if (typeof header !== 'string' || header.length > 4096) return '';
    let found = '';
    for (const item of header.split(';')) {
      const index = item.indexOf('=');
      if (index < 0) continue;
      if (item.slice(0, index).trim() !== COOKIE_NAME) continue;
      if (found) return '';
      const value = item.slice(index + 1).trim();
      if (!SESSION_COOKIE_RE.test(value)) return '';
      found = value;
    }
    return found;
  }

  function requireOrigin(request, mutation) {
    const requestOrigin = request.headers.origin;
    if (mutation) {
      if (requestOrigin !== origin) throw new ServiceError('ORIGIN_REJECTED', 403);
      return;
    }
    if (requestOrigin !== undefined && requestOrigin !== origin) throw new ServiceError('ORIGIN_REJECTED', 403);
    if (requestOrigin === undefined && request.headers['sec-fetch-site'] !== 'same-origin') throw new ServiceError('ORIGIN_REJECTED', 403);
  }

  function send(response, status, value, headers = {}) {
    if (response.headersSent) return;
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache', Expires: '0', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers
    });
    response.end(body);
  }

  async function readJson(request, allowedKeys, optionalKeys = []) {
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) throw new ServiceError('INVALID_REQUEST', 400);
    const contentLength = Number(request.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new ServiceError('BODY_TOO_LARGE', 413);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new ServiceError('BODY_TOO_LARGE', 413);
      chunks.push(chunk);
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw new ServiceError('INVALID_REQUEST', 400); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ServiceError('INVALID_REQUEST', 400);
    const keys = Object.keys(parsed);
    if (keys.some(key => !allowedKeys.includes(key) && !optionalKeys.includes(key)) || allowedKeys.some(key => !Object.prototype.hasOwnProperty.call(parsed, key))) throw new ServiceError('INVALID_REQUEST', 400);
    return parsed;
  }

  async function requireSession(request) {
    const raw = parseCookie(request);
    if (!raw) throw new ServiceError('AUTH_REQUIRED', 401);
    const account = store.sessionAccount(raw, now());
    if (!account) throw new ServiceError('AUTH_REQUIRED', 401);
    return { raw, account };
  }

  function setSessionCookie(raw) {
    return `${COOKIE_NAME}=${raw}; Path=/zg; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`;
  }

  async function loginHandler(request, response) {
    requireOrigin(request, true);
    const input = await readJson(request, ['orgCode', 'username', 'password', 'consent'], ['videoConsent']);
    const orgCode = safeString(input.orgCode, 128).toUpperCase();
    const username = safeString(input.username, 256);
    const password = typeof input.password === 'string' && input.password.length > 0 && input.password.length <= 512 && !/[\u0000-\u001f\u007f]/.test(input.password) ? input.password : '';
    if (!orgCode || !username || !password) throw new ServiceError('INVALID_REQUEST', 400);
    if (input.consent !== true) throw new ServiceError('CONSENT_REQUIRED', 400);
    if (input.videoConsent !== undefined && typeof input.videoConsent !== 'boolean') throw new ServiceError('INVALID_REQUEST', 400);
    rateLimit(request, now(), store.digest(`${orgCode.toUpperCase()}\u0000${username.toLowerCase()}`));
    const auth = await authenticate(orgCode, username, password, { orgCode, userId: null });
    const timestamp = now();
    const accountKey = store.digest(`${orgCode}\u0000${auth.userId}`);
    const existing = store.findAccountByKey(accountKey);
    const lockId = existing ? crypto.randomUUID() : '';
    if (existing && !store.acquireCredentialLock(existing.id, lockId, timestamp)) throw new ServiceError('SCAN_BUSY', 409);
    let accountId;
    try {
      accountId = store.saveAccount({ orgCode, username, password, token: auth.token, userId: auth.userId, displayName: auth.displayName, allowVideo: input.videoConsent === true }, timestamp);
    } finally {
      if (existing) store.releaseCredentialLock(existing.id, lockId);
    }
    const raw = crypto.randomBytes(32).toString('base64url');
    store.createSession(raw, accountId, timestamp);
    const account = store.getAccount(accountId);
    if (options.autoBaseline !== false) void runScan(accountId, { initial: true, token: auth.token }).catch(() => {});
    send(response, 200, publicSession(account), { 'Set-Cookie': setSessionCookie(raw) });
  }

  async function sessionHandler(request, response) {
    requireOrigin(request, false);
    const { account } = await requireSession(request);
    send(response, 200, publicSession(account));
  }

  async function examIdentityHandler(request, response) {
    requireOrigin(request, false);
    const { account } = await requireSession(request);
    const userId = safeId(account.userId);
    if (!userId) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
    await callCatalog(TRAINING_ROUTE, { page: 1, limit: 1, params: { status: 'INCOMPLETE' } }, account.token);
    const latest = store.getAccount(account.id);
    if (!latest || latest.userId !== userId || latest.token !== account.token) throw new ServiceError('SCAN_BUSY', 409);
    send(response, 200, { userId, platformToken: account.token });
  }

  async function examContextHandler(request, response, url) {
    requireOrigin(request, false);
    const { account } = await requireSession(request);
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 1 || entries[0][0] !== 'group' || !/^[A-Za-z0-9_-]{43}$/.test(entries[0][1])) throw new ServiceError('INVALID_REQUEST', 400);
    const group = entries[0][1];
    const matches = store.listBaselines(account.id).filter(item => store.digest(`public-training\u0000${account.id}\u0000${item.scopeHash}`) === group);
    if (matches.length !== 1) throw new ServiceError('NOT_FOUND', 404);
    const training = matches[0];
    const userId = safeId(account.userId);
    if (!userId || !safeId(training.activityId) || !safeId(training.enrollmentId)) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
    const records = new Map();
    let page = 1, pages = 1;
    do {
      const result = await callCatalog(TRAINING_EXAM_ROUTE, {page, limit:50, params:{activityId:training.activityId, resourceType:'PAPER', isControlTerminal:true}}, account.token);
      const data = result.data;
      const reportedPages = Number(data?.totalPages);
      if (!Array.isArray(data?.content) || !Number.isInteger(reportedPages) || reportedPages < 0 || reportedPages > 10 ||
          (data.number != null && Number(data.number) + 1 !== page) || typeof data.last !== 'boolean' ||
          (reportedPages === 0 && (data.content.length || !data.last)) || (reportedPages > 0 && data.last !== (page >= reportedPages))) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
      pages = reportedPages;
      for (const row of data.content) {
        const resourceId = typeof row?.resourceId === 'string' ? safeId(row.resourceId) : '';
        if (!resourceId || (row.activityId != null && String(row.activityId) !== training.activityId) ||
            (row.activityEnrollmentId != null && String(row.activityEnrollmentId) !== training.enrollmentId)) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
        const title = safeString(row.resourceTitle || row.title || row.name || '', 160) || '考试';
        if (records.has(resourceId) && records.get(resourceId).title !== title) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
        records.set(resourceId, {activityId:training.activityId, resourceId, title});
        if (records.size > 20) throw new ServiceError('UPSTREAM_RESPONSE_INVALID', 502);
      }
      page++;
    } while (page <= pages);
    send(response, 200, {userId, group, records:[...records.values()]});
  }

  async function progressHandler(request, response) {
    requireOrigin(request, false);
    const { account } = await requireSession(request);
    const value = publicSession(account);
    send(response, 200, { ok: true, schedule: value.schedule, progress: value.progress });
  }

  async function refreshHandler(request, response) {
    requireOrigin(request, true);
    const { account } = await requireSession(request);
    await readJson(request, []);
    if (activeScans.has(account.id)) return send(response, 202, { ok: true, alreadyRunning: true });
    rateLimit(request, now(), account.accountKey, 'refresh', 30);
    const scan = runScan(account.id, { initial: true, token: account.token, manualRefresh: true });
    if (!activeScans.has(account.id)) await scan;
    void scan.catch(() => {});
    return send(response, 202, { ok: true, alreadyRunning: false });
  }

  async function learnExistingHandler(request, response) {
    requireOrigin(request, true);
    const { account } = await requireSession(request);
    rateLimit(request, now(), account.accountKey);
    await readJson(request, []);
    const scan = await runScan(account.id, { initial: true, learnExisting: true });
    if (scan.status !== 'complete' && !(scan.status === 'action_needed' && scan.scheduledCount > 0)) {
      const code = scan.errorCode || 'UPSTREAM_UNAVAILABLE';
      const status = code === 'SCAN_BUSY' ? 409 : code === 'LOGIN_FAILED' ? 401 : code === 'ACCOUNT_MISMATCH' ? 409 : 502;
      throw new ServiceError(code, status);
    }
    const latest = publicSession(store.getAccount(account.id));
    send(response, 200, {
      ok: true,
      partial: scan.status !== 'complete',
      ...(scan.status !== 'complete' ? { warningCode: scan.errorCode } : {}),
      scheduled: scan.scheduledCount > 0,
      scheduledCount: scan.scheduledCount,
      unverifiedCount: scan.unverifiedCount,
      progress: latest.progress,
      schedule: latest.schedule
    });
  }

  async function historyHandler(request, response, url) {
    requireOrigin(request, false);
    const { account } = await requireSession(request);
    const query = parseHistoryQuery(url);
    const result = store.searchHistory(account.id, query);
    const total = result.total;
    const pages = Math.ceil(total / query.pageSize);
    const items = result.items.map(item => ({
      eventId: item.eventId,
      id: item.id,
      name: item.name,
      trainingTitle: item.trainingTitle,
      status: item.status,
      previousStatus: item.previousStatus,
      event: item.event,
      recordedAt: formatShanghai(item.recordedAt)
    }));
    send(response, 200, { ok: true, items, pagination: { page: query.page, pageSize: query.pageSize, total, pages } });
  }

  async function credentialsHandler(request, response) {
    requireOrigin(request, true);
    const { account } = await requireSession(request);
    rateLimit(request, now(), account.accountKey);
    const input = await readJson(request, ['password']);
    const password = typeof input.password === 'string' && input.password.length > 0 && input.password.length <= 512 && !/[\u0000-\u001f\u007f]/.test(input.password) ? input.password : '';
    if (!password) throw new ServiceError('INVALID_REQUEST', 400);
    const lockId = crypto.randomUUID();
    if (!store.acquireCredentialLock(account.id, lockId, now())) throw new ServiceError('SCAN_BUSY', 409);
    try {
      const auth = await authenticate(account.orgCode, account.username, password, { orgCode: account.orgCode, userId: account.userId });
      store.updateCredentials(account.id, { orgCode: account.orgCode, username: account.username, password,
        token: auth.token, userId: account.userId, displayName: auth.displayName || account.displayName }, now());
      send(response, 200, { ok: true, credentialsUpdated: true });
    } finally {
      store.releaseCredentialLock(account.id, lockId);
    }
  }

  async function logoutHandler(request, response) {
    requireOrigin(request, true);
    const { raw } = await requireSession(request);
    await readJson(request, []);
    store.revokeSession(raw);
    send(response, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/zg; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict` });
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    try {
      if (bootError || closing) throw new ServiceError('SERVICE_UNAVAILABLE', 503);
      if (typeof request.url !== 'string' || request.url.length > 4096) throw new ServiceError('INVALID_REQUEST', 400);
      const url = new URL(request.url, 'http://127.0.0.1');
      const historyPath = `${API_PREFIX}/history`;
      if (url.hash || (url.search && ![historyPath, `${API_PREFIX}/exam-context`].includes(url.pathname))) throw new ServiceError('INVALID_REQUEST', 400);
      if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw new ServiceError('NOT_FOUND', 404);
      if (url.pathname === historyPath) {
        if (request.method !== 'GET') throw new ServiceError('METHOD_NOT_ALLOWED', 405);
        return await historyHandler(request, response, url);
      }
      if (request.method === 'POST' && url.pathname === `${API_PREFIX}/login`) return await loginHandler(request, response);
      if (request.method === 'POST' && url.pathname === `${API_PREFIX}/learn-existing`) return await learnExistingHandler(request, response);
      if (request.method === 'POST' && url.pathname === `${API_PREFIX}/refresh`) return await refreshHandler(request, response);
      if (request.method === 'GET' && url.pathname === `${API_PREFIX}/session`) return await sessionHandler(request, response);
      if (request.method === 'GET' && url.pathname === `${API_PREFIX}/exam-identity`) return await examIdentityHandler(request, response);
      if (request.method === 'GET' && url.pathname === `${API_PREFIX}/exam-context`) return await examContextHandler(request, response, url);
      if (request.method === 'GET' && url.pathname === `${API_PREFIX}/progress`) return await progressHandler(request, response);
      if (request.method === 'PATCH' && url.pathname === `${API_PREFIX}/credentials`) return await credentialsHandler(request, response);
      if (request.method === 'POST' && url.pathname === `${API_PREFIX}/logout`) return await logoutHandler(request, response);
      if (['GET', 'POST', 'PATCH'].includes(request.method)) throw new ServiceError('NOT_FOUND', 404);
      throw new ServiceError('METHOD_NOT_ALLOWED', 405);
    } catch (error) {
      const safe = error instanceof ServiceError ? error : new ServiceError('REQUEST_FAILED', 500);
      send(response, safe.status, { errorCode: safe.code, message: errorMessage(safe.code) });
    }
  }

  async function schedulerTick() {
    if (schedulerBusy || closing) return;
    schedulerBusy = true;
    try {
      const timestamp = now();
      for (const account of store.listAccounts()) {
        try { await reconcileBatches(account.id); } catch (_) {}
        if (!activeScans.has(account.id) && (queueRetryAt.get(account.id) || 0) <= timestamp &&
            store.listBatches(account.id).some(batch => batch.status === 'queued')) {
          try {
            if (!await hasLiveWorkerBatch(account.id) && !activeScans.has(account.id)) {
              try { await dispatchBatches(account, account.token); }
              catch (_) {
                const authenticated = await authenticateStored(account);
                await dispatchBatches(store.getAccount(account.id), authenticated.auth.token);
              }
              queueRetryAt.delete(account.id);
            }
          } catch (_) { queueRetryAt.set(account.id, timestamp + 60_000); }
        }
        try {
        if (!activeScans.has(account.id) && !dispatchingAccounts.has(account.id) && typeof worker.recheckUnknown === 'function' &&
            !store.listBatches(account.id).some(batch => batch.status === 'queued')) {
          dispatchingAccounts.add(account.id);
          try {
            if (!await hasLiveWorkerBatch(account.id, { ignoreDispatch: true })) {
              for (const batch of store.listBatches(account.id).filter(item => item.status === 'action_needed')) {
                const job = await worker.getFilteredJob(batch.id);
                if (job?.status === 'failed' && job.errorCode === 'RESOURCE_STATUS_UNVERIFIED' &&
                    job.retryable === true && typeof worker.retryPreparation === 'function') {
                  if ((preparationRetryAt.get(batch.id) || 0) > timestamp) continue;
                  preparationRetryAt.set(batch.id, timestamp + 15 * 60_000);
                  try {
                    let retried;
                    try { retried = await worker.retryPreparation({ requestId: batch.id, token: account.token }); }
                    catch (error) {
                      if (error?.code !== 'AUTH_EXPIRED') throw error;
                      const authenticated = await authenticateStored(account);
                      retried = await worker.retryPreparation({ requestId: batch.id, token: authenticated.auth.token });
                    }
                    if (retried && retried.status !== 'failed') store.refreshBatchCounters(batch.id, retried, now());
                  } catch (_) {}
                  break;
                }
                if (!job || job.status !== 'unknown' || job.errorCode !== 'COMPLETION_UNVERIFIED' ||
                    (unknownRecheckAt.get(batch.id) || 0) > timestamp) continue;
                unknownRecheckAt.set(batch.id, timestamp + 15 * 60_000);
                try {
                  const checked = await worker.recheckUnknown({ requestId: batch.id, token: account.token });
                  if (checked && checked.status !== 'unknown') store.refreshBatchCounters(batch.id, checked, now());
                } catch (_) {
                  // Leave the original uncertain result unchanged when read-only confirmation fails.
                }
                break;
              }
            }
          } finally {
            dispatchingAccounts.delete(account.id);
          }
        }
        } catch (_) {
          // A failed read-only check must not prevent another account's scheduled work.
        }
        const parts = shanghaiParts(timestamp);
        for (const time of SCHEDULE.scanTimes) {
          const [hour, minute] = time.split(':').map(Number);
          const slotAt = shanghaiInstant(parts.year, parts.month, parts.day, hour, minute);
          const slotKey = `${parts.year}-${parts.month}-${parts.day}T${time}:00+08:00`;
          if (slotAt < account.createdAt) continue;
          const delta = timestamp - slotAt;
          if (delta > SLOT_GRACE_MS) {
            store.markSkippedSlot(account.id, slotKey, timestamp);
          } else if (delta >= 0) {
            const original = store.scheduledSlot(account.id, slotKey);
            const retryKey = `${slotKey}:retry`;
            let selectedSlot = slotKey;
            if (original) {
              if (original.status !== 'action_needed' || !['UPSTREAM_UNAVAILABLE', 'UPSTREAM_RESPONSE_INVALID'].includes(original.errorCode) || store.scheduledSlot(account.id, retryKey)) continue;
              selectedSlot = retryKey;
            }
            if (activeScans.has(account.id)) {
              store.markSkippedSlot(account.id, selectedSlot, timestamp);
              continue;
            }
            void runScan(account.id, { slotKey: selectedSlot, scheduled: true }).catch(() => {});
          }
        }
      }
    } finally { schedulerBusy = false; }
  }

  const server = http.createServer((request, response) => { void handle(request, response); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  const ready = Promise.resolve().then(async () => {
    store.recover(now());
    await worker.ready;
    if (scheduleEnabled) {
      schedulerTimer = setInterval(() => { void schedulerTick(); }, 15_000);
      schedulerTimer.unref?.();
      void schedulerTick();
    }
  }).catch(() => { bootError = true; });

  return {
    server, ready, store, worker,
    async listen(port = Number(process.env.PORT || 9140), host = '127.0.0.1') {
      await ready;
      if (bootError) throw new Error('managed learning service initialization failed');
      return new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    async close() {
      closing = true;
      serverAbort.abort();
      if (schedulerTimer) clearInterval(schedulerTimer);
      await new Promise(resolve => { if (!server.listening) return resolve(); server.close(() => resolve()); });
      await Promise.allSettled([...activeScans.values()]);
      try { await worker.close(); } catch (_) {}
      try { store.close(); } catch (_) {}
    },
    async scanNow(accountId, token = null) { return runScan(accountId, { initial: true, token }); },
    async tick() { return schedulerTick(); },
    async waitForIdle() { while (activeScans.size) await Promise.allSettled([...activeScans.values()]); },
    nextScanAt
  };
}

if (require.main === module) {
  const service = createService();
  service.listen().catch(() => {
    process.stderr.write('managed learning service startup failed\n');
    process.exitCode = 1;
  });
  const stop = () => { void service.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

module.exports = {
  createService, openStore, createPlatform, encryptLoginField, loginPayload, verifiedLogin,
  inspectTraining, classifyTrainingAnomaly, classifyTrainingExamStatus, learningEvidence, readTrainingExamContent, verifyTrainingCompleted, parseDoneCount,
  DEFAULT_API_ORIGIN, DEFAULT_ORIGIN, LOGIN_ROUTE, TRAINING_ROUTE, TRAINING_EXAM_ROUTE, API_PREFIX, COOKIE_NAME,
  CONSENT_VERSION, VIDEO_CONSENT_VERSION, SCHEDULE, FILE_TYPES, CATALOG_ROUTES, formatShanghai, shanghaiInstant,
  parseBeijingCutoff
};
