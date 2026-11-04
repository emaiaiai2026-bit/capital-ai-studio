const MAX_PROMPT_LENGTH = 3000;
const HF_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";
const HF_MODEL = "Qwen/Qwen2.5-7B-Instruct:fastest";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    // Accept only same-origin browser requests when an Origin header is present.
    const origin = request.headers.get("Origin");
    if (origin) {
      const requestOrigin = new URL(request.url).origin;
      if (origin !== requestOrigin) return json({ error: "الطلب غير مسموح." }, 403);
    }

    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return json({ error: "صيغة الطلب غير صحيحة." }, 415);
    }

    const token = env?.HF_TOKEN;
    if (typeof token !== "string" || !token.trim()) {
      return json({ error: "إعداد خدمة الترجمة غير مكتمل. يرجى مراجعة إعدادات الموقع." }, 503);
    }

    const body = await request.json();
    const sourceText = typeof body?.text === "string" ? body.text.trim() : "";

    if (!sourceText) return json({ error: "اكتب وصف الفيديو أولًا." }, 400);
    if (sourceText.length > MAX_PROMPT_LENGTH) {
      return json({ error: "الوصف أطول من الحد المسموح." }, 413);
    }

    // Do not spend inference quota on prompts that are already English.
    if (!/[\u0600-\u06FF]/.test(sourceText)) return json({ translation: sourceText });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let upstream;
    try {
      upstream = await fetch(HF_CHAT_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          model: HF_MODEL,
          messages: [
            {
              role: "system",
              content: "You are a professional Arabic-to-English translator for text-to-video prompts. Translate the user's prompt faithfully into clear, natural English. Preserve every visual detail, setting, action, camera instruction, style, and constraint. Do not add new objects, people, events, dialogue, narration, subtitles, or audio instructions that are not present in the source. Do not answer the prompt or describe what you would do. Return only the English translation, with no preface, labels, quotation marks, or explanation."
            },
            { role: "user", content: sourceText }
          ],
          temperature: 0.1,
          max_tokens: 600,
          stream: false
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      // Keep provider diagnostics and credentials out of the public response.
      if (upstream.status === 401 || upstream.status === 403) {
        return json({ error: "تعذّر التحقق من مفتاح الترجمة. راجع صلاحية HF_TOKEN." }, 502);
      }
      if (upstream.status === 429) {
        return json({ error: "خدمة الترجمة مشغولة حاليًا أو وصلت إلى حد الاستخدام. حاول لاحقًا." }, 503);
      }
      return json({ error: "تعذّر الاتصال بخدمة الترجمة حاليًا. حاول مرة أخرى." }, 502);
    }

    const data = await upstream.json();
    const translated = data?.choices?.[0]?.message?.content;
    if (typeof translated !== "string" || !translated.trim()) {
      return json({ error: "لم تُرجع خدمة الترجمة نتيجة واضحة. جرّب وصفًا أبسط." }, 502);
    }

    // Remove accidental surrounding code fences/quotes without changing the translation.
    const cleanTranslation = translated
      .trim()
      .replace(/^\`\`\`(?:[a-zA-Z]+)?\s*/, "")
      .replace(/\s*\`\`\`$/, "")
      .replace(/^["“”']|["“”']$/g, "")
      .trim();

    if (!cleanTranslation) {
      return json({ error: "لم نتمكن من استخراج الترجمة. حاول بصياغة أخرى." }, 502);
    }

    return json({ translation: cleanTranslation });
  } catch (error) {
    if (error?.name === "AbortError") {
      return json({ error: "استغرقت الترجمة وقتًا أطول من المتوقع. حاول مرة أخرى." }, 504);
    }
    return json({ error: "حدثت مشكلة أثناء الترجمة. حاول مرة أخرى." }, 502);
  }
}
