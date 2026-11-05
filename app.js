/* FaultRead — photograph a machine fault code, get the meaning and what to try.
   Everything runs in the browser. No server, no account.                      */

const VERSION = '1.0.1';

const LS = {
  key: 'fr.apiKey',
  model: 'fr.model',
  machine: 'fr.lastMachine',
  seen: 'fr.seenSetup'
};

// Google retires models for new keys without warning, so never hard-code a
// favourite. This is only the last resort if listing the models fails.
const FALLBACK_MODEL = 'gemini-flash-latest';

const MAKES = ['Cat', 'Komatsu', 'JCB', 'Hitachi', 'Volvo', 'Kubota', 'John Deere', 'Case', 'Takeuchi', 'Other'];

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ─────────────────────────── tiny store ─────────────────────────── */

const DB_NAME = 'faultread';
const STORE = 'items';
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

const store = {
  put: (item) => tx('readwrite', (s) => s.put(item)),
  del: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
  get: (id) => tx('readonly', (s) => s.get(id)),
  all: async () => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = d.transaction(STORE, 'readonly');
      t.objectStore(STORE).openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push(c.value); c.continue(); }
      };
      t.oncomplete = () => resolve(out.sort((a, b) => b.createdAt - a.createdAt));
      t.onerror = () => reject(t.error);
    });
  }
};

/* ─────────────────────────── code table ─────────────────────────── */

let CODES = null;

async function codes() {
  if (CODES) return CODES;
  try {
    const r = await fetch('codes.json');
    CODES = await r.json();
  } catch (e) {
    CODES = { fmi: {}, spn: {}, obd: {}, families: [] };
  }
  return CODES;
}

