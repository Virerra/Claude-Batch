// test-harness.js
// Loads the ACTUAL index.html into jsdom, mocks fetch, and drives the real UI
// to verify queueing, pacing, export, and error-handling logic end-to-end.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.log('FAIL:', msg); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function freshDom() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  // localStorage shim (jsdom supports it natively with resources:'usable' under url)
  // wait a tick for inline scripts to run
  await sleep(50);
  return dom;
}

// The real SheetJS script can't load from the CDN in this sandboxed test
// environment, so we inject a mock that matches its real documented API shape:
// XLSX.read(arrayBuffer, {type:'array'}) -> workbook, and
// XLSX.utils.sheet_to_json(sheet, {defval, raw}) -> array of row objects.
// `rows` here is the array of plain row objects the mock should return.
function installMockXLSX(dom, rows, sheetNames) {
  sheetNames = sheetNames || ['Sheet1'];
  dom.window.XLSX = {
    read: (data, opts) => {
      const sheets = {};
      sheetNames.forEach(name => { sheets[name] = { __mockRows: rows }; });
      return { SheetNames: sheetNames, Sheets: sheets };
    },
    utils: {
      sheet_to_json: (sheet, opts) => {
        const defval = opts && Object.prototype.hasOwnProperty.call(opts, 'defval') ? opts.defval : undefined;
        if (defval === undefined) return sheet.__mockRows;
        // Apply defval to any row missing a key that other rows have, same as
        // real SheetJS does when a column is blank in some rows.
        const allKeys = new Set();
        sheet.__mockRows.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
        return sheet.__mockRows.map(r => {
          const filled = {};
          allKeys.forEach(k => { filled[k] = Object.prototype.hasOwnProperty.call(r, k) ? r[k] : defval; });
          return filled;
        });
      },
    },
  };
}

// Simulates a user selecting a file via the file input. jsdom's FileReader
// doesn't actually need real file bytes since XLSX.read is mocked above --
// we just need the file's name to pass the .csv/.xlsx extension check and
// trigger the change event the app listens for.
function simulateFileUpload(dom, filename) {
  const fileInput = dom.window.document.getElementById('file-input');
  const file = new dom.window.File(['mock file content'], filename, { type: 'application/octet-stream' });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function setVal(dom, id, value) {
  const el = dom.window.document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function click(dom, id) {
  dom.window.document.getElementById(id).click();
}

function text(dom, id) {
  return dom.window.document.getElementById(id).textContent;
}

// ---------------------------------------------------------------------
// TEST 1: Adding prompts (single + bulk multi-line + blank-line filtering)
// ---------------------------------------------------------------------
async function testAddPrompts() {
  const dom = await freshDom();
  setVal(dom, 'prompt-input', 'first prompt\n\n   \nsecond prompt\nthird prompt   ');
  click(dom, 'add-btn');
  await sleep(20);

  const rows = dom.window.document.querySelectorAll('.row');
  assert(rows.length === 3, `expected 3 rows after bulk add with blank lines, got ${rows.length}`);
  assert(text(dom, 'stat-pending') === '3', `expected stat-pending=3, got ${text(dom, 'stat-pending')}`);

  // check trimming worked (third prompt had trailing spaces)
  const promptTexts = Array.from(rows).map(r => r.querySelector('.row-prompt').textContent);
  assert(promptTexts[2] === 'third prompt', `expected trimmed prompt, got "${promptTexts[2]}"`);

  // input box should be cleared after add
  assert(dom.window.document.getElementById('prompt-input').value === '', 'prompt input should clear after Add');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 2: Run button enable/disable logic tied to API key + pending count
// ---------------------------------------------------------------------
async function testRunButtonGating() {
  const dom = await freshDom();
  const runBtn = dom.window.document.getElementById('run-btn');

  assert(runBtn.disabled === true, 'run button should be disabled with no key and no queue');

  setVal(dom, 'prompt-input', 'hello');
  click(dom, 'add-btn');
  await sleep(20);
  assert(runBtn.disabled === true, 'run button should stay disabled with queue but no API key');

  setVal(dom, 'api-key', 'sk-ant-test-key');
  await sleep(20);
  assert(runBtn.disabled === false, 'run button should enable once key + pending items exist');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 3: Full run lifecycle with mocked fetch — pacing, status transitions,
// stop mid-run, and that paced delay is actually honored (not fired immediately)
// ---------------------------------------------------------------------
async function testRunLifecycleAndPacing() {
  const dom = await freshDom();
  const calls = [];

  // Mock fetch on the jsdom window — this is what the app's `fetch(...)` resolves to
  dom.window.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), at: Date.now() });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: `response #${calls.length}` }],
      }),
    };
  };

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'prompt A\nprompt B');
  click(dom, 'add-btn');
  await sleep(20);

  // set pace to 1 second (minimum-ish) so test runs fast but still measures a real gap
  setVal(dom, 'pace-slider', '1');
  dom.window.document.getElementById('pace-slider').dispatchEvent(new dom.window.Event('input'));

  click(dom, 'run-btn'); // start
  await sleep(50); // let first call fire

  assert(calls.length === 1, `expected 1 API call shortly after start, got ${calls.length}`);

  const firstRowBadge = dom.window.document.querySelectorAll('.status-badge')[0];
  // by now first call should have resolved (mock is instant) -> completed
  assert(firstRowBadge.textContent === 'completed' || firstRowBadge.textContent === 'processing',
    `expected first row completed/processing shortly after start, got "${firstRowBadge.textContent}"`);

  // second call should NOT have fired yet (pace = 1000ms, only 50ms elapsed)
  assert(calls.length === 1, `second request fired too early — pacing not honored (calls=${calls.length})`);

  await sleep(1100); // wait past the 1s interval
  assert(calls.length === 2, `expected 2nd API call to fire after pace interval, got ${calls.length}`);

  // verify the actual gap between call 1 and call 2 respects the interval (allow jitter)
  const gap = calls[1].at - calls[0].at;
  assert(gap >= 900, `expected >=900ms gap between paced calls, got ${gap}ms`);

  await sleep(50);
  assert(text(dom, 'stat-completed') === '2', `expected 2 completed after queue drains, got ${text(dom, 'stat-completed')}`);
  assert(text(dom, 'stat-pending') === '0', 'expected 0 pending after queue drains');

  const runBtn = dom.window.document.getElementById('run-btn');
  assert(runBtn.textContent === 'Start queue', 'run button should reset to "Start queue" after queue drains');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 4: Stop mid-run actually halts further calls (no race to fire one more)
