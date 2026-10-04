export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Same rule as a Windows NetBIOS computer name, with some slack on length.
export const BOOTH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
