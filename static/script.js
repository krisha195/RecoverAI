// ─── RecoverAI — Post-Discharge Companion ───────────────────────
// app.js

// ─── State ───────────────────────────────────────────────────────
let patient = {};
let msgHistory = [];
let riskScore = 15;
let symptoms = [];
let checkins = [];
let alertSent = false;
let chartsInited = false;

// ─── AI SYSTEM PROMPT ─────────────────────────────

const systemPrompt = `
You are RecoverAI, a compassionate post-discharge recovery assistant.

Your role:
1. Ask simple health check questions.
2. Detect serious symptoms.
3. Never give medical diagnosis.
4. Encourage contacting doctor if needed.

Risk Rules:
- Fever → High
- Severe pain → Moderate
- Vomiting → High
- Breathing issue → High

Respond politely and briefly.
`;

// ─── Navigation ──────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    if (n.textContent.includes(name === 'chat' ? 'Check-in' : 'Dashboard')) {
      n.classList.add('active');
    }
  });
  if (name === 'dashboard') initCharts();
}

// ─── Onboarding ──────────────────────────────────────────────────
function startSession() {
  patient.name = document.getElementById('ob-name').value || 'Patient';
  patient.age  = document.getElementById('ob-age').value  || '—';
  patient.proc = document.getElementById('ob-proc').value;
  patient.date = document.getElementById('ob-date').value;
  patient.doc  = document.getElementById('ob-doc').value  || 'Your Doctor';

  const discharge = patient.date ? new Date(patient.date) : new Date();
  const today     = new Date();
  const dayNum    = Math.max(1, Math.floor((today - discharge) / 86400000) + 1);
  patient.day     = dayNum;

  // Update sidebar chip
  document.getElementById('sp-name').textContent = patient.name;
  document.getElementById('sp-info').textContent = patient.proc;
  document.getElementById('sp-day').textContent  = 'Day ' + dayNum;
  document.getElementById('sidebar-patient').style.display = 'block';

  // Update chat header
  document.getElementById('chat-title').textContent    = 'Day ' + dayNum + ' Check-in';
  document.getElementById('chat-subtitle').textContent = patient.name + ' · ' + patient.proc;

  document.getElementById('page-onboard').classList.remove('active');
  showPage('chat');
  startCheckin();
}

// ─── Chat Utilities ───────────────────────────────────────────────
function addMsg(role, text, isAlert = false, quickReplies = []) {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const container = document.getElementById('chat-messages');

  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';

  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg ' + role + (isAlert ? ' alert-msg' : '');

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'bot' ? 'AI' : (patient.name?.charAt(0) || 'P');

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = text.replace(/\n/g, '<br>');

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.style.textAlign = role === 'user' ? 'right' : 'left';
  time.textContent = now;

  msgDiv.appendChild(avatar);
  msgDiv.appendChild(bubble);
  wrap.appendChild(msgDiv);
  wrap.appendChild(time);

  if (quickReplies.length) {
    const qrRow = document.createElement('div');
    qrRow.className = 'quick-replies';
    quickReplies.forEach(qr => {
      const btn = document.createElement('button');
      btn.className = 'qr-btn';
      btn.textContent = qr;
      btn.onclick = () => { sendQuickReply(qr); qrRow.remove(); };
      qrRow.appendChild(btn);
    });
    wrap.appendChild(qrRow);
  }

  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  msgHistory.push({ role, content: text });
}