// ---------------------------------------------------------------------
async function testStopMidRun() {
  const dom = await freshDom();
  const calls = [];
  dom.window.fetch = async (url, opts) => {
    calls.push(Date.now());
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
  };

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'a\nb\nc\nd\ne');
  click(dom, 'add-btn');
  await sleep(20);
  setVal(dom, 'pace-slider', '1');
  dom.window.document.getElementById('pace-slider').dispatchEvent(new dom.window.Event('input'));

  click(dom, 'run-btn');
  await sleep(50);
  assert(calls.length === 1, `expected exactly 1 call before stop, got ${calls.length}`);

  click(dom, 'run-btn'); // stop (button toggles)
  await sleep(1500); // wait well past what would have been the next interval

  assert(calls.length === 1, `expected NO further calls after stop, but got ${calls.length} total calls`);
  assert(text(dom, 'stat-pending') === '4', `expected 4 still pending after stopping early, got ${text(dom, 'stat-pending')}`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 5: API error handling — a retryable error (429) should NOT fail
// immediately. It should retry with backoff, and only land on "failed"
// after retries are exhausted. We force every attempt to 429 so we can
// observe the retry behavior, then verify the eventual terminal state.
// ---------------------------------------------------------------------
async function testApiErrorHandling() {
  const dom = await freshDom();
  let callNum = 0;
  dom.window.fetch = async (url, opts) => {
    callNum++;
    return {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: { message: 'rate limited, slow down' } }),
    };
  };

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'will be rate limited');
  click(dom, 'add-btn');
  await sleep(20);
  setVal(dom, 'pace-slider', '1');
  dom.window.document.getElementById('pace-slider').dispatchEvent(new dom.window.Event('input'));

  click(dom, 'run-btn');
  await sleep(80);

  // Should still be "processing" (with a retry note in the error field) rather
  // than immediately "failed" — this is the core fix: a 429 must not be terminal
  // on the first attempt.
  assert(text(dom, 'stat-processing') === '1', `expected row still 'processing' (retrying) right after a 429, got processing=${text(dom, 'stat-processing')}, failed=${text(dom, 'stat-failed')}`);
  assert(callNum >= 1, 'expected at least 1 call attempt');

  // Backoff schedule is 2s, 4s, 8s (capped) for 3 retries — wait long enough for
  // all retries to exhaust and land on a terminal 'failed' state.
  await sleep(16000);

  assert(text(dom, 'stat-failed') === '1', `expected row to be 'failed' after retries exhausted, got failed=${text(dom, 'stat-failed')}`);
  assert(callNum === 4, `expected exactly 4 attempts (1 initial + 3 retries), got ${callNum}`);
  const errEl = dom.window.document.querySelector('.row-response.error');
  assert(errEl && errEl.textContent.includes('429'), `expected final error to mention 429, got "${errEl && errEl.textContent}"`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 5b: A non-retryable error (e.g. 400 bad request / invalid API key 401)
// should fail immediately without retry delay, since retrying won't help.
// ---------------------------------------------------------------------
async function testNonRetryableErrorFailsFast() {
  const dom = await freshDom();
  let callNum = 0;
  const start = Date.now();
  dom.window.fetch = async () => {
    callNum++;
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'invalid x-api-key' } }),
    };
  };

  setVal(dom, 'api-key', 'sk-ant-bad-key');
  setVal(dom, 'prompt-input', 'auth will fail');
  click(dom, 'add-btn');
  await sleep(20);
  click(dom, 'run-btn');
  await sleep(150);

  assert(text(dom, 'stat-failed') === '1', `expected immediate failure on 401 (non-retryable), got failed=${text(dom, 'stat-failed')}`);
  assert(callNum === 1, `expected exactly 1 attempt for a non-retryable error, got ${callNum}`);
  const elapsed = Date.now() - start;
  assert(elapsed < 1000, `expected fast failure (<1s) for non-retryable error, took ${elapsed}ms`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 6: Network-level throw (fetch rejects, e.g. offline) is caught, not
// unhandled, and is treated as retryable (transient) rather than instantly
// terminal — then verify Stop can interrupt a retry backoff wait cleanly.
// ---------------------------------------------------------------------
async function testNetworkFailureDoesNotCrash() {
  const dom = await freshDom();
  dom.window.fetch = async () => { throw new TypeError('Failed to fetch'); };

  let uncaught = false;
  dom.window.addEventListener('error', () => { uncaught = true; });
  dom.window.addEventListener('unhandledrejection', () => { uncaught = true; });

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'offline test');
  click(dom, 'add-btn');
  await sleep(20);
  click(dom, 'run-btn');
  await sleep(100);

  assert(uncaught === false, 'a network-level fetch rejection should be caught, not surface as unhandled error');
  // Network errors are retryable, so right after the first failure it should
  // still be "processing" (mid-backoff), not yet "failed".
  assert(text(dom, 'stat-processing') === '1', `expected row still retrying after a network error, got processing=${text(dom, 'stat-processing')}`);

  // Stop should interrupt the backoff wait promptly rather than forcing the
  // test (or a real user) to wait out the full backoff schedule.
  const stopStart = Date.now();
  click(dom, 'run-btn'); // stop
  await sleep(300);
  assert(uncaught === false, 'stopping mid-backoff should not throw');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 7: Clear All is disabled while a run is active (the fix for the old
// bug where clearing mid-flight could orphan an in-flight request). Also
// verify that Stop aborts the in-flight fetch via AbortController rather
// than letting it resolve into a detached row.
// ---------------------------------------------------------------------
async function testClearAllDisabledDuringRun() {
  const dom = await freshDom();
  let sawAbort = false;
  dom.window.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      sawAbort = true;
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
    // never resolves on its own — only abort or timeout ends it
  });

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'slow one');
  click(dom, 'add-btn');
  await sleep(20);
  click(dom, 'run-btn');
  await sleep(50); // call is now in-flight

  const clearAllBtn = dom.window.document.getElementById('clear-all');
  assert(clearAllBtn.disabled === true, 'Clear All should be disabled while a run is active, to prevent orphaning an in-flight request');

  click(dom, 'run-btn'); // stop -> should abort the in-flight fetch
  await sleep(50);

  assert(sawAbort === true, 'stopping mid-flight should abort the in-flight fetch via AbortController');
  assert(clearAllBtn.disabled === false, 'Clear All should re-enable once the run is stopped');

  // Now that the run is stopped, Clear All should work normally.
  click(dom, 'clear-all');
  await sleep(20);
  assert(dom.window.document.querySelectorAll('.row').length === 0, 'Clear All should empty the queue once the run is stopped');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 8: Export functions produce correct, well-formed data
