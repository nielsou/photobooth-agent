import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json } from "../lib/http.js";
import { BOOTH_TYPES, TYPE_NOTES, PRINTER_ALERTS, qrPng } from "../lib/printer-alerts.js";

// GET /api/printer-alerts
// Authorization: Bearer <DASHBOARD_TOKEN>
// Read-only view of the printer alert popups per booth type, for the
// dashboard's Configuration tab (same data the agents receive).
export async function GET(request) {
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  const types = await Promise.all(
    BOOTH_TYPES.map(async (type) => ({
      type,
      note: TYPE_NOTES[type] || null,
      alerts: await Promise.all(
        (PRINTER_ALERTS[type] || []).map(async (alert) => {
          const png = await qrPng(alert.url);
          return { ...alert, qrDataUrl: png ? `data:image/png;base64,${png}` : null };
        }),
      ),
    })),
  );

  return json({ types });
}
