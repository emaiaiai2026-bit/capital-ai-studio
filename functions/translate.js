const MAX_PROMPT_LENGTH = 3000;
const HF_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";
// Listed by Hugging Face as a recommended chat-completion model.
const HF_MODEL = "Qwen/Qwen2.5-7B-Instruct-1M:fastest";

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
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) {
      return json({ error: "الطلب غير مسموح." }, 403);
    }

    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return json({ error: "صيغة الطلب غير صحيحة." }, 415);
    }

    const body = await request.json();
    const sourceText = typeof body?.text === "string" ? body.text.trim() : "";
    if (!sourceText) return json({ error: "اكتب وصف الفيديو أولًا." }, 400);
    if (sourceText.length > MAX_PROMPT_LENGTH) {
      return json({ error: "الوصف أطول من الحد المسموح." }, 413);
    }
    if (!/[\u0600-\u06FF]/.test(sourceText)) return json({ translation: sourceText });

    const token = env?.HF_TOKEN;
    if (typeof token !== "string" || !token.trim()) {
      return json({ error: "إعداد خدمة الترجمة غير مكتمل. راجع سر HF_TOKEN في Cloudflare." }, 503);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const upstream = await fetch(HF_CHAT_URL, {
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
              content: "Translate the user's Arabic text faithfully into clear English for a text-to-video model. Preserve all visual details, scene, actions, camera movement, style, and constraints. Do not add content, people, dialogue, narration, subtitles, or audio details. Do not answer the prompt. Return only the English translation."
            },
            { role: "user", content: sourceText }
          ],
          temperature: 0.1,
          max_tokens: 700,
          stream: false
        }),
        signal: controller.signal
      });

      const raw = await upstream.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { /* invalid provider response */ }

      if (!upstream.ok) {
        // Detailed server-side diagnostic, with no token or prompt content.
        console.error("HF translation provider error", {
          status: upstream.status,
          model: HF_MODEL,
          providerMessage: typeof data?.error === "string" ? data.error.slice(0, 400) : "non-JSON response"
        });

        if (upstream.status === 401 || upstream.status === 403) {
          return json({ error: "رفضت Hugging Face المفتاح أو صلاحياته. تأكد أن HF_TOKEN من نوع User Access Token وبصلاحية Inference Providers." }, 502);
        }
        if (upstream.status === 429) {
          return json({ error: "وصلت خدمة الترجمة إلى حد الاستخدام أو لا يتوفر رصيد كافٍ. راجع حدود الاستخدام في Hugging Face." }, 503);
        }
        if (upstream.status === 400 || upstream.status === 404 || upstream.status === 422) {
          return json({ error: "نموذج الترجمة أو إعداد الطلب غير متاح حاليًا. جاري ضبط الاتصال." }, 502);
        }
        return json({ error: "خدمة Hugging Face لم تستجب بشكل سليم. حاول مرة أخرى بعد قليل." }, 502);
      }

      const translated = data?.choices?.[0]?.message?.content;
      if (typeof translated !== "string" || !translated.trim()) {
        console.error("HF translation returned an empty completion", { model: HF_MODEL });
        return json({ error: "لم تُرجع خدمة الترجمة نتيجة واضحة. جرّب وصفًا أبسط." }, 502);
      }

      const cleanTranslation = translated.trim()
        .replace(/^\`\`\`(?:[a-zA-Z]+)?\s*/, "")
        .replace(/\s*\`\`\`$/, "")
        .replace(/^["“”']|["“”']$/g, "")
        .trim();

      if (!cleanTranslation) return json({ error: "لم نتمكن من استخراج الترجمة. حاول بصياغة أخرى." }, 502);
      return json({ translation: cleanTranslation });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      return json({ error: "استغرقت الترجمة وقتًا أطول من المتوقع. حاول مرة أخرى." }, 504);
    }
    console.error("HF translation function failure", { name: error?.name || "Error" });
    return json({ error: "حدثت مشكلة داخل خدمة الترجمة. حاول مرة أخرى." }, 502);
  }
}
