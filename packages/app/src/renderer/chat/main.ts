import { connectToDaemon, type WsClient } from '../shared/wsClient.js';

/**
 * Chat renderer entry. Phase 0: a text box that sends chat.user_message and
 * renders streamed chat.assistant_delta -> chat.assistant_done. This exercises
 * the full renderer -> WS -> daemon -> brain -> WS -> renderer path.
 */
interface Els {
  log: HTMLElement;
  input: HTMLInputElement;
  form: HTMLFormElement;
  status: HTMLElement;
}

function els(): Els {
  return {
    log: document.getElementById('log')!,
    input: document.getElementById('input') as HTMLInputElement,
    form: document.getElementById('composer') as HTMLFormElement,
    status: document.getElementById('status')!,
  };
}

function appendBubble(log: HTMLElement, who: 'you' | 'wk'): HTMLElement {
  const row = document.createElement('div');
  row.className = `bubble bubble--${who}`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

async function main(): Promise<void> {
  const { log, input, form, status } = els();

  let client: WsClient;
  try {
    client = await connectToDaemon();
  } catch (err) {
    status.textContent = `disconnected: ${String(err)}`;
    return;
  }

  client.on('welcome', (env) => {
    status.textContent = `connected (daemon ${env.payload.daemonVersion}, host ${env.payload.host})`;
  });

  // Track the in-flight assistant bubble by messageId.
  const bubbles = new Map<string, HTMLElement>();

  client.on('chat.assistant_delta', (env) => {
    const id = env.payload.messageId ?? '_';
    let bubble = bubbles.get(id);
    if (!bubble) {
      bubble = appendBubble(log, 'wk');
      bubbles.set(id, bubble);
    }
    bubble.textContent = (bubble.textContent ?? '') + env.payload.delta;
    log.scrollTop = log.scrollHeight;
  });

  client.on('chat.assistant_done', (env) => {
    const id = env.payload.messageId ?? '_';
    const bubble = bubbles.get(id);
    if (bubble) bubble.textContent = env.payload.text;
    bubbles.delete(id);
  });

  client.on('error', (env) => {
    status.textContent = `error: ${env.payload.message}`;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const messageId = crypto.randomUUID();
    appendBubble(log, 'you').textContent = text;
    client.send('chat.user_message', { text, messageId });
    input.value = '';
  });
}

main();