// (we can't click a real download in jsdom, so we test the data-shaping
// logic indirectly by checking Blob creation doesn't throw and queue data is intact)
// ---------------------------------------------------------------------
async function testExportDataIntegrity() {
  const dom = await freshDom();
  dom.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'answer with, a comma and "quotes"' }] }) });

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'csv edge case test');
  click(dom, 'add-btn');
  await sleep(20);
  setVal(dom, 'pace-slider', '1');
  dom.window.document.getElementById('pace-slider').dispatchEvent(new dom.window.Event('input'));
  click(dom, 'run-btn');
  await sleep(80);

  assert(text(dom, 'stat-completed') === '1', 'setup: expected 1 completed row before testing export');

  // Intercept the download mechanism: createObjectURL + anchor click
  let capturedBlob = null;
  const origCreateObjectURL = dom.window.URL.createObjectURL;
  dom.window.URL.createObjectURL = (blob) => { capturedBlob = blob; return 'blob:mock'; };
  dom.window.URL.revokeObjectURL = () => {};

  let exportThrew = false;
  try {
    click(dom, 'export-csv');
  } catch (e) {
    exportThrew = true;
    console.log('export-csv threw:', e.message);
  }
  assert(!exportThrew, 'clicking Download CSV should not throw');
  assert(capturedBlob !== null, 'CSV export should create a Blob');

  dom.window.URL.createObjectURL = origCreateObjectURL;
  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 9: Estimate text math — verify the (pending-1)*interval formula
