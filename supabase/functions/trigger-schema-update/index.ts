// Edge Function : déclenche le workflow GitHub Actions de génération des tuiles.
//
// Le PAT GitHub vit dans un secret Supabase (GITHUB_TOKEN) et n'est JAMAIS
// exposé au client. Le navigateur appelle cette fonction (avec la clé anon
// Supabase) au lieu d'appeler directement l'API GitHub.
//
// Secrets attendus (supabase secrets set ...):
//   GITHUB_TOKEN  : PAT fine-grained, permission "actions: write" sur le repo
//   GITHUB_REPO   : optionnel, défaut "JulianV87/schema-eic"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = Deno.env.get("GITHUB_TOKEN");
  const repo = Deno.env.get("GITHUB_REPO") ?? "JulianV87/schema-eic";
  if (!token) return json({ error: "GITHUB_TOKEN non configuré côté serveur" }, 500);

  let ghResp: Response;
  try {
    ghResp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "schema-eic-edge",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: "update-schema" }),
    });
  } catch (e) {
    return json({ error: "Appel GitHub échoué", detail: String(e) }, 502);
  }

  if (!ghResp.ok && ghResp.status !== 204) {
    const detail = await ghResp.text();
    return json({ error: `GitHub HTTP ${ghResp.status}`, detail }, 502);
  }

  return json({ ok: true }, 200);
});
