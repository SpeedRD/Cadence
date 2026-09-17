import { getSettings, requireAuth } from "@/lib/auth";
import { today } from "@/lib/date";
import { buildExportArchive, exportArchiveName } from "@/lib/data/export";
import { isLocale } from "@/lib/i18n";

/**
 * Settings > Export data > "Export all": a ZIP of one CSV per data type -
 * see src/lib/data/export.ts. Session-gated like every page (the proxy
 * redirects a logged-out request to /login before this runs; requireAuth is
 * the server-side check behind it). Read-only: it never writes anything.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";

  const archive = await buildExportArchive(locale);
  return new Response(new Uint8Array(archive), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${exportArchiveName(today())}"`,
      "Content-Length": String(archive.length),
      "Cache-Control": "no-store",
    },
  });
}