function showTyping() {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.id = 'typing-indicator';
  div.innerHTML = `
    <div class="msg-avatar">AI</div>
    <div class="msg-bubble">
      <div class="typing">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeTyping() {
  const t = document.getElementById('typing-indicator');
  if (t) t.remove();
}

function sendMsg() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';
  addMsg('user', text);
  getBotResponse(text);
}

function sendQuickReply(text) {
  addMsg('user', text);
  getBotResponse(text);
}

// Allow Enter key to send
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('chat-input');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') sendMsg();
    });
  }

  // Pre-fill discharge date to 2 days ago
  const d = new Date();
  d.setDate(d.getDate() - 2);
  const dateInput = document.getElementById('ob-date');
  if (dateInput) dateInput.value = d.toISOString().split('T')[0];
});

// ─── AI Response via Anthropic API ───────────────────────────────
async function getBotResponse(userMsg) {

  showTyping();

  const input = document.getElementById("chat-input");
  input.disabled = true;

  try {

    const response = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: userMsg
      })
    });

    const data = await response.json();

    removeTyping();

    addMsg("bot", data.reply);

    if (data.risk) {
      updateRisk(data.risk);
    }

  } catch (error) {

    console.error(error);

    removeTyping();

    addMsg(
      "bot",
      "Server connection error. Please try again."
    );
  }

  input.disabled = false;
  input.focus();
}

// ─── Risk Panel Updates ───────────────────────────────────────────
function updateRisk(level) {
  riskScore = level === 'high' ? 80 : level === 'moderate' ? 45 : 15;
  const meter = document.getElementById('risk-meter');
  const fill  = document.getElementById('risk-fill');
  const val   = document.getElementById('risk-val');

  meter.className   = 'risk-meter risk-' + (level === 'high' ? 'high' : level === 'moderate' ? 'mod' : 'low');
  fill.style.width  = riskScore + '%';
  val.textContent   = level.charAt(0).toUpperCase() + level.slice(1);
  val.style.color   = level === 'high' ? 'var(--red)' : level === 'moderate' ? 'var(--amber)' : 'var(--green)';
}

function updateSymptoms(syms, risk) {
  symptoms = [...new Set([...symptoms, ...syms])];
  const container = document.getElementById('symptom-tags');
  container.innerHTML = '';
  symptoms.forEach(s => {
    const span = document.createElement('span');
    span.className = 'stag ' + (risk === 'high' ? 'alert' : risk === 'moderate' ? 'warn' : 'ok');
    span.textContent = s;
    container.appendChild(span);
  });
}

function updateCheckinList() {
  const list = document.getElementById('checkin-list');
  list.innerHTML = '';
  checkins.slice(-5).reverse().forEach(c => {
    const color = c.risk === 'high' ? 'var(--red)' : c.risk === 'moderate' ? 'var(--amber)' : 'var(--green)';
    list.innerHTML += `
      <div class="checkin-item">
        <div class="checkin-dot" style="background:${color}"></div>
        <span style="font-size:12px">Today, ${c.time}</span>
      </div>`;
  });
}

// ─── Start Check-in ───────────────────────────────────────────────
function startCheckin() {
  msgHistory = [];
  symptoms   = [];
  checkins   = [];
  alertSent  = false;

  const greeting = `Hello ${patient.name}! 👋 I'm RecoverAI, your recovery companion. I'm here to check in on how you're feeling on Day ${patient.day} after your ${patient.proc}.\n\nLet's start with the basics — on a scale of 0 to 10, how would you rate your pain level right now? (0 = no pain, 10 = unbearable)`;

  addMsg('bot', greeting, false, ['0 — No pain', '1-3 Mild', '4-6 Moderate', '7-9 Severe', '10 — Unbearable']);
  msgHistory = [{ role: 'assistant', content: greeting }];
}

// ─── Dashboard Charts ─────────────────────────────────────────────
function initCharts() {
  if (chartsInited) return;
  chartsInited = true;

  const days = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];

  new Chart(document.getElementById('trend-chart'), {
    type: 'line',
    data: {
      labels: days,
      datasets: [
        { label: 'High Risk',  data: [1,1,1,1,1,1,1], borderColor: '#ef4444', backgroundColor: '#fee2e220', fill: true, tension: 0.4 },
        { label: 'Moderate',   data: [2,2,2,2,2,2,1], borderColor: '#f59e0b', backgroundColor: '#fef3c720', fill: true, tension: 0.4 },
        { label: 'Low Risk',   data: [3,3,3,3,3,3,4], borderColor: '#22c55e', backgroundColor: '#dcfce720', fill: true, tension: 0.4 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
      scales: {
        y: { min: 0, ticks: { stepSize: 1, font: { size: 11 } } },
        x: { ticks: { font: { size: 11 } } }
      }
    }
  });

  new Chart(document.getElementById('symptom-chart'), {
    type: 'doughnut',
    data: {
      labels: ['Pain', 'Fatigue', 'Wound Concern', 'Mobility', 'Mood', 'Medication'],
      datasets: [{
        data: [4, 6, 2, 3, 3, 2],
        backgroundColor: ['#ef4444','#f59e0b','#ec4899','#8b5cf6','#06b6d4','#22c55e'],
        borderWidth: 2,
        borderColor: '#fff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } }
    }
  });
}

