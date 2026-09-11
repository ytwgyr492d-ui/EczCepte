const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=UTF-8"
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (request.method !== "GET") {
      return json({
        success: false,
        message: "Sadece GET istekleri kabul edilir."
      }, 405);
    }

    const url = new URL(request.url);

    const il = url.searchParams.get("il")?.trim();
    const ilce = url.searchParams.get("ilce")?.trim();

    if (!il || !ilce) {
      return json({
        success: false,
        message: "İl ve ilçe bilgisi zorunludur.",
        example: "/?il=Kahramanmaraş&ilce=Dulkadiroğlu"
      }, 400);
    }

    // Secret Cloudflare Worker ortamından okunuyor.
    const apiKey = env.COLLECTAPI_KEY;

    if (!apiKey) {
      return json({
        success: false,
        message: "COLLECTAPI_KEY secret bulunamadı."
      }, 500);
    }

    try {
      const apiUrl =
        "https://api.collectapi.com/health/dutyPharmacy" +
        "?il=" + encodeURIComponent(il) +
        "&ilce=" + encodeURIComponent(ilce);

      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          "authorization": "apikey " + apiKey,
          "content-type": "application/json"
        }
      });

      const text = await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        data = {
          success: false,
          message: "CollectAPI geçersiz bir yanıt döndürdü.",
          raw: text
        };
      }

      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: CORS_HEADERS
      });

    } catch (error) {
      return json({
        success: false,
        message: "CollectAPI bağlantı hatası.",
        error: error?.message || String(error)
      }, 502);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}
