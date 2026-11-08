'use strict';

const OFFICIAL_ORIGIN = 'https://learning01.zzmetro.cn:30426';
const EVENT_BINDING = '__zgVideoPlayerEvent';
const FIXED_PLAYER_HTML = '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src https://learning01.zzmetro.cn:30426; connect-src \'none\'; script-src \'none\'; img-src \'none\'; style-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"></head><body><video id="player" muted autoplay playsinline preload="auto" referrerpolicy="no-referrer"></video></body></html>';

const DEFAULT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_METADATA_TIMEOUT_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_MEDIA_BYTES = 1024 * 1024 * 1024;
const HARD_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const HARD_MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_MEDIA_URL_LENGTH = 4096;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const NETWORK_ERROR_REASONS = new Set([
  'Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed', 'ConnectionReset',
  'ConnectionRefused', 'ConnectionAborted', 'ConnectionFailed', 'NameNotResolved',
  'InternetDisconnected', 'AddressUnreachable', 'BlockedByClient', 'BlockedByResponse'
]);
const NETWORK_ERROR_TEXT = new Map([
  ['net::ERR_ABORTED', 'Aborted'],
  ['net::ERR_TIMED_OUT', 'TimedOut'],
  ['net::ERR_ACCESS_DENIED', 'AccessDenied'],
  ['net::ERR_CONNECTION_CLOSED', 'ConnectionClosed'],
  ['net::ERR_CONNECTION_RESET', 'ConnectionReset'],
  ['net::ERR_CONNECTION_REFUSED', 'ConnectionRefused'],
  ['net::ERR_CONNECTION_ABORTED', 'ConnectionAborted'],
  ['net::ERR_CONNECTION_FAILED', 'ConnectionFailed'],
  ['net::ERR_NAME_NOT_RESOLVED', 'NameNotResolved'],
  ['net::ERR_INTERNET_DISCONNECTED', 'InternetDisconnected'],
  ['net::ERR_ADDRESS_UNREACHABLE', 'AddressUnreachable'],
  ['net::ERR_BLOCKED_BY_CLIENT', 'BlockedByClient'],
  ['net::ERR_BLOCKED_BY_RESPONSE', 'BlockedByResponse']
]);

class VideoPlayerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VideoPlayerError';
    this.code = code;
  }
}

function playerError(code) { return new VideoPlayerError(code); }

function networkError(reason, protocolError = null) {
  const error = playerError('MEDIA_NETWORK_ERROR');
  error.networkErrorReason = NETWORK_ERROR_REASONS.has(reason) ? reason : 'Failed';
  if (protocolError) error.protocolError = protocolError === 'ProtocolError' ? 'ProtocolError' : 'Other';
  return error;
}

function abortError(code = 'ABORTED') {
  const error = new VideoPlayerError(code);
  error.name = 'AbortError';
  return error;
}

function validBoundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`invalid ${name}`);
  }
  return value;
}

function validateMediaUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MEDIA_URL_LENGTH || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value) || value.includes('#')) {
    throw playerError('INVALID_MEDIA_URL');
  }
  let url;
  try { url = new URL(value); } catch (_) { throw playerError('INVALID_MEDIA_URL'); }
  if (url.protocol !== 'https:' || url.origin !== OFFICIAL_ORIGIN || url.username || url.password || url.hash) {
    throw playerError('INVALID_MEDIA_URL');
  }
  return url.href;
}

function validateToken(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_TOKEN_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw playerError('INVALID_TOKEN');
  }
  return value;
}

