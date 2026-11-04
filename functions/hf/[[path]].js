export async function onRequest(context) {
  const { request, env } = context;
  const token = env.HF_TOKEN;
  if (!token) {
    return new Response("Hugging Face token is not configured.", { status: 503 });
  }

  const incoming = new URL(request.url);
  const upstream = new URL("https://lightricks-ltx-2-5.hf.space");
  upstream.pathname = incoming.pathname.replace(/^\/hf(?=\/|$)/, "") || "/";
  upstream.search = incoming.search;

  const headers = new Headers(request.headers);
  headers.set("Authorization", "Bearer " + token);
  headers.set("Host", upstream.host);
  headers.delete("cookie");
  headers.delete("origin");

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  try {
    const upstreamResponse = await fetch(new Request(upstream.toString(), init));
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", incoming.origin);
    responseHeaders.set("Access-Control-Allow-Credentials", "true");
    responseHeaders.set("Vary", "Origin");

    const location = responseHeaders.get("Location");
    if (location) {
      responseHeaders.set("Location", location.replace("https://lightricks-ltx-2-5.hf.space", incoming.origin + "/hf"));
    }

    const contentType = responseHeaders.get("Content-Type") || "";
    if (contentType.includes("text") || contentType.includes("json") || contentType.includes("javascript")) {
      const body = await upstreamResponse.text();
      const rewritten = body
        .replaceAll("https://lightricks-ltx-2-5.hf.space", incoming.origin + "/hf")
        .replaceAll("https://huggingface.co", "https://huggingface.co");
      responseHeaders.delete("Content-Length");
      responseHeaders.delete("Content-Encoding");
      return new Response(rewritten, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
      });
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    return new Response("Unable to reach the LTX-2.5 Space: " + (error?.message || "upstream error"), { status: 502 });
  }
}