/** Work out what kind of code this is and look up whatever is public. */
function classify(raw, table) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // SPN 3251 FMI 2  /  SPN3251 FMI2  /  3251-2  /  3251.2
  let m = s.match(/SPN\s*[:#]?\s*(\d{1,6})(?:.*?FMI\s*[:#]?\s*(\d{1,2}))?/);
  if (!m) m = s.match(/^(\d{2,6})\s*[-.:/]\s*(\d{1,2})$/);
  if (m) {
    const spn = m[1];
    const fmi = m[2];
    const param = table.spn[spn];
    const fault = fmi != null ? table.fmi[String(Number(fmi))] : null;
    return {
      family: 'j1939',
      familyLabel: 'SAE J1939 (SPN/FMI)',
      normalised: fmi != null ? `SPN ${spn} FMI ${Number(fmi)}` : `SPN ${spn}`,
      publicStandard: true,
      known: !!param,
      official: param
        ? (fault ? `${param} — ${fault}` : param)
        : null,
      officialParts: { parameter: param || null, failureMode: fault || null }
    };
  }

  // P0401, P2002, U0100, B1234, C0035
  m = s.replace(/\s/g, '').match(/^([PBCU])([0-3])([0-9A-F]{3})$/);
  if (m) {
    const code = m[1] + m[2] + m[3];
    const def = table.obd[code];
    const makerRange = m[1] === 'P' && (m[2] === '1' || m[2] === '3');
    return {
      family: 'obd2',
      familyLabel: 'OBD-II / EOBD',
      normalised: code,
      publicStandard: !makerRange,
      known: !!def,
      official: def || null,
      officialParts: { parameter: def || null, failureMode: null }
    };
  }

  // Cat event / CID
  if (/^E\d{3,4}(\s*\(\d\))?$/.test(s) || /CID\s*\d+/.test(s)) {
    return maker(s, 'cat', 'Caterpillar event or CID code');
  }
  // Komatsu
  if (/^CA\s?\d{3}$/.test(s) || /^E0?\d{1,2}$/.test(s)) {
    return maker(s, 'komatsu', 'Komatsu service code');
  }
  // Volvo / J1587
  if (/MID\s*\d+/.test(s) || /\b(PID|PPID|SID|PSID)\s*\d+/.test(s)) {
    return maker(s, 'volvo', 'J1587 MID/PID/SID code');
  }
  return maker(s, 'other', 'Manufacturer-specific code');

  function maker(norm, family, label) {
    return {
      family, familyLabel: label,
      normalised: norm,
      publicStandard: false,
      known: false,
      official: null,
      officialParts: { parameter: null, failureMode: null }
    };
  }
}

/* ─────────────────────────── Gemini ─────────────────────────── */

const API = 'https://generativelanguage.googleapis.com/v1beta';

const SYSTEM_PROMPT = `You are a diagnostic assistant for heavy plant and machinery: excavators, loaders, backhoes, telehandlers, tractors, generators and the diesel engines in them. The person using you is an operator or owner standing at the machine, often outdoors, who wants to know what a fault code means and what to check.

How to answer:
- Read the fault code off the photo EXACTLY as it is displayed. Never tidy it up, never guess at digits you cannot see. If no code is legible, set codeRead to "" and codeConfidence to "low" and say so in caveat.
- When OFFICIAL STANDARD TEXT is given to you below, that text is authoritative. Build "meaning" around it and set exactMatch true.
- When no official text is given, the code is manufacturer-specific and its exact table is not public. Set exactMatch false, say plainly in caveat that you are reasoning from the subsystem rather than quoting the maker's manual, and still give your best diagnosis.
- Rank causes by what actually fails most often on this kind of machine, not by what is most interesting.
- Order remedies so the cheapest, quickest, least invasive check comes first, and the person can stop as soon as the fault clears. Give each a realistic time and the tools genuinely needed. Never pad the list. Never write "see a qualified technician" as a step: if a job really does need dealer software or a workshop, say exactly that and why.
- severity: "stop" if continuing risks injury or expensive damage, "derate" if the machine has limited its own power, "caution" if it can work but should be fixed soon, "info" if it is advisory only.
- If the operator has added extra information, use it: let it reorder the causes, and in extraUsed say in one sentence how it changed your answer. If it made no difference, leave extraUsed empty.
- Write like a fitter talking to an operator. Plain, specific, no filler, no sales language, no emoji. Short sentences.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    codeRead: { type: 'STRING', description: 'The code exactly as shown' },
    codeConfidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    codeStandard: { type: 'STRING', description: 'e.g. SAE J1939 SPN/FMI, OBD-II, Caterpillar event code' },
    exactMatch: { type: 'BOOLEAN' },
    title: { type: 'STRING', description: 'Six to ten words naming the fault' },
    severity: { type: 'STRING', enum: ['info', 'caution', 'derate', 'stop'] },
    severityLabel: { type: 'STRING', description: 'Short line such as DERATE — FIX TODAY, KEEP WORKING' },
    meaning: { type: 'STRING', description: 'Two to four sentences in plain English' },
    causes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          likelihood: { type: 'STRING', enum: ['most likely', 'likely', 'possible', 'less likely'] },
          title: { type: 'STRING' },
          detail: { type: 'STRING' }
        },
        required: ['likelihood', 'title', 'detail']
      }
    },
    remedies: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          detail: { type: 'STRING' },
          time: { type: 'STRING', description: 'e.g. 5 min, 30 min, 2 hr' },
          tools: { type: 'STRING', description: 'e.g. No tools, Spanners, Scan tool, Part needed' }
        },
        required: ['title', 'detail', 'time', 'tools']
      }
    },
    safety: { type: 'STRING', description: 'One or two sentences, specific to this job' },
    caveat: { type: 'STRING' },
    extraUsed: { type: 'STRING' }
  },
  required: ['codeRead', 'codeConfidence', 'title', 'severity', 'severityLabel', 'meaning', 'causes', 'remedies', 'safety']
};

async function listModels(key) {
  const r = await fetch(`${API}/models?key=${encodeURIComponent(key)}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw apiError(r, body);
  return (body.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}

/** Newest stable Flash model the key can actually reach. */
function pickModel(available) {
  const ranked = available
    .filter((m) => m.startsWith('gemini-') && m.includes('flash'))
    .map((m) => {
      const v = m.match(/gemini-(\d+)(?:\.(\d+))?/);
      return {
        name: m,
        unstable: /preview|exp|thinking|\d{4}/.test(m) ? 1 : 0,
        lite: /lite/.test(m) ? 1 : 0,
        version: v ? Number(v[1]) * 1000 + Number(v[2] || 0) : 0,
        latest: /-latest$/.test(m) ? 1 : 0
      };
    })
    .sort((a, b) =>
      a.unstable - b.unstable ||
      a.lite - b.lite ||
      b.version - a.version ||
      b.latest - a.latest ||
      a.name.length - b.name.length);

  return (ranked[0] && ranked[0].name) || available[0] || FALLBACK_MODEL;
}

/** A retirement error names its replacement — "use models/gemini-X instead". */
function suggestedModel(message, current) {
  const names = String(message).match(/models\/gemini-[A-Za-z0-9._-]+/g) || [];
  return names.map((n) => n.replace('models/', '')).find((n) => n !== current) || null;
}

function apiError(res, body) {
  const msg = (body && body.error && body.error.message) || '';
  if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) {
    return new Error('That key was refused. Check you copied all of it.');
  }
  if (res.status === 403) return new Error('That key is not allowed to use this API. Create a fresh one in AI Studio.');
  if (res.status === 429) return new Error('Free tier limit reached for now. Give it a minute and try again.');
  if (res.status === 503) return new Error('Google is busy. Try again in a moment.');
  if (res.status === 404 || /no longer available|not found/i.test(msg)) {
    return new Error('That model has been retired and no replacement was offered. Pick another in Settings.');
  }
  return new Error(msg || `Request failed (${res.status}).`);
}