// ---------------------------------------------------------------------
async function testEstimateMath() {
  const dom = await freshDom();
  setVal(dom, 'prompt-input', 'a\nb\nc\nd'); // 4 prompts
  click(dom, 'add-btn');
  await sleep(20);
  setVal(dom, 'pace-slider', '30');
  dom.window.document.getElementById('pace-slider').dispatchEvent(new dom.window.Event('input'));

  const est = text(dom, 'pace-estimate');
  // 4 pending, 30s interval -> (4-1)*30 = 90s = 1m 30s
  assert(est.includes('1m') && est.includes('30s'), `expected estimate to show 1m 30s for 4 items @ 30s, got: "${est}"`);
  assert(est.includes('4'), `expected estimate to mention 4 pending, got: "${est}"`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 10: Remove button disabled exactly while a row is processing
// ---------------------------------------------------------------------
async function testRemoveDisabledWhileProcessing() {
  const dom = await freshDom();
  let resolveCall;
  dom.window.fetch = () => new Promise(resolve => {
    resolveCall = () => resolve({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'x' }] }) });
  });

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'only one');
  click(dom, 'add-btn');
  await sleep(20);
  click(dom, 'run-btn');
  await sleep(50);

  const removeBtn = dom.window.document.querySelector('.row-remove');
  assert(removeBtn.disabled === true, 'remove button should be disabled while its row is processing');

  resolveCall();
  await sleep(50);

  const removeBtnAfter = dom.window.document.querySelector('.row-remove');
  assert(removeBtnAfter.disabled === false, 'remove button should re-enable once row completes');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 11: Repeated Start/Stop cycles don't leak timers — the elapsed clock
