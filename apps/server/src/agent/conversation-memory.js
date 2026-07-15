function clipped(value, maximum = 4000) {
  const text = String(value || "").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
}

export class ConversationMemory {
  constructor({ enabled = true, maxTurns = 10, maxCharacters = 12000, idleTimeoutMinutes = 15, now = () => Date.now() } = {}) {
    this.enabled = enabled;
    this.maxTurns = maxTurns;
    this.maxCharacters = maxCharacters;
    this.idleTimeoutMs = idleTimeoutMinutes * 60_000;
    this.now = now;
    this.sessions = new Map();
  }

  getHistory(sessionId) {
    if (!this.enabled) return [];
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    if (this.now() - session.updatedAt >= this.idleTimeoutMs) {
      this.sessions.delete(sessionId);
      return [];
    }
    session.updatedAt = this.now();
    return session.messages.map((message) => ({ ...message }));
  }

  appendTurn(sessionId, userText, assistantText) {
    if (!this.enabled) return;
    const existing = this.getHistory(sessionId);
    const messages = [
      ...existing,
      { role: "user", content: clipped(userText) },
      { role: "assistant", content: clipped(assistantText) }
    ];
    while (messages.length > this.maxTurns * 2) messages.splice(0, 2);
    while (messages.length > 2 && messages.reduce((sum, message) => sum + message.content.length, 0) > this.maxCharacters) messages.splice(0, 2);
    this.sessions.set(sessionId, { messages, updatedAt: this.now() });
  }

  clear(sessionId) {
    return this.sessions.delete(sessionId);
  }

  cleanup() {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.updatedAt >= this.idleTimeoutMs) this.sessions.delete(sessionId);
    }
  }
}
