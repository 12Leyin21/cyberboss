class TurnGateStore {
  constructor() {
    this.scopeByThreadId = new Map();
    this.pendingScopeKeys = new Map();   // scopeKey -> last activity ts (watchdog)
  }

  begin(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return "";
    }
    this.pendingScopeKeys.set(scopeKey, Date.now());
    return scopeKey;
  }

  attachThread(scopeKey, threadId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId) {
      return;
    }
    this.scopeByThreadId.set(normalizedThreadId, normalizedScopeKey);
  }

  // Runtime events keep the gate "fresh"; a wedged gate stops getting touched.
  // 运行时事件会刷新门闸时间戳；卡死的门闸不再被刷新，看门狗据此识别。
  touchThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const scopeKey = this.scopeByThreadId.get(normalizedThreadId) || "";
    if (scopeKey && this.pendingScopeKeys.has(scopeKey)) {
      this.pendingScopeKeys.set(scopeKey, Date.now());
    }
  }

  releaseScope(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    this.pendingScopeKeys.delete(scopeKey);
  }

  releaseThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const scopeKey = this.scopeByThreadId.get(normalizedThreadId) || "";
    if (scopeKey) {
      this.pendingScopeKeys.delete(scopeKey);
      this.scopeByThreadId.delete(normalizedThreadId);
    }
  }

  isPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    return scopeKey ? this.pendingScopeKeys.has(scopeKey) : false;
  }

  // Gates with no runtime activity for maxAgeMs are considered wedged.
  // 超过 maxAgeMs 没有任何运行时活动的门闸视为卡死，交给看门狗破拆。
  staleScopeKeys(maxAgeMs) {
    const now = Date.now();
    const stale = [];
    for (const [scopeKey, ts] of this.pendingScopeKeys) {
      if (now - ts > maxAgeMs) {
        stale.push(scopeKey);
      }
    }
    return stale;
  }

  forceReleaseScopeKey(scopeKey) {
    const normalized = normalizeText(scopeKey);
    if (!normalized) {
      return;
    }
    this.pendingScopeKeys.delete(normalized);
    for (const [threadId, mapped] of this.scopeByThreadId) {
      if (mapped === normalized) {
        this.scopeByThreadId.delete(threadId);
      }
    }
  }
}

function buildTurnScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TurnGateStore };
