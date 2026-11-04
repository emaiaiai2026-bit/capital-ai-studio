const MAX_PROMPT_LENGTH = 3000;

export async function onRequestPost({ request }) {
  try {
    const body = await request.json();
    const text = typeof body?.text === "string" ? body.text.trim() : "";

    if (!text) {
      return Response.json({ error: "اكتب وصف الفيديو أولًا." }, { status: 400 });
    }
    if (text.length > MAX_PROMPT_LENGTH) {
      return Response.json({ error: "الوصف أطول من الحد المسموح." }, { status: 413 });
    }
    if (!/[\u0600-\u06FF]/.test(text)) {
      return Response.json({ translation: text });
    }

    const params = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: "en",
      dt: "t",
      q: text
    });
    const upstream = await fetch(
      "https://translate.googleapis.com/translate_a/single?" + params.toString(),
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(20000)
      }
    );

    if (!upstream.ok) {
      return Response.json(
        { error: "خدمة الترجمة غير متاحة حاليًا. حاول مرة أخرى بعد قليل." },
        { status: 502 }
      );
    }

    const data = await upstream.json();
    const translated = Array.isArray(data?.[0])
      ? data[0].map((part) => Array.isArray(part) ? part[0] : "").filter(Boolean).join("").trim()
      : "";

    if (!translated) {
      return Response.json(
        { error: "لم نتمكن من استخراج ترجمة واضحة للوصف. جرّب صياغة أبسط." },
        { status: 502 }
      );
    }

    return Response.json(
      { translation: translated },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return Response.json(
      { error: "حدثت مشكلة أثناء ترجمة الوصف. حاول مرة أخرى." },
      { status: 502 }
    );
  }
}