function abortableWait(promise, task, timeoutMs, timeoutCode) {
  return new Promise((resolve, reject) => {
    if (task.controller.signal.aborted) {
      reject(task.failure || abortError(task.abortCode));
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      task.controller.signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, task.failure || abortError(task.abortCode));
    const timer = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? setTimeout(() => finish(reject, playerError(timeoutCode)), timeoutMs)
      : null;
    task.controller.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

function chromiumModule(injected) {
  if (injected) {
    const value = injected.chromium || injected;
    if (typeof value.launch !== 'function') throw playerError('CHROMIUM_UNAVAILABLE');
    return value;
  }
  const moduleName = process.env.ZG_VIDEO_PLAYWRIGHT_MODULE || 'playwright-core';
  let loaded;
  try { loaded = require(moduleName); } catch (_) { throw playerError('CHROMIUM_UNAVAILABLE'); }
  const value = loaded.chromium || loaded;
  if (typeof value.launch !== 'function') throw playerError('CHROMIUM_UNAVAILABLE');
  return value;
}

function makeSlotPool(maxConcurrent) {
  let occupied = 0;
  const queue = [];

  function releaseSlot() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (queue.length) {
        const waiter = queue.shift();
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        if (waiter.signal.aborted) {
          waiter.reject(abortError(waiter.task.abortCode));
          continue;
        }
        waiter.resolve(releaseSlot());
        return;
      }
      occupied -= 1;
    };
  }

  return {
    acquire(task) {
      const signal = task.controller.signal;
      if (signal.aborted) return Promise.reject(task.failure || abortError(task.abortCode));
      if (occupied < maxConcurrent) {
        occupied += 1;
        return Promise.resolve(releaseSlot());
      }
      return new Promise((resolve, reject) => {
        const waiter = { task, signal, resolve, reject, onAbort: null };
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(task.failure || abortError(task.abortCode));
        };
        queue.push(waiter);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      });
    }
  };
}

function safeCloseBrowser(task) {
  if (task.closePromise) return task.closePromise;
  const browser = task.browser;
  if (!browser) return Promise.resolve();
  task.closePromise = (async () => {
    let finished = false;
    const close = Promise.resolve().then(() => browser.close()).catch(() => {}).then(() => { finished = true; });
    let timeout;
    await Promise.race([close, new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]);
    clearTimeout(timeout);
    if (!finished) {
      try {
        const child = typeof browser.process === 'function' ? browser.process() : null;
        if (child && typeof child.kill === 'function') child.kill('SIGKILL');
      } catch (_) {}
    }
    if (task.browser === browser) task.browser = null;
  })();
  return task.closePromise;
}

