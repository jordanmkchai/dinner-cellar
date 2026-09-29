import superjson from "superjson";

export async function handle(_request: Request) {
  return new Response(superjson.stringify({ message: "Public registration is disabled" }), {
    status: 403,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