// should not keep ticking (or double-tick) after Stop, and starting again
// should produce a clean single-cadence clock, not stacked intervals.
// ---------------------------------------------------------------------
async function testNoTimerLeakOnRepeatedStartStop() {
  const dom = await freshDom();
  dom.window.fetch = () => new Promise(() => {}); // never resolves; we only care about timer behavior

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'a');
  click(dom, 'add-btn');
  await sleep(20);

  // Start/stop three times rapidly.
  click(dom, 'run-btn'); await sleep(30);
  click(dom, 'run-btn'); await sleep(30);
  click(dom, 'run-btn'); await sleep(30);
  click(dom, 'run-btn'); await sleep(30);

  // After an even number of clicks we should be stopped; elapsed text should
  // not be actively updating (interval cleared). Capture, wait, compare.
  const before = text(dom, 'run-elapsed');
  await sleep(1200);
  const after = text(dom, 'run-elapsed');
  assert(before === after, `elapsed clock should freeze after Stop, but changed from "${before}" to "${after}" (timer leak)`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 12: A failed row can be retried via the "Retry this request" link,
// which resets it to pending so the next run will pick it up.
// ---------------------------------------------------------------------
async function testRetryFailedRow() {
  const dom = await freshDom();
  dom.window.fetch = async () => ({
    ok: false, status: 401, statusText: 'Unauthorized',
    json: async () => ({ error: { message: 'bad key' } }),
  });

  setVal(dom, 'api-key', 'sk-ant-bad-key');
  setVal(dom, 'prompt-input', 'will fail once');
  click(dom, 'add-btn');
  await sleep(20);
  click(dom, 'run-btn');
  await sleep(150);

  assert(text(dom, 'stat-failed') === '1', `setup: expected 1 failed row, got ${text(dom, 'stat-failed')}`);

  const retryLink = Array.from(dom.window.document.querySelectorAll('.row-toggle'))
    .find(el => el.textContent === 'Retry this request');
  assert(!!retryLink, 'expected a "Retry this request" link on a failed row');

  retryLink.click();
  await sleep(20);

  assert(text(dom, 'stat-pending') === '1', `expected row back to pending after Retry click, got pending=${text(dom, 'stat-pending')}`);
  assert(text(dom, 'stat-failed') === '0', `expected failed count to drop to 0 after retry, got ${text(dom, 'stat-failed')}`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 13: When a 429 response includes a `retry-after` header, the backoff
// wait should honor that value rather than the default exponential schedule.
// ---------------------------------------------------------------------
async function testRetryAfterHeaderHonored() {
  const dom = await freshDom();
  let callNum = 0;
  const callTimes = [];
  dom.window.fetch = async () => {
    callNum++;
    callTimes.push(Date.now());
    if (callNum === 1) {
      return {
        ok: false, status: 429, statusText: 'Too Many Requests',
        json: async () => ({ error: { message: 'slow down' } }),
        headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '2' : null },
      };
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok now' }] }), headers: { get: () => null } };
  };

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'retry-after test');
  click(dom, 'add-btn');
  await sleep(20);
  click(dom, 'run-btn');
  await sleep(50);

  assert(callNum === 1, `expected 1st call to have fired, got ${callNum}`);

  // retry-after says 2s — well before that elapses, the retry should NOT have fired yet
  await sleep(1000);
  assert(callNum === 1, `expected retry to wait for the server's retry-after (2s), but it fired early at ~1s (callNum=${callNum})`);

  await sleep(1500); // now past 2s total
  assert(callNum === 2, `expected retry to fire once retry-after elapsed, got callNum=${callNum}`);
  assert(text(dom, 'stat-completed') === '1', `expected eventual success after the honored retry-after wait, got completed=${text(dom, 'stat-completed')}`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 14: Regression test for the reported bug — stopping mid-flight left
// a row permanently stuck on "processing" even after clicking Start again,
// because nothing ever reset its status back to "pending". This reproduces
// that exact sequence: start a run, stop while a request is in flight
// (before it resolves), then verify the row recovered to "pending" and a
// second Start actually picks it back up and completes it.
// ---------------------------------------------------------------------
async function testStuckProcessingRowRecoversAfterStop() {
  const dom = await freshDom();
  let resolveCall;
  let callCount = 0;
  dom.window.fetch = (url, opts) => {
    callCount++;
    if (callCount === 1) {
      // First call: never resolves on its own, simulating a slow in-flight
      // request that gets aborted by Stop.
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    // Second call (after resuming): resolves normally.
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'finally done' }] }) });
  };

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'prompt-input', 'the one that gets interrupted');
  click(dom, 'add-btn');
  await sleep(20);

  click(dom, 'run-btn'); // start
  await sleep(50); // call is now in-flight, frozen

  const badgeBeforeStop = dom.window.document.querySelector('.status-badge');
  assert(badgeBeforeStop.textContent === 'processing', `setup: expected row to be 'processing' before stop, got "${badgeBeforeStop.textContent}"`);

  click(dom, 'run-btn'); // stop, mid-flight — this is the exact user action that triggered the bug
  await sleep(100);

  // THE CORE REGRESSION CHECK: the row must NOT be stuck on "processing".
  const badgeAfterStop = dom.window.document.querySelector('.status-badge');
  assert(badgeAfterStop.textContent === 'pending', `BUG REPRODUCED: row stuck on "${badgeAfterStop.textContent}" after stopping mid-flight — expected it to recover to 'pending'`);
  assert(text(dom, 'stat-pending') === '1', `expected stat-pending to show 1 after recovery, got ${text(dom, 'stat-pending')}`);
  assert(text(dom, 'stat-processing') === '0', `expected stat-processing to show 0 after recovery, got ${text(dom, 'stat-processing')}`);

  // Now verify resuming actually works — this is the user's full scenario:
  // stop, then start again, and the previously-stuck row should complete normally.
  const runBtn = dom.window.document.getElementById('run-btn');
  assert(runBtn.disabled === false, 'Start queue button should be enabled again after recovery (key + pending item present)');

  click(dom, 'run-btn'); // resume
  await sleep(50);

  assert(text(dom, 'stat-completed') === '1', `expected the previously-stuck row to complete after resuming, got completed=${text(dom, 'stat-completed')}`);
  assert(callCount === 2, `expected exactly 2 fetch attempts total (1 aborted + 1 successful retry), got ${callCount}`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 15: Mode toggle switches the visible panel correctly.
// ---------------------------------------------------------------------
async function testModeToggle() {
  const dom = await freshDom();
  const textPanel = dom.window.document.getElementById('text-mode-panel');
  const filePanel = dom.window.document.getElementById('file-mode-panel');

  assert(textPanel.style.display !== 'none', 'text mode panel should be visible by default');
  assert(filePanel.style.display === 'none', 'file mode panel should be hidden by default');

  click(dom, 'mode-file-btn');
  assert(filePanel.style.display !== 'none', 'file mode panel should show after clicking "From spreadsheet"');
  assert(textPanel.style.display === 'none', 'text mode panel should hide after switching to file mode');

  click(dom, 'mode-text-btn');
  assert(textPanel.style.display !== 'none', 'text mode panel should show again after switching back');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 16: Uploading a CSV/Excel file parses rows and headers, surfaces
// column pills, and clicking a pill inserts a {placeholder} into the template.
// ---------------------------------------------------------------------
async function testFileUploadAndColumnPills() {
  const dom = await freshDom();
  installMockXLSX(dom, [
    { Name: 'Jane', Status: 'Open', Notes: 'Printer jammed' },
    { Name: 'Bob', Status: 'Closed', Notes: 'Password reset' },
  ]);

  click(dom, 'mode-file-btn');
  simulateFileUpload(dom, 'tickets.csv');
  await sleep(50);

  const templateBlock = dom.window.document.getElementById('file-template-block');
  assert(templateBlock.style.display !== 'none', 'template block should appear after a successful upload');

  const pills = dom.window.document.querySelectorAll('.column-pill');
  const pillLabels = Array.from(pills).map(p => p.textContent);
  assert(pillLabels.includes('Name') && pillLabels.includes('Status') && pillLabels.includes('Notes'),
    `expected column pills for Name/Status/Notes, got: ${pillLabels.join(', ')}`);

  assert(text(dom, 'file-row-count').includes('2'), `expected row count to mention 2 rows, got "${text(dom, 'file-row-count')}"`);

  // Clear the auto-filled default template, then click a pill and confirm it inserts correctly.
  const templateBox = dom.window.document.getElementById('row-template');
  templateBox.value = 'Ticket: ';
  templateBox.setSelectionRange(templateBox.value.length, templateBox.value.length);

  const notesPill = Array.from(pills).find(p => p.textContent === 'Notes');
  notesPill.click();
  assert(templateBox.value === 'Ticket: {Notes}', `expected pill click to insert {Notes}, got "${templateBox.value}"`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 17: Template preview reflects row 1's actual data, live as you type.
// ---------------------------------------------------------------------
async function testTemplatePreviewLive() {
  const dom = await freshDom();
  installMockXLSX(dom, [
    { Customer: 'Acme Corp', Issue: 'Login broken' },
    { Customer: 'Globex', Issue: 'Slow load times' },
  ]);

  click(dom, 'mode-file-btn');
  simulateFileUpload(dom, 'support.xlsx');
  await sleep(50);

  setVal(dom, 'row-template', 'Summarize this ticket from {Customer}: {Issue}');
  await sleep(20);

  const preview = dom.window.document.getElementById('template-preview').textContent;
  assert(preview.includes('Summarize this ticket from Acme Corp: Login broken'),
    `expected preview to show row 1 filled in, got: "${preview}"`);
  assert(!preview.includes('Globex'), 'preview should only show row 1, not other rows');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 18: Adding rows to the queue generates one queue item per row, each
// with the template correctly filled in and the original row data preserved
// (for export) without being rendered in the visible prompt text.
// ---------------------------------------------------------------------
async function testAddRowsToQueue() {
  const dom = await freshDom();
  installMockXLSX(dom, [
    { Name: 'Jane', Notes: 'Printer jammed' },
    { Name: 'Bob', Notes: 'Password reset' },
    { Name: 'Lee', Notes: 'VPN down' },
  ]);

  click(dom, 'mode-file-btn');
  simulateFileUpload(dom, 'tickets.csv');
  await sleep(50);

  setVal(dom, 'row-template', 'Help {Name} with: {Notes}');
  await sleep(20);
  click(dom, 'add-rows-btn');
  await sleep(20);

  const rows = dom.window.document.querySelectorAll('.row');
  assert(rows.length === 3, `expected 3 queue rows after adding from a 3-row file, got ${rows.length}`);

  const promptTexts = Array.from(rows).map(r => r.querySelector('.row-prompt').textContent);
  assert(promptTexts.includes('Help Jane with: Printer jammed'), `expected filled template for Jane, got: ${promptTexts.join(' | ')}`);
  assert(promptTexts.includes('Help Bob with: Password reset'), `expected filled template for Bob, got: ${promptTexts.join(' | ')}`);

  // After adding, the file panel should reset (ready for a new upload) rather
  // than leaving stale state that could cause double-adding.
  const templateBlock = dom.window.document.getElementById('file-template-block');
  assert(templateBlock.style.display === 'none', 'file template block should reset after rows are added to the queue');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 19: Unsupported file types and empty sheets are rejected with a
// clear error rather than silently failing or crashing.
// ---------------------------------------------------------------------
async function testFileValidationErrors() {
  const dom = await freshDom();

  // Unsupported extension
  click(dom, 'mode-file-btn');
  simulateFileUpload(dom, 'notes.pdf');
  await sleep(30);
  let err = dom.window.document.getElementById('file-error');
  assert(err.style.display !== 'none' && err.textContent.toLowerCase().includes('unsupported'),
    `expected an "unsupported file type" error for a .pdf, got: "${err.textContent}"`);

  // Empty sheet (XLSX present, but zero data rows)
  installMockXLSX(dom, []);
  simulateFileUpload(dom, 'empty.csv');
  await sleep(30);
  err = dom.window.document.getElementById('file-error');
  assert(err.style.display !== 'none' && err.textContent.toLowerCase().includes('empty'),
    `expected an "empty sheet" error for a file with zero rows, got: "${err.textContent}"`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 20: A sheet with inconsistent columns across rows (some cells blank
// in some rows) still produces every row with every header key, via defval,
// so a template referencing any column never silently breaks on some rows.
// ---------------------------------------------------------------------
async function testMissingColumnsHandledViaDefval() {
  const dom = await freshDom();
  // Mock XLSX.utils.sheet_to_json with defval will backfill missing keys --
  // simulate a row that's missing the "Notes" key entirely (blank cell in Excel).
  installMockXLSX(dom, [
    { Name: 'Jane', Notes: 'Printer jammed' },
    { Name: 'Bob' }, // no Notes key at all, like a blank cell
  ]);

  click(dom, 'mode-file-btn');
  simulateFileUpload(dom, 'tickets.csv');
  await sleep(50);

  setVal(dom, 'row-template', '{Name}: {Notes}');
  await sleep(20);
  click(dom, 'add-rows-btn');
  await sleep(20);

  const rows = dom.window.document.querySelectorAll('.row');
  const promptTexts = Array.from(rows).map(r => r.querySelector('.row-prompt').textContent);
  assert(promptTexts.includes('Bob: '), `expected Bob's missing Notes to render as empty string via defval, not break the template. Got: ${promptTexts.join(' | ')}`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 21: Row count cap rejects an oversized upload with a clear message
// instead of attempting to queue thousands of rows and freezing the tab.
// ---------------------------------------------------------------------
async function testRowCountCap() {
  const dom = await freshDom();
  const tooMany = Array.from({ length: 5001 }, (_, i) => ({ Name: `Row ${i}` }));
  installMockXLSX(dom, tooMany);

  click(dom, 'mode-file-btn');
  simulateFileUpload(dom, 'huge.csv');
  await sleep(80);

  const err = dom.window.document.getElementById('file-error');
  assert(err.style.display !== 'none' && err.textContent.includes('5,001'),
    `expected a row-cap error mentioning the count, got: "${err.textContent}"`);

  const templateBlock = dom.window.document.getElementById('file-template-block');
  assert(templateBlock.style.display === 'none', 'template block should stay hidden when the row cap is exceeded');

  dom.window.close();
}

// ---------------------------------------------------------------------
// TEST 22: Exported CSV includes the original spreadsheet columns alongside
// the prompt/response, correctly merging columns even when the queue has a
// mix of spreadsheet-sourced and manually-typed rows.
// ---------------------------------------------------------------------
async function testExportIncludesSourceRowColumns() {
  const dom = await freshDom();
  dom.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'handled' }] }) });

  installMockXLSX(dom, [{ Name: 'Jane', Notes: 'Printer jammed' }]);
  click(dom, 'mode-file-btn');
  simulateFileUpload(dom, 'tickets.csv');
  await sleep(50);
  setVal(dom, 'row-template', 'Help {Name}: {Notes}');
  await sleep(20);
  click(dom, 'add-rows-btn');
  await sleep(20);

  // Also add a manually-typed prompt with no source row, to confirm mixed export works.
  click(dom, 'mode-text-btn');
  setVal(dom, 'prompt-input', 'a manually typed prompt');
  click(dom, 'add-btn');
  await sleep(20);

  setVal(dom, 'api-key', 'sk-ant-test-key');
  setVal(dom, 'pace-slider', '1');
  dom.window.document.getElementById('pace-slider').dispatchEvent(new dom.window.Event('input'));
  click(dom, 'run-btn');
  await sleep(1200); // let both rows complete (1s pace between them)

  let capturedBlobText = null;
  dom.window.URL.createObjectURL = (blob) => {
    // jsdom Blob doesn't expose text() synchronously in all versions; read via FileReader-free path
    capturedBlobText = blob;
    return 'blob:mock';
  };
  dom.window.URL.revokeObjectURL = () => {};

  click(dom, 'export-csv');
  await sleep(20);

  assert(capturedBlobText !== null, 'CSV export should produce a Blob');
  // Read the Blob's content back out (jsdom Blob supports .text() as of modern versions)
  let csvContent = '';
  try {
    csvContent = await capturedBlobText.text();
  } catch (e) {
    // Fallback for older jsdom Blob shim
    csvContent = await new Promise((resolve) => {
      const reader = new dom.window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(capturedBlobText);
    });
  }

  assert(csvContent.includes('Name') && csvContent.includes('Notes'), `expected CSV header to include source columns Name/Notes, got: ${csvContent.split('\n')[0]}`);
  assert(csvContent.includes('Jane') && csvContent.includes('Printer jammed'), `expected CSV to include the original row values, got:\n${csvContent}`);
  assert(csvContent.includes('a manually typed prompt'), 'expected CSV to also include the manually-typed prompt with no source row');

  dom.window.close();
}

// ---------------------------------------------------------------------
async function main() {
  const tests = [
    ['Add prompts (bulk, blank-line filtering, trimming)', testAddPrompts],
    ['Run button gating on key + pending state', testRunButtonGating],
    ['Run lifecycle + pacing interval actually honored', testRunLifecycleAndPacing],
    ['Stop mid-run halts further calls', testStopMidRun],
    ['API error (429) handled, batch continues', testApiErrorHandling],
    ['Network-level fetch rejection caught gracefully', testNetworkFailureDoesNotCrash],
    ['Clear All disabled during run; Stop aborts in-flight fetch', testClearAllDisabledDuringRun],
    ['Export CSV does not throw, produces Blob', testExportDataIntegrity],
    ['Pace estimate math correct', testEstimateMath],
    ['Remove button disabled exactly during processing', testRemoveDisabledWhileProcessing],
    ['No timer leak across repeated Start/Stop', testNoTimerLeakOnRepeatedStartStop],
    ['Retry-failed-row link requeues a failed item', testRetryFailedRow],
    ['Non-retryable error (401) fails fast, no retry delay', testNonRetryableErrorFailsFast],
    ['retry-after header is honored over default backoff', testRetryAfterHeaderHonored],
    ['REGRESSION: stuck-processing row recovers after Stop mid-flight', testStuckProcessingRowRecoversAfterStop],
    ['Input mode toggle switches panels', testModeToggle],
    ['File upload parses rows, shows column pills, pill click inserts placeholder', testFileUploadAndColumnPills],
    ['Template preview reflects row 1 live as you type', testTemplatePreviewLive],
    ['Add rows to queue: one queue item per row, correctly filled', testAddRowsToQueue],
    ['File validation: unsupported type and empty sheet errors', testFileValidationErrors],
    ['Missing columns handled via defval, no broken templates', testMissingColumnsHandledViaDefval],
    ['Row count cap rejects oversized uploads', testRowCountCap],
    ['Export CSV includes source-row columns, handles mixed queue', testExportIncludesSourceRowColumns],
  ];

  for (const [name, fn] of tests) {
    console.log(`\n--- ${name} ---`);
    try {
      await fn();
    } catch (e) {
      fail++;
      failures.push(`${name} threw: ${e.stack}`);
      console.log('THREW:', e.message);
    }
  }

  console.log(`\n\n===== RESULTS: ${pass} passed, ${fail} failed =====`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' -', f));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
