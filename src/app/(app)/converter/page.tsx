import { CardConverter } from "@/components/converter/card-converter";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { loadConverter } from "@/lib/data/card-rate";
import { getAppContext } from "@/lib/data/context";
import { getDictionary } from "@/lib/i18n";

export const metadata = { title: "Converter - Cadence" };

/**
 * A calculator only: nothing on this page writes. The card's rate is learned
 * from the user's own bank figures (src/lib/card-rate.ts) on every load.
 */
export default async function ConverterPage() {
  const [context, data] = await Promise.all([getAppContext(), loadConverter()]);
  const t = getDictionary(context.language).converter;

  return (
    <div className="space-y-5">
      <PageHeader title={t.title} description={t.description} />
      {data.rates ? (
        <CardConverter data={data} locale={context.language} />
      ) : (
        <EmptyState title={t.noRatesTitle} description={t.noRatesDescription} />
      )}
    </div>
  );
}
