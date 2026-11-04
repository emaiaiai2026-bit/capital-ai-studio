const MAX_PROMPT_LENGTH = 3000;
const HF_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";
// Listed by Hugging Face as a recommended chat-completion model.
const HF_MODEL = "openai/gpt-oss-120b:fastest";

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

    const diagnostic = body?.diagnostic === true;
    const token = env?.HF_TOKEN;
    if (typeof token !== "string" || !token.trim()) {
      return json({ error: "إعداد خدمة الترجمة غير مكتمل. راجع سر HF_TOKEN في Cloudflare.", ...(diagnostic ? { diagnostic: { stage: "cloudflare-secret", tokenConfigured: false } } : {}) }, 503);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50000);

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
          ]
        }),
        signal: controller.signal
      });

      const raw = await upstream.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { /* invalid provider response */ }

      // Provider error text is exposed only to the explicit diagnostic button.
      // Remove the secret and test prompt before returning any provider message.
      const providerErrorValue = data?.error ?? data?.message ?? data?.detail ?? "";
      let safeProviderMessage = typeof providerErrorValue === "string"
        ? providerErrorValue
        : JSON.stringify(providerErrorValue);
      safeProviderMessage = String(safeProviderMessage || "No provider error message returned")
        .replaceAll(token, "[REDACTED_TOKEN]")
        .replaceAll(sourceText, "[REDACTED_PROMPT]")
        .replace(/[\\r\\n\\t]+/g, " ")
        .slice(0, 350);

      if (!upstream.ok) {
        console.error("HF translation provider error", {
          status: upstream.status,
          model: HF_MODEL
        });

        if (upstream.status === 401 || upstream.status === 403) {
          return json({ error: "رفضت Hugging Face المفتاح أو صلاحياته. تأكد أن HF_TOKEN من نوع User Access Token وبصلاحية Inference Providers.", ...(diagnostic ? { diagnostic: { stage: "huggingface", upstreamStatus: upstream.status, model: HF_MODEL, providerMessage: safeProviderMessage } } : {}) }, 502);
        }
        if (upstream.status === 429) {
          return json({ error: "وصلت خدمة الترجمة إلى حد الاستخدام أو لا يتوفر رصيد كافٍ. راجع حدود الاستخدام في Hugging Face.", ...(diagnostic ? { diagnostic: { stage: "huggingface", upstreamStatus: upstream.status, model: HF_MODEL } } : {}) }, 503);
        }
        if (upstream.status === 400) {
          return json({ error: "رفض مزود الترجمة صيغة الطلب (400).", ...(diagnostic ? { diagnostic: { stage: "huggingface", upstreamStatus: upstream.status, model: HF_MODEL, providerMessage: safeProviderMessage } } : {}) }, 502);
        }
        if (upstream.status === 404) {
          return json({ error: "نموذج الترجمة غير متاح لدى مزود Hugging Face حاليًا (404).", ...(diagnostic ? { diagnostic: { stage: "huggingface", upstreamStatus: upstream.status, model: HF_MODEL } } : {}) }, 502);
        }
        if (upstream.status === 422) {
          return json({ error: "مزود Hugging Face رفض إعدادات النموذج (422).", ...(diagnostic ? { diagnostic: { stage: "huggingface", upstreamStatus: upstream.status, model: HF_MODEL } } : {}) }, 502);
        }
        return json({ error: "خدمة Hugging Face لم تستجب بشكل سليم. حاول مرة أخرى بعد قليل.", ...(diagnostic ? { diagnostic: { stage: "huggingface", upstreamStatus: upstream.status, model: HF_MODEL } } : {}) }, 502);
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
      return json({ translation: cleanTranslation, ...(diagnostic ? { diagnostic: { stage: "huggingface", upstreamStatus: upstream.status, model: HF_MODEL } } : {}) });
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
