/**
 * In-memory sliding window rate limiter for Express routes.
 *
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000ms / 1 min)
 * @param {number} options.max - Max requests per window per IP (default: 100)
 * @param {string} options.message - Error message when rate limit exceeded
 */
export function rateLimiter({
  windowMs = 60 * 1000,
  max = 100,
  message = "Too many requests, please try again later.",
} = {}) {
  const requests = new Map();

  // Periodic cleanup every 5 minutes to avoid memory leaks
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of requests.entries()) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        requests.delete(key);
      } else {
        requests.set(key, valid);
      }
    }
  }, 5 * 60 * 1000);

  if (interval.unref) interval.unref();

  return (req, res, next) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    const clientTimestamps = requests.get(ip) || [];
    const recentRequests = clientTimestamps.filter((t) => now - t < windowMs);

    if (recentRequests.length >= max) {
      const retryAfterSec = Math.ceil((recentRequests[0] + windowMs - now) / 1000);
      res.setHeader("Retry-After", Math.max(retryAfterSec, 1));
      return res.status(429).json({ message });
    }

    recentRequests.push(now);
    requests.set(ip, recentRequests);
    next();
  };
}