async function callGemini({ key, model, parts }) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA
    }
  };

  let current = model || FALLBACK_MODEL;
  let swapped = false;
  let res, json;

  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`${API}/models/${encodeURIComponent(current)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    json = await res.json().catch(() => ({}));
    if (res.ok) break;

    const msg = (json.error && json.error.message) || '';

    // The model was retired or renamed: move to whatever is current and retry.
    if (!swapped && (res.status === 404 || /no longer available|not found|not supported/i.test(msg))) {
      const next = suggestedModel(msg, current)
        || pickModel(await listModels(key).catch(() => []));
      if (next && next !== current) {
        current = next;
        swapped = true;
        app.model = next;
        localStorage.setItem(LS.model, next);
        toast('Switched to ' + next);
        continue;
      }
    }

    if (res.status !== 503 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!res.ok) throw apiError(res, json);

  const cand = (json.candidates || [])[0];
  const text = cand && cand.content && (cand.content.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    const why = cand && cand.finishReason ? ` (${cand.finishReason})` : '';
    throw new Error(`No answer came back${why}. Try again, or retake the photo.`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('The answer came back malformed. Try again.');
  }
}

/* ─────────────────────────── media helpers ─────────────────────────── */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Shrink a camera photo so the upload is quick on site. */
async function shrink(file, max = 1600, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return out && out.size < file.size ? out : file;
  } catch (e) {
    return file;
  }
}

/* ─────────────────────────── app state ─────────────────────────── */

const app = {
  key: localStorage.getItem(LS.key) || '',
  model: localStorage.getItem(LS.model) || '',
  make: '',
  photo: null,
  photoUrl: null,
  audio: null,
  audioMime: '',
  manual: false,
  current: null,      // the diagnosis on screen
  currentId: null,    // set once saved
  savedFilter: 'All',
  savedQuery: '',
  backTo: 'home'
};

function machineString() {
  const bits = [app.make, $('#in-model').value.trim(), $('#in-series').value.trim(), $('#in-year').value.trim()];
  return bits.filter(Boolean).join(' ').trim();
}

/* ─────────────────────────── navigation ─────────────────────────── */

const SCREENS = ['setup', 'home', 'details', 'working', 'result', 'saved', 'settings'];

function show(name) {
  SCREENS.forEach((s) => { $('#screen-' + s).hidden = (s !== name); });
  const scroller = $('#screen-' + name).querySelector('.pad, .scroll');
  if (scroller) scroller.scrollTop = 0;
  if (name === 'home') renderRecent();
  if (name === 'saved') renderSaved();
  if (name === 'settings') renderSettings();
}

let toastTimer = null;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5200 : 2400);
}

/* ─────────────────────────── setup screen ─────────────────────────── */

async function saveKey(value, errNode, okNode) {
  const key = value.trim();
  if (errNode) errNode.hidden = true;
  if (okNode) okNode.hidden = true;
  if (!key) {
    if (errNode) { errNode.textContent = 'Paste the key first.'; errNode.hidden = false; }
    return false;
  }
  try {
    const models = await listModels(key);
    const model = pickModel(models);
    app.key = key;
    app.model = model;
    localStorage.setItem(LS.key, key);
    localStorage.setItem(LS.model, model);
    localStorage.setItem(LS.seen, '1');
    return true;
  } catch (e) {
    if (errNode) { errNode.textContent = e.message; errNode.hidden = false; }
    return false;
  }
}

$('#key-save').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const ok = await saveKey($('#key-input').value, $('#key-error'));
  btn.disabled = false;
  btn.textContent = 'Save and check it';
  if (ok) { toast('Key saved on this phone'); show('home'); }
});

$('#key-skip').addEventListener('click', () => {
  localStorage.setItem(LS.seen, '1');
  show('home');
  updateHomeFoot();
});

/* ─────────────────────────── capture ─────────────────────────── */

function startScan() {
  if (!app.key) {
    toast('Add a Gemini key first — reading a photo needs it', true);
    show('setup');
    return;
  }
  $('#file-input').value = '';
  $('#file-input').click();
}

$('#btn-scan').addEventListener('click', startScan);
$('#btn-scan-2').addEventListener('click', startScan);
$('#btn-retake').addEventListener('click', startScan);

$('#file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  app.photo = await shrink(file);
  if (app.photoUrl) URL.revokeObjectURL(app.photoUrl);
  app.photoUrl = URL.createObjectURL(app.photo);
  app.manual = false;
  openDetails();
});

$('#btn-manual').addEventListener('click', () => {
  app.photo = null;
  app.manual = true;
  openDetails();
});

function openDetails() {
  // A fresh scan starts with a fresh note.
  $('#voice-text').value = '';
  $('#manual-code').value = '';
  app.audio = null;
  app.audioMime = '';
  $('#audio-chip').hidden = true;
  voiceStatus('');

  $('#shot-row').hidden = !app.photo;
  if (app.photo) $('#shot-thumb').src = app.photoUrl;
  $('#manual-code-field').hidden = !app.manual;
  $('#details-step').textContent = app.manual ? 'TYPE THE CODE' : 'ONE MORE THING';

  const last = localStorage.getItem(LS.machine);
  $('#btn-last-machine').hidden = !last;
  if (last) $('#last-machine-name').textContent = last;

  show('details');
  if (app.manual) setTimeout(() => $('#manual-code').focus(), 120);
}

$('#btn-last-machine').addEventListener('click', () => {
  const last = localStorage.getItem(LS.machine) || '';
  const parts = last.split(' ');
  const make = MAKES.find((m) => last.toLowerCase().startsWith(m.toLowerCase()));
  app.make = make || '';
  renderMakeChips();
  $('#in-model').value = make ? last.slice(make.length).trim() : parts.slice(1).join(' ');
  $('#in-series').value = '';
  $('#in-year').value = '';
  runDiagnosis();
});

function renderMakeChips() {
  const wrap = $('#make-chips');
  wrap.textContent = '';
  MAKES.forEach((label) => {
    const b = el('button', 'chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(app.make === label));
    b.addEventListener('click', () => {
      app.make = app.make === label ? '' : label;
      renderMakeChips();
    });
    wrap.appendChild(b);
  });
}

$('#btn-skip-machine').addEventListener('click', () => {
  app.make = '';
  renderMakeChips();
  $('#in-model').value = '';
  $('#in-series').value = '';
  $('#in-year').value = '';
  runDiagnosis();
});

$('#btn-diagnose').addEventListener('click', runDiagnosis);

/* ─────────────────────────── voice note ─────────────────────────── */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { mode: SR ? 'speech' : 'record', live: false, rec: null, mr: null, chunks: [], started: 0 };

function voiceInit() {
  $('#voice-mode-note').textContent = voice.mode === 'speech' ? '' : 'recorded for the AI to listen to';
  $('#mic-label').textContent = 'Tap and speak';
  if (voice.mode === 'record' && !(navigator.mediaDevices && window.MediaRecorder)) {
    voice.mode = 'none';
    $('#btn-mic').hidden = true;
    $('#voice-mode-note').textContent = 'type it instead';
  }
}

function setMicLive(on) {
  voice.live = on;
  $('#btn-mic').classList.toggle('live', on);
  $('#mic-label').textContent = on
    ? (voice.mode === 'speech' ? 'Listening — tap to stop' : 'Recording — tap to stop')
    : 'Tap and speak';
}

function voiceStatus(msg) {
  const n = $('#voice-status');
  if (!msg) { n.hidden = true; return; }
  n.textContent = msg;
  n.hidden = false;
}

$('#btn-mic').addEventListener('click', async () => {
  if (voice.live) { stopVoice(); return; }
  voiceStatus('');
  if (voice.mode === 'speech') startSpeech(); else startRecording();
});

function startSpeech() {
  const area = $('#voice-text');
  const base = area.value ? area.value.replace(/\s+$/, '') + ' ' : '';
  const rec = new SR();
  rec.lang = navigator.language || 'en-GB';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    area.value = base + text;
  };
  rec.onerror = (e) => {
    setMicLive(false);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      voiceStatus('Microphone blocked. Allow it in Settings, or type it below.');
    } else if (e.error === 'no-speech') {
      voiceStatus('Did not catch that.');
    } else {
      // fall back to recording the audio and letting Gemini listen
      voice.mode = 'record';
      voiceStatus('Switching to a recording instead.');
      voiceInit();
    }
  };
  rec.onend = () => setMicLive(false);

  try {
    rec.start();
    voice.rec = rec;
    setMicLive(true);
  } catch (e) {
    voiceStatus('Could not start the microphone. Type it below.');
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    voice.chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) voice.chunks.push(e.data); };
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(voice.chunks, { type: mr.mimeType || 'audio/mp4' });
      app.audio = blob;
      app.audioMime = (mr.mimeType || 'audio/mp4').split(';')[0];
      const secs = Math.max(1, Math.round((Date.now() - voice.started) / 1000));
      $('#audio-chip-label').textContent = `Recording attached — ${secs}s`;
      $('#audio-chip').hidden = false;
      setMicLive(false);
    };
    voice.mr = mr;
    voice.started = Date.now();
    mr.start();
    setMicLive(true);
  } catch (e) {
    setMicLive(false);
    voiceStatus('Microphone blocked. Allow it in Settings, or type it below.');
  }
}

function stopVoice() {
  if (voice.rec) { try { voice.rec.stop(); } catch (e) {} voice.rec = null; }
  if (voice.mr && voice.mr.state !== 'inactive') { voice.mr.stop(); voice.mr = null; }
  setMicLive(false);
}

$('#audio-clear').addEventListener('click', () => {
  app.audio = null;
  app.audioMime = '';
  $('#audio-chip').hidden = true;
});

/* ─────────────────────────── the diagnosis run ─────────────────────────── */

const STEPS = [
  ['Reading the code from the photo', 'Sent to Gemini, which reads it and diagnoses in one pass'],
  ['Matching it to a standard', 'Checking the J1939 and OBD-II tables held on this phone'],
  ['Narrowing to your machine', 'Make, model and anything you said'],
  ['Ordering the remedies', 'Cheapest and quickest checks first']
];

function renderProgress(activeIndex) {
  const ul = $('#progress');
  ul.textContent = '';
  STEPS.forEach(([label, detail], i) => {
    const li = el('li', i < activeIndex ? 'done' : i === activeIndex ? 'now' : '');
    const ring = el('span', 'ring');
    ring.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    const main = el('span');
    const lab = el('span', 'label', label);
    lab.appendChild(el('span', 'detail', detail));
    main.appendChild(lab);
    li.appendChild(ring);
    li.appendChild(main);
    ul.appendChild(li);
  });
}

async function runDiagnosis() {
  stopVoice();

  const typed = app.manual ? $('#manual-code').value.trim() : '';
  const notes = $('#voice-text').value.trim();
  const machine = machineString();

  if (app.manual && !typed) { toast('Type the code first', true); $('#manual-code').focus(); return; }
  if (!app.manual && !app.photo) { toast('Take a photo first', true); return; }

  if (machine) localStorage.setItem(LS.machine, machine);

  const table = await codes();
  const hit = typed ? classify(typed, table) : null;

  // No key and a typed code: answer offline from the public table.
  if (!app.key) {
    if (hit && hit.known) { showOfflineResult(hit, machine, notes); return; }
    toast('Offline lookup has nothing for that code. A Gemini key is needed.', true);
    show('setup');
    return;
  }

  $('#working-code').textContent = hit ? hit.normalised : (typed || 'Reading the photo');
  $('#working-machine').textContent = machine || 'Machine not given';
  $('#working-title').textContent = 'Working it out';
  renderProgress(0);
  show('working');

  const tick = [1, 2, 3].map((i, n) => setTimeout(() => renderProgress(i), 1400 + n * 1500));

  try {
    const parts = [];

    if (app.photo) {
      parts.push({ inlineData: { mimeType: app.photo.type || 'image/jpeg', data: await blobToBase64(app.photo) } });
    }
    if (app.audio) {
      parts.push({ inlineData: { mimeType: app.audioMime || 'audio/mp4', data: await blobToBase64(app.audio) } });
    }

    const lines = [];
    lines.push(app.photo
      ? 'The photo shows a fault code on a machine display or a printout. Read it and diagnose it.'
      : 'Diagnose this fault code.');
    if (typed) lines.push(`The operator typed the code as: ${typed}`);
    lines.push(machine ? `MACHINE: ${machine}` : 'MACHINE: not given — keep the answer general and say so.');
    if (hit) {
      lines.push(`CODE FAMILY: ${hit.familyLabel}`);
      if (hit.official) {
        lines.push(`OFFICIAL STANDARD TEXT (authoritative, use it): ${hit.official}`);
      } else if (!hit.publicStandard) {
        lines.push('This looks manufacturer-specific. No public table defines it, so reason from the subsystem and say so.');
      }
    }
    if (notes) lines.push(`EXTRA INFORMATION FROM THE OPERATOR: ${notes}`);
    if (app.audio && !notes) lines.push('The operator has also recorded a spoken note. Listen to it and use it.');
    parts.push({ text: lines.join('\n') });

    const result = await callGemini({ key: app.key, model: app.model || FALLBACK_MODEL, parts });

    // Second look at the local table now that we know what was read.
    const readHit = classify(result.codeRead || typed, table);
    if (readHit && readHit.official) {
      result.official = readHit.official;
      result.exactMatch = true;
      result.codeStandard = result.codeStandard || readHit.familyLabel;
    } else if (readHit && !readHit.publicStandard) {
      result.exactMatch = false;
    }

    tick.forEach(clearTimeout);
    presentResult({
      result,
      machine,
      notes,
      code: result.codeRead || typed,
      photo: app.photo,
      audio: app.audio
    });
  } catch (e) {
    tick.forEach(clearTimeout);
    show('details');
    toast(e.message || 'Something went wrong', true);
  }
}

/** Offline answer: the public standard text, honestly labelled, no remedies invented. */
function showOfflineResult(hit, machine, notes) {
  presentResult({
    result: {
      codeRead: hit.normalised,
      codeConfidence: 'high',
      codeStandard: hit.familyLabel,
      exactMatch: true,
      offlineOnly: true,
      title: hit.officialParts.parameter || hit.normalised,
      severity: 'info',
      severityLabel: 'OFFLINE LOOKUP — NO DIAGNOSIS',
      meaning: hit.official,
      official: hit.official,
      causes: [],
      remedies: [],
      safety: 'Treat this as the dictionary definition only. It has not been read against your machine.',
      caveat: 'This came from the code table bundled with the app, with no AI involved. Add a Gemini key, or get a signal, for the causes and the remedies.'
    },
    machine, notes, code: hit.normalised, photo: null, audio: null
  });
}

/* ─────────────────────────── result rendering ─────────────────────────── */

const SEV_CLASS = { info: 'sev-info', caution: 'sev-caution', derate: 'sev-derate', stop: 'sev-stop' };
const LIKELIHOOD_CLASS = { 'most likely': 'tag-hot', likely: 'tag-hot', possible: 'tag-cool', 'less likely': 'tag-cool' };

function presentResult(payload) {
  app.current = payload;
  app.currentId = payload.id || null;
  setSaveState(!!payload.id);
  $('#result-back').onclick = () => show(app.backTo);
  renderResult(payload);
  show('result');
}

function section(title, nodes) {
  const wrap = el('div');
  if (title) {
    const h = el('h2', 'eyebrow block', title);
    wrap.appendChild(h);
  }
  nodes.forEach((n) => wrap.appendChild(n));
  return wrap;
}

function renderResult(payload) {
  const r = payload.result;
  const body = $('#result-body');
  body.textContent = '';

  // hero
  const hero = el('div');
  const sev = el('span', 'sev ' + (SEV_CLASS[r.severity] || 'sev-caution'));
  sev.appendChild(el('span', 'dot'));
  sev.appendChild(el('span', null, r.severityLabel || r.severity.toUpperCase()));
  hero.appendChild(sev);
  hero.appendChild(el('h1', 'code-hero', r.codeRead || payload.code || '—'));
  const sub = [payload.machine, r.codeStandard].filter(Boolean).join(' · ');
  if (sub) hero.appendChild(el('p', 'fine', sub));
  body.appendChild(hero);

  if (r.title) {
    const t = el('p');
    t.style.fontSize = '17px';
    t.style.fontWeight = '600';
    t.style.lineHeight = '1.35';
    t.textContent = r.title;
    body.appendChild(t);
  }

  // low confidence warning
  if (r.codeConfidence === 'low' || r.codeConfidence === 'medium') {
    body.appendChild(note('warn', `Not certain it read the code right${r.codeRead ? ` (${r.codeRead})` : ''}. Check it against the display, and correct it below if it is wrong.`));
  }

  // meaning
  body.appendChild(section('WHAT IT MEANS', [(() => {
    const p = el('p');
    p.style.fontSize = '15.5px';
    p.style.lineHeight = '1.55';
    p.textContent = r.meaning || '';
    return p;
  })()]));

  // exact match marker
  if (r.exactMatch) {
    body.appendChild(tagLine('tag-good', 'EXACT MATCH IN THE PUBLIC TABLE'));
  } else {
    body.appendChild(note('info', r.caveat || 'No public table defines this code, so this is reasoned from the subsystem rather than quoted from the maker\'s manual.'));
  }

  // causes
  if (r.causes && r.causes.length) {
    body.appendChild(section('WHY IT HAPPENS', r.causes.map((c) => {
      const card = el('div', 'card');
      card.appendChild(tagLine(LIKELIHOOD_CLASS[c.likelihood] || 'tag-cool', (c.likelihood || '').toUpperCase()));
      card.appendChild(el('p', 'card-title', c.title));
      card.appendChild(el('p', 'card-detail', c.detail));
      return card;
    })));
  }

  // remedies
  if (r.remedies && r.remedies.length) {
    const intro = el('p', 'fine');
    intro.textContent = 'Quickest and cheapest first. Stop as soon as the code clears.';
    intro.style.marginBottom = '12px';
    const cards = r.remedies.map((f, i) => {
      const card = el('div', 'card bordered');
      const row = el('div', 'numbered');
      row.appendChild(el('span', 'num', String(i + 1)));
      const main = el('div');
      main.style.flexGrow = '1';
      main.style.minWidth = '0';
      main.appendChild(el('p', 'card-title', f.title));
      main.appendChild(el('p', 'card-detail', f.detail));
      const chips = el('div', 'meta-chips');
      if (f.time) chips.appendChild(el('span', 'meta-chip', f.time));
      if (f.tools) chips.appendChild(el('span', 'meta-chip', f.tools));
      main.appendChild(chips);
      row.appendChild(main);
      card.appendChild(row);
      return card;
    });
    body.appendChild(section('WHAT TO TRY', [intro, ...cards]));
  }

  // what the voice note changed
  if (r.extraUsed) {
    body.appendChild(note('info', r.extraUsed));
  }

  // safety
  if (r.safety) body.appendChild(note('warn', r.safety));

  // the operator's own note
  if (payload.notes) {
    body.appendChild(section('WHAT YOU ADDED', [(() => {
      const card = el('div', 'card');
      const p = el('p', 'card-detail', payload.notes);
      p.style.margin = '0';
      card.appendChild(p);
      return card;
    })()]));
  }

  // the photo
  if (payload.photo) {
    const img = el('img', 'result-photo');
    img.alt = 'The photo of the fault code';
    img.src = payload.photoUrl || (payload.photoUrl = URL.createObjectURL(payload.photo));
    body.appendChild(section('THE PHOTO', [img]));
  }

  // correct the code
  const fix = el('div', 'card');
  fix.appendChild(el('p', 'card-title', 'Read the code wrong?'));
  fix.appendChild(el('p', 'card-detail', 'Type what the display actually says and it will run again.'));
  const fixRow = el('div');
  fixRow.style.display = 'flex';
  fixRow.style.gap = '8px';
  fixRow.style.marginTop = '11px';
  const fixInput = el('input');
  fixInput.type = 'text';
  fixInput.className = 'mono';
  fixInput.value = r.codeRead || payload.code || '';
  fixInput.setAttribute('autocapitalize', 'characters');
  fixInput.setAttribute('autocorrect', 'off');
  Object.assign(fixInput.style, {
    flexGrow: '1', minWidth: '0', minHeight: '46px', background: 'var(--card-2)',
    border: '1px solid var(--line)', borderRadius: '11px', padding: '0 13px',
    color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: '15px'
  });
  const fixBtn = el('button', null, 'Re-run');
  fixBtn.type = 'button';
  Object.assign(fixBtn.style, {
    flexShrink: '0', minHeight: '46px', padding: '0 16px', border: '0',
    borderRadius: '11px', background: 'var(--accent)', color: 'var(--accent-ink)',
    fontSize: '14.5px', fontWeight: '700', cursor: 'pointer'
  });
  fixBtn.addEventListener('click', () => {
    const v = fixInput.value.trim();
    if (!v) return;
    app.manual = true;
    app.photo = payload.photo || null;
    $('#manual-code').value = v;
    $('#voice-text').value = payload.notes || '';
    runDiagnosis();
  });
  fixRow.appendChild(fixInput);
  fixRow.appendChild(fixBtn);
  fix.appendChild(fixRow);
  body.appendChild(fix);

  // actions
  const actions = el('div');
  actions.style.display = 'flex';
  actions.style.flexDirection = 'column';
  actions.style.gap = '10px';

  if (payload.id) {
    const status = payload.status === 'fixed' ? 'fixed' : 'open';
    const mark = el('button', 'btn btn-outline', status === 'fixed' ? 'Mark as still open' : 'Mark as fixed');
    mark.type = 'button';
    mark.addEventListener('click', async () => {
      payload.status = status === 'fixed' ? 'open' : 'fixed';
      await persist(payload);
      toast(payload.status === 'fixed' ? 'Marked fixed' : 'Marked open');
      renderResult(payload);
    });
    actions.appendChild(mark);

    const del = el('button', 'btn btn-quiet danger', 'Delete this one');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this diagnosis?')) return;
      await store.del(payload.id);
      toast('Deleted');
      show('saved');
    });
    actions.appendChild(del);
  } else {
    const save = el('button', 'btn btn-primary', payload.photo ? 'Save with the photo' : 'Save this');
    save.type = 'button';
    save.addEventListener('click', saveCurrent);
    actions.appendChild(save);
  }

  const again = el('button', 'btn btn-outline', 'Scan another code');
  again.type = 'button';
  again.addEventListener('click', startScan);
  actions.appendChild(again);

  body.appendChild(actions);
}

function tagLine(cls, text) {
  const wrap = el('div');
  wrap.style.marginBottom = '5px';
  wrap.appendChild(el('span', 'tag ' + cls, text));
  return wrap;
}

function note(kind, text) {
  const n = el('div', 'note note-' + kind);
  n.innerHTML = kind === 'warn'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 21 19H3z"/><path d="M12 9.5v4M12 16.5h.01"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
  n.appendChild(el('p', null, text));
  return n;
}

/* ─────────────────────────── saving ─────────────────────────── */

function setSaveState(on) {
  const btn = $('#btn-save');
  btn.setAttribute('aria-pressed', String(!!on));
  $('#save-label').textContent = on ? 'Saved' : 'Save';
}

async function persist(payload) {
  if (!payload.id) {
    payload.id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    payload.createdAt = Date.now();
    payload.status = 'open';
  }
  await store.put({
    id: payload.id,
    createdAt: payload.createdAt,
    status: payload.status || 'open',
    code: payload.result.codeRead || payload.code || '',
    machine: payload.machine || '',
    notes: payload.notes || '',
    result: payload.result,
    photo: payload.photo || null,
    audio: payload.audio || null
  });
  app.currentId = payload.id;
  setSaveState(true);
  return payload.id;
}

async function saveCurrent() {
  if (!app.current) return;
  if (app.current.id) { toast('Already saved'); return; }
  await persist(app.current);
  toast('Saved on this phone');
  renderResult(app.current);
}

$('#btn-save').addEventListener('click', async () => {
  if (!app.current) return;
  if (app.current.id) { show('saved'); return; }
  await saveCurrent();
});

$('#btn-share').addEventListener('click', async () => {
  if (!app.current) return;
  const r = app.current.result;
  const lines = [
    `${r.codeRead || app.current.code}${app.current.machine ? ' — ' + app.current.machine : ''}`,
    '',
    r.title || '',
    '',
    r.meaning || ''
  ];
  if (r.remedies && r.remedies.length) {
    lines.push('', 'What to try:');
    r.remedies.forEach((f, i) => lines.push(`${i + 1}. ${f.title} (${f.time}, ${f.tools}) — ${f.detail}`));
  }
  const text = lines.join('\n');
  try {
    if (navigator.share) await navigator.share({ title: 'Fault code ' + (r.codeRead || ''), text });
    else { await navigator.clipboard.writeText(text); toast('Copied'); }
  } catch (e) { /* user cancelled */ }
});

/* ─────────────────────────── recent + saved ─────────────────────────── */

const SEV_DOT = { info: 'var(--info)', caution: 'var(--accent)', derate: 'var(--accent)', stop: 'var(--bad)' };

function when(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((now - d) / 86400000);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

async function renderRecent() {
  const wrap = $('#home-recent');
  wrap.textContent = '';
  const items = (await store.all()).slice(0, 3);
  if (!items.length) {
    const p = el('p', 'fine', 'Nothing saved yet. Your scans will land here.');
    wrap.appendChild(p);
    return;
  }
  items.forEach((it) => {
    const row = el('button', 'saved-item');
    row.type = 'button';
    const dot = el('span');
    Object.assign(dot.style, {
      width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0', marginTop: '6px',
      background: it.status === 'fixed' ? 'var(--good)' : (SEV_DOT[it.result.severity] || 'var(--accent)')
    });
    const main = el('span', 'saved-main');
    main.appendChild(el('span', 'saved-code', it.code || '—'));
    main.appendChild(el('span', 'saved-machine', it.machine || 'Machine not given'));
    const side = el('span', 'saved-side');
    side.appendChild(el('span', 'saved-when', when(it.createdAt)));
    row.appendChild(dot);
    row.appendChild(main);
    row.appendChild(side);
    row.addEventListener('click', () => openSaved(it, 'home'));
    wrap.appendChild(row);
  });
}

function openSaved(item, backTo) {
  app.backTo = backTo || 'saved';
  presentResult({
    id: item.id,
    createdAt: item.createdAt,
    status: item.status,
    result: item.result,
    machine: item.machine,
    notes: item.notes,
    code: item.code,
    photo: item.photo,
    audio: item.audio
  });
}

const SAVED_FILTERS = ['All', 'Open', 'Fixed'];

function renderSavedFilters() {
  const wrap = $('#saved-filters');
  wrap.className = 'chips pills';
  wrap.textContent = '';
  SAVED_FILTERS.forEach((label) => {
    const b = el('button', 'chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(app.savedFilter === label));
    b.addEventListener('click', () => { app.savedFilter = label; renderSaved(); });
    wrap.appendChild(b);
  });
}

async function renderSaved() {
  renderSavedFilters();
  const list = $('#saved-list');
  list.textContent = '';

  let items = await store.all();
  const q = app.savedQuery.trim().toLowerCase();
  if (app.savedFilter === 'Open') items = items.filter((i) => i.status !== 'fixed');
  if (app.savedFilter === 'Fixed') items = items.filter((i) => i.status === 'fixed');
  if (q) {
    items = items.filter((i) =>
      (i.code + ' ' + i.machine + ' ' + i.notes + ' ' + (i.result.title || '')).toLowerCase().includes(q));
  }

  if (!items.length) {
    const empty = el('div', 'empty');
    empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';
    empty.appendChild(el('p', null, q || app.savedFilter !== 'All' ? 'Nothing matches.' : 'Nothing saved yet. Scan a code and press Save.'));
    list.appendChild(empty);
    return;
  }

  const groups = [['TODAY', []], ['THIS WEEK', []], ['EARLIER', []]];
  const now = new Date();
  items.forEach((it) => {
    const d = new Date(it.createdAt);
    const days = (now - d) / 86400000;
    if (d.toDateString() === now.toDateString()) groups[0][1].push(it);
    else if (days < 7) groups[1][1].push(it);
    else groups[2][1].push(it);
  });

  groups.forEach(([label, rows]) => {
    if (!rows.length) return;
    list.appendChild(el('h2', 'group-label', label));
    const box = el('div', 'flow-tight');
    rows.forEach((it) => box.appendChild(savedRow(it)));
    list.appendChild(box);
  });

  const foot = el('p', 'fine center');
  foot.style.marginTop = '18px';
  foot.textContent = 'Held on this phone only. Export makes a PDF you can hand to a mechanic.';
  list.appendChild(foot);
}

function savedRow(it) {
  const row = el('button', 'saved-item');
  row.type = 'button';

  if (it.photo) {
    const img = el('img', 'saved-thumb');
    img.alt = '';
    img.src = URL.createObjectURL(it.photo);
    row.appendChild(img);
  } else {
    const blank = el('span', 'saved-thumb blank', (it.code || '—').replace(/\s+/g, '\n'));
    blank.style.whiteSpace = 'pre-line';
    row.appendChild(blank);
  }

  const main = el('span', 'saved-main');
  main.appendChild(el('span', 'saved-code', it.code || '—'));
  main.appendChild(el('span', 'saved-title', it.result.title || ''));
  main.appendChild(el('span', 'saved-machine', it.machine || 'Machine not given'));
  row.appendChild(main);

  const side = el('span', 'saved-side');
  const chip = el('span', 'tag ' + (it.status === 'fixed' ? 'tag-good' : 'tag-hot'), it.status === 'fixed' ? 'FIXED' : 'OPEN');
  side.appendChild(chip);
  side.appendChild(el('span', 'saved-when', when(it.createdAt)));
  row.appendChild(side);

  row.addEventListener('click', () => openSaved(it, 'saved'));
  return row;
}

$('#saved-q').addEventListener('input', (e) => {
  app.savedQuery = e.target.value;
  renderSaved();
});

/* ─────────────────────────── export to PDF ─────────────────────────── */

$('#btn-export').addEventListener('click', async () => {
  const items = await store.all();
  if (!items.length) { toast('Nothing to export yet', true); return; }

  const root = document.getElementById('print-root') || (() => {
    const n = el('div');
    n.id = 'print-root';
    document.body.appendChild(n);
    return n;
  })();
  root.textContent = '';

  const h = el('h1', null, 'Fault codes — FaultRead');
  root.appendChild(h);
  root.appendChild(el('p', 'fine', new Date().toLocaleString()));

  items.forEach((it) => {
    const box = el('div', 'print-item');
    box.appendChild(el('h2', null, `${it.code || '—'} — ${it.result.title || ''}`));
    box.appendChild(el('p', 'fine', [it.machine, new Date(it.createdAt).toLocaleString(), it.status === 'fixed' ? 'FIXED' : 'OPEN'].filter(Boolean).join(' · ')));
    box.appendChild(el('p', null, it.result.meaning || ''));
    if (it.notes) box.appendChild(el('p', 'fine', 'Operator note: ' + it.notes));
    if (it.result.remedies && it.result.remedies.length) {
      const ol = el('ol');
      it.result.remedies.forEach((f) => {
        const li = el('li', null, `${f.title} (${f.time}, ${f.tools}) — ${f.detail}`);
        ol.appendChild(li);
      });
      box.appendChild(ol);
    }
    root.appendChild(box);
  });

  setTimeout(() => window.print(), 60);
});

/* ─────────────────────────── settings ─────────────────────────── */

async function renderSettings() {
  $('#set-key').value = app.key ? app.key : '';
  $('#set-key-state').textContent = app.key ? 'Set on this phone.' : 'Not set — photo reading is off, offline lookup still works.';
  $('#set-error').hidden = true;
  $('#set-ok').hidden = true;
  $('#set-version').textContent = `FaultRead ${VERSION} · code table ${(await codes()).version || '—'}`;

  const sel = $('#set-model');
  sel.textContent = '';
  const add = (name) => {
    const o = el('option', null, name);
    o.value = name;
    if (name === app.model) o.selected = true;
    sel.appendChild(o);
  };
  if (app.model) add(app.model);
  if (app.key) {
    try {
      const models = await listModels(app.key);
      sel.textContent = '';
      const usable = models.filter((m) => m.includes('flash') || m.includes('pro'));
      const best = pickModel(usable);
      // Best first, so the obvious choice is the one already selected.
      [best, ...usable.filter((m) => m !== best)].forEach(add);
      if (!models.includes(app.model) && app.model) add(app.model);
    } catch (e) { /* keep what we have */ }
  }

  const items = await store.all();
  $('#set-count').textContent = String(items.length);
}

$('#set-save').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const typed = $('#set-key').value.trim();
  btn.disabled = true;
  btn.textContent = 'Checking…';

  let ok = true;
  if (typed && typed !== app.key) {
    ok = await saveKey(typed, $('#set-error'));
  } else if (!typed) {
    app.key = '';
    localStorage.removeItem(LS.key);
  }
  if (ok) {
    const chosen = $('#set-model').value;
    if (chosen) { app.model = chosen; localStorage.setItem(LS.model, chosen); }
    $('#set-ok').hidden = false;
  }
  btn.disabled = false;
  btn.textContent = 'Save';
  updateHomeFoot();
});

$('#set-wipe').addEventListener('click', async () => {
  if (!confirm('Delete every saved diagnosis and the API key from this phone?')) return;
  await store.clear();
  localStorage.removeItem(LS.key);
  localStorage.removeItem(LS.model);
  localStorage.removeItem(LS.machine);
  app.key = '';
  app.model = '';
  toast('Everything deleted');
  renderSettings();
  updateHomeFoot();
});

function updateHomeFoot() {
  $('#home-foot').textContent = app.key
    ? 'Standard codes are matched on this phone first. Photos go to Gemini to be read.'
    : 'No key set — typed codes get an offline lookup only. Add a key in Settings.';
}

/* ─────────────────────────── wiring ─────────────────────────── */

document.querySelectorAll('[data-go]').forEach((b) => {
  b.addEventListener('click', () => show(b.getAttribute('data-go')));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stopVoice();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

renderMakeChips();
voiceInit();
updateHomeFoot();
codes();
show(localStorage.getItem(LS.seen) ? 'home' : 'setup');