function createVideoPlayer(options = {}) {
  const injectedChromium = options.chromium;
  const executablePath = options.executablePath || process.env.ZG_VIDEO_CHROMIUM_PATH || '/usr/bin/chromium';
  const maxConcurrent = validBoundedInteger(options.maxConcurrent ?? 1, 'maxConcurrent', 1, 8);
  const maxDurationMs = validBoundedInteger(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS, 'maxDurationMs', 1, HARD_MAX_DURATION_MS);
  const metadataTimeoutMs = validBoundedInteger(options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS, 'metadataTimeoutMs', 1, 10 * 60 * 1000);
  const stallTimeoutMs = validBoundedInteger(options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS, 'stallTimeoutMs', 1, 10 * 60 * 1000);
  const maxMediaBytes = validBoundedInteger(options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES, 'maxMediaBytes', 1, HARD_MAX_MEDIA_BYTES);
  if (executablePath !== undefined && (typeof executablePath !== 'string' || !executablePath || /[\u0000-\u001f\u007f]/.test(executablePath))) {
    throw new TypeError('invalid executablePath');
  }

  const slots = makeSlotPool(maxConcurrent);
  const tasks = new Set();
  let closed = false;

  function abortTask(task, code, failure = null) {
    if (task.abortCode || task.controller.signal.aborted) return;
    task.abortCode = code;
    if (failure) task.failure = failure;
    task.controller.abort();
    void safeCloseBrowser(task);
  }

  function emitProgress(callback, payload) {
    if (typeof callback !== 'function') return;
    const duration = Number(payload.duration);
    const currentTime = Number(payload.currentTime);
    try {
      callback({
        duration: Number.isFinite(duration) ? duration : null,
        currentTime: Number.isFinite(currentTime) ? currentTime : null,
        ended: payload.ended === true,
        kind: typeof payload.kind === 'string' ? payload.kind : null
      });
    } catch (_) {}
  }

  async function runPlayback(task, input, mediaUrl, token) {
    let playbackTimer;
    let stallTimer;
    let context;
    let page;
    let cdp;
    const metadata = deferred();
    const seeked = deferred();
    const ended = deferred();
    let eventFailure = null;
    let metadataSeen = false;
    let playingSeen = false;
    let lastCurrentTime = null;
    let transferredBytes = 0;
    let lastNetworkDiagnostic = null;
    const fetchNetworkIds = new Map();
    const mediaNetworkIds = new Set();
    const canceledNetworkIds = new Set();

    function fail(code, error = playerError(code)) {
      if (!eventFailure) eventFailure = error;
      abortTask(task, code, eventFailure);
    }

    function rememberNetworkError(error, networkId = null) {
      if (networkId && canceledNetworkIds.has(networkId)) return;
      lastNetworkDiagnostic = { error, networkId };
    }

    function clearNetworkError(networkId = null) {
      if (!networkId || lastNetworkDiagnostic?.networkId === networkId) lastNetworkDiagnostic = null;
    }

    function failWithNetworkFallback(code) {
      if (lastNetworkDiagnostic) fail(lastNetworkDiagnostic.error.code, lastNetworkDiagnostic.error);
      else fail(code);
    }

    function addBounded(set, value, max = 128) {
      if (typeof value !== 'string' || !value) return;
      set.add(value);
      while (set.size > max) set.delete(set.values().next().value);
    }

    function setBounded(map, key, value, max = 128) {
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    }

    function startStallTimer() {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => failWithNetworkFallback('PLAYBACK_STALLED'), stallTimeoutMs);
    }

    function receiveMediaEvent(payload) {
      if (!payload || typeof payload !== 'object') return;
      const currentTime = Number(payload.currentTime);
      if (payload.kind === 'metadata' && !metadataSeen) {
        metadataSeen = true;
        metadata.resolve(payload);
        clearNetworkError();
      }
      if (payload.kind === 'seeked') seeked.resolve(payload);
      if (payload.kind === 'playing') {
        playingSeen = true;
        if (Number.isFinite(currentTime)) lastCurrentTime = currentTime;
        clearNetworkError();
        startStallTimer();
      }
      if (payload.kind === 'timeupdate' && Number.isFinite(currentTime)) {
        if (lastCurrentTime === null || currentTime > lastCurrentTime + 0.001) {
          lastCurrentTime = currentTime;
          clearNetworkError();
          startStallTimer();
        } else if (currentTime < lastCurrentTime - 0.05) {
          lastCurrentTime = currentTime;
        }
      }
      if (payload.kind === 'metadata' && Number.isFinite(currentTime)) lastCurrentTime = currentTime;
      if (payload.kind === 'playback-rejected' && !lastNetworkDiagnostic) fail('AUTOPLAY_FAILED');
      if (payload.kind === 'seek-failed') fail('VIDEO_SEEK_FAILED');
      if (payload.kind === 'media-error' && !lastNetworkDiagnostic) fail('MEDIA_ERROR');
      if (payload.kind === 'popup' || payload.kind === 'download' || payload.kind === 'navigation') fail('BROWSER_ACTION_BLOCKED');
      if (payload.kind === 'ended') {
        emitProgress(input.onProgress, payload);
        if (!playingSeen || payload.ended !== true) fail('PLAYBACK_NOT_STARTED');
        else ended.resolve(payload);
      } else if (payload.kind === 'timeupdate' || payload.kind === 'playing' || payload.kind === 'metadata' || payload.kind === 'seeked') {
        emitProgress(input.onProgress, payload);
      }
    }

    const onAbort = () => { void safeCloseBrowser(task); };
    task.controller.signal.addEventListener('abort', onAbort, { once: true });
    playbackTimer = setTimeout(() => {
      if (lastNetworkDiagnostic) abortTask(task, lastNetworkDiagnostic.error.code, lastNetworkDiagnostic.error);
      else abortTask(task, 'PLAYBACK_TIMEOUT', playerError('PLAYBACK_TIMEOUT'));
    }, maxDurationMs);

    try {
      const chromium = chromiumModule(injectedChromium);
      const launchOptions = { headless: true };
      if (executablePath) launchOptions.executablePath = executablePath;
      const launchPromise = Promise.resolve().then(() => chromium.launch(launchOptions));
      launchPromise.then(browser => {
        if (task.controller.signal.aborted) {
          task.browser = browser;
          void safeCloseBrowser(task);
        } else task.browser = browser;
      }, () => {});
      task.browser = await abortableWait(launchPromise, task, maxDurationMs, 'PLAYBACK_TIMEOUT');

      context = await abortableWait(task.browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        ignoreHTTPSErrors: false
      }), task, maxDurationMs, 'PLAYBACK_TIMEOUT');

      page = await abortableWait(context.newPage(), task, maxDurationMs, 'PLAYBACK_TIMEOUT');
      if (typeof context.newCDPSession !== 'function') throw playerError('MEDIA_LIMIT_UNAVAILABLE');
      cdp = await abortableWait(context.newCDPSession(page), task, maxDurationMs, 'PLAYBACK_TIMEOUT');
      await abortableWait(cdp.send('Network.enable'), task, maxDurationMs, 'PLAYBACK_TIMEOUT');
      cdp.on('Network.loadingFailed', event => {
        const networkId = typeof event?.requestId === 'string' ? event.requestId : '';
        if (!networkId || !mediaNetworkIds.has(networkId)) return;
        if (event.canceled === true) {
          addBounded(canceledNetworkIds, networkId);
          clearNetworkError(networkId);
          return;
        }
        const reason = NETWORK_ERROR_TEXT.get(event.errorText) || (event.blockedReason || event.corsErrorStatus ? 'BlockedByResponse' : 'Failed');
        rememberNetworkError(networkError(reason), networkId);
      });
      cdp.on('Fetch.requestPaused', event => {
        void (async () => {
          let requestUrl;
          try {
            requestUrl = new URL(event.request?.url || '');
          } catch (_) {
            fail('BROWSER_REQUEST_BLOCKED');
            try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); } catch (_) {}
            return;
          }
          if (requestUrl.protocol !== 'https:' || requestUrl.origin !== OFFICIAL_ORIGIN || requestUrl.username || requestUrl.password || requestUrl.hash || event.resourceType !== 'Media') {
            fail('BROWSER_REQUEST_BLOCKED');
            try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); } catch (_) {}
            return;
          }
          const networkId = typeof event.networkId === 'string' ? event.networkId : (fetchNetworkIds.get(event.requestId) || null);
          if (networkId) {
            setBounded(fetchNetworkIds, event.requestId, networkId);
            addBounded(mediaNetworkIds, networkId);
          }
          if (event.responseErrorReason !== undefined) {
            const error = networkError(event.responseErrorReason);
            rememberNetworkError(error, networkId);
            try {
              await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
            } catch (_) {
              if (lastNetworkDiagnostic?.error === error) error.protocolError = 'ProtocolError';
            }
            fetchNetworkIds.delete(event.requestId);
            return;
          }
          const status = event.responseStatusCode;
          if (!Number.isInteger(status)) {
            const method = String(event.request?.method || '').toUpperCase();
            if (!['GET', 'HEAD'].includes(method)) {
              fail('BROWSER_REQUEST_BLOCKED');
              try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); } catch (_) {}
              return;
            }
            const headers = { ...(event.request?.headers || {}) };
            for (const name of Object.keys(headers)) {
              if (name.toLowerCase() === 'x-auth-token') delete headers[name];
            }
            if (token) headers['X-Auth-Token'] = `Bearer ${token}`;
            try {
              await cdp.send('Fetch.continueRequest', {
                requestId: event.requestId,
                headers: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
              });
            } catch (_) {
              const error = networkError('Failed', 'ProtocolError');
              fail(error.code, error);
              try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); } catch (_) {}
            }
            return;
          }
          if (REDIRECT_STATUS_CODES.has(status)) {
            try {
              const location = event.responseHeaders?.find(header => String(header.name).toLowerCase() === 'location')?.value;
              let redirect;
              try {
                if (typeof location !== 'string' || location.length === 0 || /[\u0000-\u0020\u007f]/.test(location) || location.includes('#')) throw new Error('bad location');
                redirect = new URL(location, requestUrl.href);
              } catch (_) { redirect = null; }
              const allowed = redirect && redirect.protocol === 'https:' && redirect.origin === OFFICIAL_ORIGIN && !redirect.username && !redirect.password && !redirect.hash;
              if (!allowed) {
                fail('MEDIA_REDIRECT_BLOCKED');
                await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
                return;
              }
            } catch (_) {
              if (task.abortCode) return;
              fail('MEDIA_REDIRECT_CHECK_FAILED');
              try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); } catch (_) {}
              return;
            }
          }
          try {
            await cdp.send('Fetch.continueResponse', { requestId: event.requestId });
            clearNetworkError(networkId);
            fetchNetworkIds.delete(event.requestId);
          } catch (_) {
            const error = networkError('Failed', 'ProtocolError');
            fail(error.code, error);
            try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); } catch (_) {}
          }
        })();
      });
      await abortableWait(cdp.send('Fetch.enable', { patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' }
      ] }), task, maxDurationMs, 'PLAYBACK_TIMEOUT');
      cdp.on('Network.responseReceived', event => {
        if (event?.type !== 'Media') return;
        const headers = event.response?.headers || {};
        const lengthHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
        const length = Number(lengthHeader);
        if (Number.isFinite(length) && length > maxMediaBytes) fail('MEDIA_SIZE_LIMIT');
      });
      cdp.on('Network.dataReceived', event => {
        const encoded = Number(event?.encodedDataLength);
        const decoded = Number(event?.dataLength);
        const increment = Number.isFinite(encoded) && encoded > 0 ? encoded : (Number.isFinite(decoded) && decoded > 0 ? decoded : 0);
        transferredBytes += increment;
        if (transferredBytes > maxMediaBytes) fail('MEDIA_SIZE_LIMIT');
      });

      await abortableWait(page.setContent(FIXED_PLAYER_HTML, { waitUntil: 'domcontentloaded' }), task, maxDurationMs, 'PLAYBACK_TIMEOUT');
      await abortableWait(page.exposeFunction(EVENT_BINDING, receiveMediaEvent), task, maxDurationMs, 'PLAYBACK_TIMEOUT');

      page.on('popup', popup => {
        fail('BROWSER_ACTION_BLOCKED');
        void popup.close().catch(() => {});
      });
      page.on('download', download => {
        fail('BROWSER_ACTION_BLOCKED');
        void download.cancel().catch(() => {});
      });
      page.on('pageerror', () => fail('PLAYER_PAGE_ERROR'));
      page.on('framenavigated', frame => {
        try {
          if (frame === page.mainFrame() && frame.url() !== 'about:blank') fail('BROWSER_ACTION_BLOCKED');
        } catch (_) { fail('BROWSER_ACTION_BLOCKED'); }
      });
      context.on('page', otherPage => {
        if (otherPage !== page) {
          fail('BROWSER_ACTION_BLOCKED');
          void otherPage.close().catch(() => {});
        }
      });

      const video = page.locator('video#player');
      await abortableWait(video.evaluate((element, config) => {
        const view = element.ownerDocument.defaultView;
        const report = kind => {
          try {
            view[config.binding]({
              kind,
              duration: element.duration,
              currentTime: element.currentTime,
              ended: element.ended === true,
              paused: element.paused === true,
              readyState: element.readyState
            });
          } catch (_) {}
        };
        let metadataReported = false;
        const startPlayback = () => {
          try { Promise.resolve(element.play()).catch(() => report('playback-rejected')); }
          catch (_) { report('playback-rejected'); }
        };
        const announceMetadata = () => {
          if (metadataReported || element.readyState < 1) return;
          metadataReported = true;
          if (config.fastForwardAllowed === true && !element.__zgTailJumped && Number.isFinite(element.duration) && element.duration > 1) {
            element.__zgTailJumped = true;
            element.addEventListener('seeked', () => report('seeked'), { once: true });
            try { element.currentTime = element.duration - 1; }
            catch (_) { report('seek-failed'); return; }
          }
          report('metadata');
        };
        element.muted = true;
        element.autoplay = config.fastForwardAllowed !== true;
        element.playsInline = true;
        element.preload = config.fastForwardAllowed === true ? 'metadata' : 'auto';
        element.playbackRate = 1;
        element.controls = false;
        element.referrerPolicy = 'no-referrer';
        element.addEventListener('loadedmetadata', announceMetadata, { once: true });
        element.addEventListener('durationchange', announceMetadata);
        element.addEventListener('playing', () => report('playing'));
        element.addEventListener('timeupdate', () => report('timeupdate'));
        element.addEventListener('ended', () => report('ended'), { once: true });
        element.addEventListener('error', () => report('media-error'), { once: true });
        element.src = config.mediaUrl;
        element.load();
        if (config.fastForwardAllowed !== true) startPlayback();
        return true;
      }, { binding: EVENT_BINDING, mediaUrl, fastForwardAllowed: input.fastForwardAllowed === true }), task, maxDurationMs, 'PLAYBACK_TIMEOUT');

      const metadataEvent = await abortableWait(metadata.promise, task, metadataTimeoutMs, 'METADATA_TIMEOUT');
      const duration = Number(metadataEvent.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw playerError('VIDEO_DURATION_UNAVAILABLE');
      if (duration * 1000 > maxDurationMs) throw playerError('VIDEO_DURATION_LIMIT');
      if (input.fastForwardAllowed === true && duration > 1) {
        const seekEvent = await abortableWait(seeked.promise, task, metadataTimeoutMs, 'VIDEO_SEEK_TIMEOUT');
        const seekTime = Number(seekEvent.currentTime);
        if (!Number.isFinite(seekTime) || Math.abs(seekTime - (duration - 1)) > 0.5) throw playerError('VIDEO_SEEK_FAILED');
      }
      if (input.fastForwardAllowed === true) {
        await abortableWait(video.evaluate((element, binding) => {
          const reportRejected = () => {
            try { element.ownerDocument.defaultView[binding]({ kind: 'playback-rejected' }); } catch (_) {}
          };
          try { Promise.resolve(element.play()).catch(reportRejected); }
          catch (_) { reportRejected(); }
          return true;
        }, EVENT_BINDING), task, maxDurationMs, 'PLAYBACK_TIMEOUT');
      }
      lastCurrentTime = Number.isFinite(Number(metadataEvent.currentTime)) ? Number(metadataEvent.currentTime) : null;
      startStallTimer();

      await abortableWait(ended.promise, task, maxDurationMs, 'PLAYBACK_TIMEOUT');
      const finalState = await abortableWait(video.evaluate(element => ({
        duration: element.duration,
        currentTime: element.currentTime,
        ended: element.ended === true,
        playbackRate: element.playbackRate
      })), task, maxDurationMs, 'PLAYBACK_TIMEOUT');
      if (finalState.ended !== true || !Number.isFinite(finalState.duration) || finalState.duration <= 0 || !Number.isFinite(finalState.currentTime) || finalState.currentTime < finalState.duration - 1.5 || finalState.playbackRate !== 1) {
        throw playerError('PLAYBACK_NOT_CONFIRMED');
      }
      return { duration: finalState.duration, ended: true, currentTime: finalState.currentTime, transferredBytes };
    } catch (error) {
      if (task.failure) throw task.failure;
      if (task.abortCode) throw abortError(task.abortCode);
      if (error instanceof VideoPlayerError) {
        if (lastNetworkDiagnostic && ['METADATA_TIMEOUT', 'VIDEO_SEEK_TIMEOUT', 'PLAYBACK_TIMEOUT'].includes(error.code)) {
          throw lastNetworkDiagnostic.error;
        }
        throw error;
      }
      if (error?.name === 'TimeoutError') throw playerError('PLAYER_TIMEOUT');
      throw playerError('VIDEO_PLAYBACK_FAILED');
    } finally {
      clearTimeout(playbackTimer);
      clearTimeout(stallTimer);
      task.controller.signal.removeEventListener('abort', onAbort);
      if (cdp) await settleWithin(Promise.resolve().then(() => cdp.detach()), 250);
      if (context) await settleWithin(Promise.resolve().then(() => context.close()), 1000);
      await safeCloseBrowser(task);
    }
  }

  function play(input = {}) {
    if (closed) return Promise.reject(playerError('PLAYER_CLOSED'));
    let mediaUrl;
    let token;
    try {
      mediaUrl = validateMediaUrl(input.mediaUrl);
      token = validateToken(input.token);
      if (input.signal !== undefined && (!input.signal || typeof input.signal.addEventListener !== 'function' || typeof input.signal.aborted !== 'boolean')) {
        throw new TypeError('invalid signal');
      }
      if (input.onProgress !== undefined && typeof input.onProgress !== 'function') throw new TypeError('invalid onProgress');
    } catch (error) { return Promise.reject(error); }
    if (input.signal?.aborted) return Promise.reject(abortError());

    const task = { controller: new AbortController(), abortCode: null, failure: null, browser: null, closePromise: null, completion: null };
    const forwardAbort = () => abortTask(task, 'ABORTED');
    input.signal?.addEventListener('abort', forwardAbort, { once: true });
    tasks.add(task);
    if (closed) abortTask(task, 'PLAYER_CLOSED');

    task.completion = (async () => {
      let release;
      try {
        release = await slots.acquire(task);
        if (task.controller.signal.aborted) throw task.failure || abortError(task.abortCode);
        return await runPlayback(task, input, mediaUrl, token);
      } catch (error) {
        if (task.failure) throw task.failure;
        if (task.abortCode) throw abortError(task.abortCode);
        throw error;
      } finally {
        if (release) release();
        input.signal?.removeEventListener('abort', forwardAbort);
        tasks.delete(task);
      }
    })();
    return task.completion;
  }

  async function close() {
    if (closed && tasks.size === 0) return;
    closed = true;
    for (const task of tasks) abortTask(task, 'PLAYER_CLOSED');
    await Promise.allSettled([...tasks].map(task => task.completion));
  }

  return Object.freeze({ play, close });
}

module.exports = { createVideoPlayer, VideoPlayerError, OFFICIAL_ORIGIN };
