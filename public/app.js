function getTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function appendMessage(role, text) {
  const chatArea = document.getElementById('chatArea');
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.className = 'message ' + (isUser ? 'user' : 'bot');
  div.innerHTML = `
    <div class="avatar">${isUser ? '🧑' : '🤖'}</div>
    <div>
      <div class="bubble">${escapeHTML(text)}</div>
      <div class="timestamp">${getTime()}</div>
    </div>
  `;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function setLoading(loading) {
  document.getElementById('sendBtn').disabled = loading;
  document.getElementById('typingIndicator').classList.toggle('hidden', !loading);
  const chatArea = document.getElementById('chatArea');
  chatArea.scrollTop = chatArea.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById('messageInput');
  const message = input.value.trim();
  if (!message) return;

  appendMessage('user', message);
  input.value = '';
  input.style.height = 'auto';
  setLoading(true);

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const data = await res.json();
    appendMessage('bot', data.reply || 'Sorry, I could not process your request.');
  } catch {
    appendMessage('bot', 'Connection error. Please check your internet and try again.');
  } finally {
    setLoading(false);
  }
}

function useQuick(text) {
  document.getElementById('messageInput').value = text;
  sendMessage();
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
