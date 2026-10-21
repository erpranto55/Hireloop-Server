/**
 * Real-Time Server-Sent Events (SSE) Hub for HireLoop
 * Delivers instant in-app notification events to active authenticated sessions.
 */

class SSEHub {
  constructor() {
    this.clients = new Map(); // Map<normalizedEmail, Set<res>>
    this.keepAliveInterval = null;
    this.startHeartbeat();
  }

  startHeartbeat() {
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    this.keepAliveInterval = setInterval(() => {
      for (const [email, clientSet] of this.clients.entries()) {
        for (const res of clientSet) {
          try {
            res.write(": keep-alive\n\n");
          } catch {
            clientSet.delete(res);
          }
        }
        if (clientSet.size === 0) {
          this.clients.delete(email);
        }
      }
    }, 25000);

    // Unref so it won't prevent clean test shutdown
    if (this.keepAliveInterval.unref) {
      this.keepAliveInterval.unref();
    }
  }

  registerClient(email, req, res) {
    if (!email) return;
    const normalizedEmail = email.toLowerCase().trim();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`: connected at ${new Date().toISOString()}\n\n`);

    if (!this.clients.has(normalizedEmail)) {
      this.clients.set(normalizedEmail, new Set());
    }
    const clientSet = this.clients.get(normalizedEmail);
    clientSet.add(res);

    const cleanup = () => {
      clientSet.delete(res);
      if (clientSet.size === 0) {
        this.clients.delete(normalizedEmail);
      }
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  sendToUser(email, data, eventType = "notification") {
    if (!email) return 0;
    const normalizedEmail = email.toLowerCase().trim();
    const clientSet = this.clients.get(normalizedEmail);
    if (!clientSet || clientSet.size === 0) return 0;

    let sent = 0;
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const res of clientSet) {
      try {
        res.write(payload);
        sent++;
      } catch {
        clientSet.delete(res);
      }
    }

    if (clientSet.size === 0) {
      this.clients.delete(normalizedEmail);
    }

    return sent;
  }

  getActiveConnectionCount() {
    let count = 0;
    for (const clientSet of this.clients.values()) {
      count += clientSet.size;
    }
    return count;
  }

  closeAll() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    for (const clientSet of this.clients.values()) {
      for (const res of clientSet) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
    this.clients.clear();
  }
}

export const sseHub = new SSEHub();
