const PROVIDERS = {
  binanceSpot: {
    origins: ["https://data-api.binance.vision"],
    prefixes: ["/api/v3/"],
    cacheSeconds: 2,
    staleSeconds: 5
  },
  yahoo: {
    origins: ["https://query1.finance.yahoo.com"],
    prefixes: ["/v8/finance/chart/"],
    cacheSeconds: 15,
    staleSeconds: 30
  },
  frankfurter: {
    origins: ["https://api.frankfurter.dev"],
    prefixes: ["/v2/rates"],
    cacheSeconds: 300,
    staleSeconds: 600
  }
};

function send(res, status, payload, cacheControl = "no-store") {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "Method not allowed. Use GET." });
  }

  const providerName = String(req.query.provider || "");
  const apiPath = String(req.query.path || "");
  const provider = PROVIDERS[providerName];

  if (!provider) {
    return send(res, 400, { error: "Unsupported market-data provider." });
  }
  if (!apiPath.startsWith("/") || apiPath.includes("://") || apiPath.includes("..") ||
      !provider.prefixes.some(prefix => apiPath.startsWith(prefix))) {
    return send(res, 400, { error: "Endpoint path is not allowlisted for this provider." });
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "provider" || key === "path") continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const cacheControl = `public, s-maxage=${provider.cacheSeconds}, stale-while-revalidate=${provider.staleSeconds}`;
  const errors = [];

  for (const origin of provider.origins) {
    const target = new URL(apiPath, origin);
    target.search = params.toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const upstream = await fetch(target.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      const contentType = upstream.headers.get("content-type") || "";
      const body = await upstream.text();

      if (!upstream.ok) {
        errors.push({ host: new URL(origin).host, status: upstream.status, body: body.slice(0, 500) });
        continue;
      }
      if (!contentType.toLowerCase().includes("json")) {
        errors.push({ host: new URL(origin).host, status: 502, message: "Upstream did not return JSON." });
        continue;
      }

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        errors.push({ host: new URL(origin).host, status: 502, message: "Upstream returned malformed JSON." });
        continue;
      }

      return send(res, 200, data, cacheControl);
    } catch (error) {
      errors.push({
        host: new URL(origin).host,
        status: error.name === "AbortError" ? 504 : 502,
        message: error.name === "AbortError" ? "Upstream request timed out after 15 seconds." : error.message
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  const last = errors[errors.length - 1] || {};
  return send(res, 502, {
    error: "All configured upstream requests failed.",
    provider: providerName,
    upstream: errors
  });
}
