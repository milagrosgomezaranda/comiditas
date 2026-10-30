import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://milagrosgomezaranda.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const email = Deno.env.get("COMIDITAS_LOGIN_EMAIL");
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!email || !url || !anon) return json({ error: "Configuración de acceso incompleta" }, 500);

    const { action, password } = await req.json();
    const client = createClient(url, anon, { auth: { persistSession: false } });

    if (action === "login") {
      if (typeof password !== "string" || password.length < 6) return json({ error: "Contraseña inválida" }, 400);
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data.session) return json({ error: "Contraseña incorrecta" }, 401);
      return json({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
      });
    }

    if (action === "reset") {
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: "https://milagrosgomezaranda.github.io/comiditas/",
      });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Acción inválida" }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: "No se pudo completar la solicitud" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
